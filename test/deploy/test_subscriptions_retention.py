import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('retention', Path(__file__).resolve().parents[2] / 'deploy/subscriptions-retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class FakeDocker:
    def __init__(self):
        self.images = {f'vm2api-subscriptions:release-{i}': {'id': f'sha256:{i:064x}', 'revision': f'{i:040x}'} for i in range(7)}
        self.images['other-service:old'] = {'id': 'unrelated', 'revision': None}
        self.active = [{'Name': '/vm2api', 'image_ref': 'vm2api-subscriptions:release-6',
                        'Image': self.images['vm2api-subscriptions:release-6']['id'], 'State': {'Running': True}},
                       {'Name': '/other', 'image_ref': 'other-service:old', 'Image': 'unrelated', 'State': {'Running': True}}]
        self.verified = []

    def containers(self):
        return self.active

    def image(self, ref):
        if ref not in self.images:
            raise ValueError('missing image')
        return self.images[ref]

    def managed_images(self):
        return [{'ref': ref, 'id': meta['id']} for ref, meta in self.images.items() if ref.startswith('vm2api-subscriptions:')]

    def managed_build_images(self):
        return []

    def verify(self, revision):
        self.verified.append(revision)

    def remove_image(self, ref):
        assert self.images[ref]['id'] not in {c['Image'] for c in self.active}
        del self.images[ref]


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.docker = FakeDocker()
        for name in ('backups', 'releases', 'data', 'vms', 'deploy', 'validation', 'body170-check'):
            (self.root / name).mkdir()
        for name in ('docker-compose.yml', '.env', 'data/kin.db', 'vms/Claude.json', 'login-credentials.txt'):
            (self.root / name).write_text('live data must survive')
        for name in ('subscriptions-old.bundle', 'subscriptions-old.tar.gz', 'subscriptions-old.tar.gz.revision'):
            (self.root / name).write_text('obsolete archive')
        for i in range(7):
            release = self.root / 'releases' / f'subscriptions-{i}'
            release.mkdir()
            (release / 'CUSTOM_REVISION').write_text(f'{i:040x}')
        for i in range(1, 7):
            backup = self.root / 'backups' / f'202610{i:02d}T000000Z'
            (backup / 'stopped-data').mkdir(parents=True)
            for name in ('kin.db', 'stopped-data/kin.db', 'docker-compose.yml', '.env', 'config.tar.gz', 'vms.tar.gz'):
                (backup / name).write_text('backup content')
            (backup / 'previous-image.txt').write_text(f'vm2api-subscriptions:release-{i - 1}')
            (backup / 'migration-check.json').write_text(json.dumps({'ok': True}))
        (self.root / 'backups' / 'before-turnstile-20260901T000000Z').mkdir()

    def plan(self):
        return retention.build_plan(self.root, self.docker,
                                    str(self.root / 'releases/subscriptions-6'), 'vm2api-subscriptions:release-6')

    def test_keep_three_recoverable_backups_and_all_dependencies(self):
        plan = self.plan()
        self.assertEqual([Path(p).name for p in plan['keep_backups']],
                         ['20261006T000000Z', '20261005T000000Z', '20261004T000000Z'])
        self.assertEqual({Path(p).name for p in plan['keep_releases']}, {f'subscriptions-{i}' for i in range(3, 7)})
        self.assertTrue(self.docker.verified)
        retention.apply_plan(plan, self.docker, mounts=[])
        self.assertEqual(len(list((self.root / 'backups').iterdir())), 3)
        self.assertEqual(len(list((self.root / 'releases').iterdir())), 4)
        self.assertEqual(len(self.docker.images), 5)
        for name in ('.env', 'data/kin.db', 'vms/Claude.json', 'login-credentials.txt'):
            self.assertEqual((self.root / name).read_text(), 'live data must survive')
        for key in ('delete_backups', 'delete_releases', 'delete_archives', 'delete_images'):
            self.assertEqual(self.plan()[key], [])

    def test_recent_incomplete_backup_blocks_all_cleanup(self):
        (self.root / 'backups/20261006T000000Z/stopped-data/kin.db').unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.plan()
        self.assertTrue((self.root / 'backups/20261001T000000Z').exists())

    def test_missing_rollback_image_or_source_blocks_all_cleanup(self):
        self.docker.images.pop('vm2api-subscriptions:release-5')
        with self.assertRaisesRegex(ValueError, 'missing image'):
            self.plan()
        self.docker = FakeDocker()
        (self.root / 'releases/subscriptions-5/CUSTOM_REVISION').write_text('unknown')
        with self.assertRaisesRegex(ValueError, 'Source directories'):
            self.plan()

    def test_symlinks_traversal_and_mounts_are_rejected_before_deletion(self):
        with self.assertRaises(ValueError):
            retention.contained(self.root, self.root / 'backups/../data')
        bad = self.root / 'backups/20260901T000000Z'
        bad.symlink_to(self.root / 'data', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.plan()
        bad.unlink()
        plan = self.plan()
        mount = Path(plan['delete_backups'][-1]) / 'mounted'
        with self.assertRaisesRegex(ValueError, 'Mounted'):
            retention.apply_plan(plan, self.docker, mounts=[mount])
        self.assertTrue(Path(plan['delete_backups'][0]).exists())
        with self.assertRaises(ValueError):
            retention.safe_remove(self.root, self.root / 'data', [])

    def test_other_container_using_old_managed_image_keeps_its_source(self):
        self.docker.active.append({'Name': '/second', 'Image': self.docker.images['vm2api-subscriptions:release-0']['id'],
                                   'image_ref': 'vm2api-subscriptions:release-0', 'State': {'Running': False}})
        plan = self.plan()
        self.assertNotIn('vm2api-subscriptions:release-0', plan['delete_images'])
        self.assertIn(str(self.root / 'releases/subscriptions-0'), plan['keep_releases'])

    def test_wrong_running_release_and_concurrent_execution_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'does not match'):
            retention.build_plan(self.root, self.docker, expected_image='wrong-image')
        with retention.release_lock(self.root):
            with self.assertRaises(BlockingIOError):
                with retention.release_lock(self.root):
                    self.fail('second cleanup acquired the lock')

    def test_container_bind_mount_blocks_deletion_before_any_changes(self):
        plan = self.plan()
        self.docker.active[1]['bind_sources'] = [str(self.root / 'releases/subscriptions-0/src')]
        with self.assertRaisesRegex(ValueError, 'Mounted'):
            retention.apply_plan(plan, self.docker, mounts=[])
        self.assertTrue(Path(plan['delete_backups'][0]).exists())

    def test_inherited_release_lock_is_not_released_by_cleanup(self):
        lock_path = self.root / 'deploy/.release.lock'
        with lock_path.open('a') as descriptor:
            retention.fcntl.flock(descriptor, retention.fcntl.LOCK_EX)
            with retention.release_lock(self.root, descriptor.fileno()):
                pass
            with self.assertRaises(BlockingIOError):
                with retention.release_lock(self.root):
                    self.fail('cleanup released the parent deployment lock')

    def test_build_cache_identity_does_not_match_other_projects(self):
        self.assertTrue(retention.project_image_marker('/build/web', '{"name":"vm2api-web"}'))
        self.assertTrue(retention.project_image_marker('/opt/vm2api', '{"name":"vm2api"}'))
        self.assertTrue(retention.project_image_marker('/build/worker', 'module github.com/dofastted/kin-gateway/worker\n'))
        self.assertTrue(retention.project_image_marker('/build', '{"repo":"dofastted/vm2api"}'))
        for workdir, content in [('/build/web', '{"name":"other-app"}'), ('/build', '{"repo":"someone/other"}'),
                                  ('/build/worker', 'module other/project'), ('/other', '{"name":"vm2api"}'),
                                  ('/build/web', 'not json')]:
            self.assertFalse(retention.project_image_marker(workdir, content))


if __name__ == '__main__':
    unittest.main()
