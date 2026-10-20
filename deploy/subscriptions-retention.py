#!/usr/bin/env python3
"""Keep three recoverable backups plus the images/source needed to restore them.

Dry-run by default. No Docker volume/container pruning, no live data deletion.
Run on the host after release verification, under the deployment lock.
"""
import argparse
import contextlib
from collections import deque
import datetime
import fcntl
import io
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tarfile

KEEP = 3
STAMP = re.compile(r"\d{8}T\d{6}Z")
BACKUP = re.compile(r"(?:before-turnstile-)?\d{8}T\d{6}Z")
REVISION = re.compile(r"[0-9a-f]{40}")
MANAGED = {"vm2api-subscriptions", "ghcr.io/dofastted/vm2api"}
ARCHIVE = re.compile(r"(?:subscriptions-[\w.-]+|custom-main-[\w.-]+|go-preflight-[\w.-]+|merge-[\w.-]+-tests)\.(?:bundle|tar\.gz)(?:\.revision)?")
BUILD_MARKERS = {'/build/web': '/build/web/package.json',
                 '/build/worker': '/build/worker/go.mod',
                 '/build/api-kernel': '/build/api-kernel/go.mod',
                 '/build': '/build/deploy/payload.json',
                 '/opt/vm2api': '/opt/vm2api/package.json'}


def project_image_marker(workdir, content):
    try:
        if workdir in ('/build/web', '/opt/vm2api'):
            return json.loads(content).get('name') == ('vm2api-web' if workdir == '/build/web' else 'vm2api')
        if workdir in ('/build/worker', '/build/api-kernel'):
            return content.splitlines()[0].strip() == 'module github.com/dofastted/kin-gateway/' + workdir.split('/')[-1]
        return workdir == '/build' and json.loads(content).get('repo') == 'dofastted/vm2api'
    except (ValueError, IndexError, AttributeError):
        return False


def owned_build_ancestors(graph, seeds, used):
    """Walk upwards only when every child is already an owned disposable cache.

    A tagged image, container or unrelated cache branch protects its ancestry.
    The returned order removes children before parents.
    """
    rows = {row['id']: row for row in graph}
    children = {}
    for row in graph:
        children.setdefault(row.get('parent'), set()).add(row['id'])
    queue, removed, order = deque(seeds), set(), []
    while queue:
        image_id = queue.popleft()
        row = rows.get(image_id)
        if not row or image_id in removed or image_id in used or row.get('tags'):
            continue
        if children.get(image_id, set()) - removed:
            continue
        removed.add(image_id)
        order.append(image_id)
        if row.get('parent'):
            queue.append(row['parent'])
    return order


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def contained(root, candidate):
    """Reject traversal and symlinked parents before even reading control files."""
    root, candidate = Path(root), Path(candidate)
    if not candidate.is_absolute() or '..' in candidate.parts:
        raise ValueError(f"Unsafe path: {candidate}")
    relative = candidate.relative_to(root)
    if not relative.parts:
        raise ValueError("Refusing to target the project root")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Symlink in managed path: {current}")
    if candidate.exists() and candidate.resolve() != candidate:
        raise ValueError(f"Unresolved managed path: {candidate}")
    return candidate


def read_control(root, candidate):
    candidate = contained(root, candidate)
    if not candidate.is_file() or candidate.stat().st_size > 2_000_000:
        raise ValueError(f"Invalid control file: {candidate}")
    return candidate.read_text().strip()


def valid_root(root):
    root = Path(root).absolute()
    if root.resolve() != root or root == Path('/'):
        raise ValueError("Project root must be a real, non-symlink directory")
    for name in ('backups', 'releases', 'data', 'vms', 'deploy'):
        if not contained(root, root / name).is_dir():
            raise ValueError(f"Missing project directory: {name}")
    read_control(root, root / 'docker-compose.yml')
    return root


@contextlib.contextmanager
def release_lock(root, inherited=None):
    lock_path = contained(root, root / 'deploy' / '.release.lock')
    if inherited is not None:
        actual, expected = os.fstat(inherited), lock_path.stat()
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError("Inherited lock does not belong to this project")
        fcntl.flock(inherited, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    else:
        with open(lock_path, 'a') as lock:
            os.chmod(lock_path, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)


class Docker:
    def image_graph(self, ids=None):
        endpoint = os.environ.get('DOCKER_HOST') if not os.environ.get('DOCKER_CONTEXT') else None
        endpoint = endpoint or json.loads(run('docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'))
        if not endpoint.startswith('unix://'):
            raise ValueError('Retention requires the local Docker Unix socket')
        # One read-only Engine listing supplies ParentId for every intermediate
        # layer; per-image inspect is prohibitively slow with old build history.
        connection = http.client.HTTPConnection('localhost', timeout=30)
        try:
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(30)
            connection.sock.connect(endpoint[len('unix://'):])
            connection.request('GET', '/images/json?all=1')
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError('Could not read Docker image dependency graph')
            images = json.loads(response.read())
        finally:
            connection.close()
        wanted = set(ids) if ids is not None else None
        return [{'id': row['Id'], 'parent': row.get('ParentId') or '', 'tags': row.get('RepoTags') or []}
                for row in images if wanted is None or row['Id'] in wanted]

    def remove_build_images(self, ids):
        removed = []
        for offset in range(0, len(ids), 256):
            metadata = {row['id']: row for row in self.image_graph()}
            used = {c['Image'] for c in self.containers()}
            batch = [i for i in ids[offset:offset + 256]
                     if i in metadata and i not in used and not metadata[i].get('tags')]
            if not batch:
                continue
            result = subprocess.run(['docker', 'image', 'rm', '--no-prune', *batch], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode and set(batch) & {row['id'] for row in self.image_graph()}:
                raise ValueError('Some cache layers still have dependencies; cleanup stopped safely')
            # A concurrent removal may yield 404 even though the layer is gone.
            removed.extend(batch)
        return removed

    def managed_build_images(self):
        used = {c['Image'] for c in self.containers()}
        candidates = run('docker', 'image', 'ls', '--filter', 'dangling=true', '--no-trunc', '-q').split()
        found = []
        for image_id in dict.fromkeys(candidates):
            if image_id in used:
                continue
            info = json.loads(run('docker', 'image', 'inspect', image_id))[0]
            workdir = info.get('Config', {}).get('WorkingDir')
            if info.get('RepoTags') or workdir not in BUILD_MARKERS:
                continue
            # Never execute cached images: copy a small identity file from an
            # unstarted temporary container, then remove that container.
            container = run('docker', 'create', '--network', 'none', '--label', 'org.vm2api.retention-probe=1',
                            '--entrypoint', '/bin/true', image_id)
            try:
                archive = subprocess.check_output(['docker', 'cp', container + ':' + BUILD_MARKERS[workdir], '-'], stderr=subprocess.PIPE)
                if len(archive) > 2_000_000:
                    continue
                with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                    members = [m for m in source.getmembers() if m.isfile()]
                    if len(members) == 1 and members[0].size < 1_000_000:
                        content = source.extractfile(members[0]).read().decode('utf-8')
                        if project_image_marker(workdir, content):
                            found.append(image_id)
            except (subprocess.CalledProcessError, ValueError, tarfile.TarError, UnicodeError):
                pass  # Unrecognized cache belongs outside this cleanup policy.
            finally:
                run('docker', 'rm', container)
        return owned_build_ancestors(self.image_graph(), found, used)

    def containers(self):
        ids = run('docker', 'ps', '-aq').split()
        if not ids:
            raise ValueError("No containers found")
        # Only retain non-secret identity fields from docker inspect.
        return [{k: row.get(k) for k in ('Id', 'Name', 'Image', 'State')} |
                {'image_ref': row['Config']['Image'],
                 'bind_sources': [m['Source'] for m in row.get('Mounts', []) if m.get('Type') == 'bind']}
                for row in json.loads(run('docker', 'inspect', *ids))]

    def image(self, ref):
        row = json.loads(run('docker', 'image', 'inspect', ref))[0]
        return {'id': row['Id'], 'tags': row.get('RepoTags') or [],
                'revision': (row.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')}

    def managed_images(self):
        rows = []
        for line in run('docker', 'image', 'ls', '--format', '{{json .}}', '--no-trunc').splitlines():
            row = json.loads(line)
            if row['Repository'] in MANAGED and row['Tag'] != '<none>':
                rows.append({'ref': row['Repository'] + ':' + row['Tag'], 'id': row['ID']})
        return rows

    def verify(self, revision):
        run('docker', 'exec', 'vm2api', 'node', 'scripts/verify-subscriptions-release.mjs', revision)
        run('docker', 'exec', 'vm2api', 'node', '--input-type=module', '-e',
            'const r=await fetch("http://127.0.0.1:8787/health",{signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1)')

    def remove_image(self, ref):
        # No force: Docker itself also rejects images required by containers.
        run('docker', 'image', 'rm', ref)


def recoverable(root, directory):
    required = ('kin.db', 'stopped-data/kin.db', 'previous-image.txt',
                'docker-compose.yml', '.env', 'config.tar.gz', 'vms.tar.gz', 'migration-check.json')
    for name in required:
        file = contained(root, directory / name)
        if not file.is_file() or file.stat().st_size == 0:
            return False
    return json.loads(read_control(root, directory / 'migration-check.json')).get('ok') is True


def build_plan(root, docker, active_release=None, expected_image=None):
    root = valid_root(root)
    containers = docker.containers()
    current = next((c for c in containers if c['Name'] == '/vm2api'), None)
    if not current or not current['State'].get('Running'):
        raise ValueError("vm2api must be running before retention")
    if expected_image and current['image_ref'] != expected_image:
        raise ValueError("Running image does not match the verified release")
    current_meta = docker.image(current['image_ref'])
    if not REVISION.fullmatch(current_meta.get('revision') or ''):
        raise ValueError("Running image has no valid release revision")
    docker.verify(current_meta['revision'])

    candidates = sorted((p for p in (root / 'backups').iterdir() if BACKUP.fullmatch(p.name)), reverse=True)
    for directory in candidates:
        if not contained(root, directory).is_dir():
            raise ValueError(f"Invalid backup path: {directory}")
    complete = [p for p in candidates if STAMP.fullmatch(p.name) and recoverable(root, p)]
    kept = complete[:KEEP]
    if len(kept) < KEEP:
        raise ValueError("Fewer than three recoverable backups; refusing cleanup")
    # Newer incomplete attempts remain until three newer recoverable backups exist.
    cutoff = kept[-1].name
    if any(STAMP.fullmatch(p.name) and p not in complete and p.name >= cutoff for p in candidates):
        raise ValueError("A recent incomplete backup needs review before cleanup")
    obsolete = [p for p in candidates if p not in kept and p.name[-16:] < cutoff]
    protected_ids = {c['Image'] for c in containers}
    protected_refs = {c['image_ref'] for c in containers}
    revisions = {current_meta['revision']}
    for container in containers:
        if container['image_ref'].rsplit(':', 1)[0] in MANAGED:
            revision = docker.image(container['image_ref']).get('revision')
            if not REVISION.fullmatch(revision or ''):
                raise ValueError("An active managed image has no source revision")
            revisions.add(revision)
    for backup in kept:
        ref = read_control(root, backup / 'previous-image.txt')
        if ref.rsplit(':', 1)[0] not in MANAGED or re.search(r'\s', ref):
            raise ValueError(f"Unrecognized rollback image in {backup.name}")
        image = docker.image(ref)  # A missing rollback image blocks all deletions.
        protected_refs.add(ref)
        protected_ids.add(image['id'])
        if not REVISION.fullmatch(image.get('revision') or ''):
            raise ValueError(f"Missing rollback revision for {backup.name}")
        revisions.add(image['revision'])
    releases, retained, found_revisions = [], [], set()
    for directory in sorted((root / 'releases').iterdir()):
        if not directory.name.startswith('subscriptions-'):
            continue
        if not contained(root, directory).is_dir():
            raise ValueError(f"Invalid release path: {directory}")
        revision_file = directory / 'CUSTOM_REVISION'
        revision = read_control(root, revision_file) if revision_file.exists() else ''
        if revision in revisions:
            retained.append(directory)
            found_revisions.add(revision)
        else:
            releases.append(directory)
    if not revisions.issubset(found_revisions):
        raise ValueError("Source directories for running/rollback images are missing")
    if active_release:
        active = contained(root, Path(active_release))
        if active not in retained:
            raise ValueError("Active release is not a verified retained source directory")
    archives = [contained(root, p) for p in root.iterdir() if ARCHIVE.fullmatch(p.name)]
    for name in ('validation', 'body170-check'):
        if (root / name).exists():
            archives.append(contained(root, root / name))
    images = [i['ref'] for i in docker.managed_images() if i['id'] not in protected_ids and i['ref'] not in protected_refs]
    return {'root': str(root), 'revision': current_meta['revision'], 'running_image': current['image_ref'],
            'keep_backups': [str(p) for p in kept], 'keep_releases': [str(p) for p in retained],
            'keep_images': sorted(protected_refs), 'delete_backups': [str(p) for p in obsolete],
            'delete_releases': [str(p) for p in releases], 'delete_archives': [str(p) for p in archives],
            'delete_images': sorted(images), 'delete_build_images': docker.managed_build_images()}


def mount_points():
    # Include bind mounts: os.path.ismount alone misses same-device bind mounts.
    return [Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4]))
            for line in Path('/proc/self/mountinfo').read_text().splitlines()]


def safe_remove(root, name, mounts):
    target = contained(root, Path(name))
    rel = target.relative_to(root)
    allowed = (len(rel.parts) == 2 and rel.parts[0] in ('backups', 'releases')) or (
        len(rel.parts) == 1 and (ARCHIVE.fullmatch(target.name) or target.name in ('validation', 'body170-check')))
    if not allowed or any(target == m or target in m.parents for m in mounts):
        raise ValueError(f"Unsafe removal target: {target}")
    if target.is_dir():
        if not shutil.rmtree.avoids_symlink_attacks:
            raise ValueError("This platform lacks safe recursive removal")
        shutil.rmtree(target)
    elif target.is_file():
        target.unlink()
    else:
        raise ValueError(f"Removal target changed: {target}")


def apply_plan(plan, docker, mounts=None):
    root = Path(plan['root'])
    mounts = mount_points() if mounts is None else mounts
    mounts = list(mounts) + [Path(source) for container in docker.containers()
                            for source in container.get('bind_sources', [])]
    targets = plan['delete_backups'] + plan['delete_releases'] + plan['delete_archives']
    # Validate every target before removing any; retained DBs stay untouched.
    for name in targets:
        target = contained(root, Path(name))
        if any(target == m or target in m.parents for m in mounts):
            raise ValueError(f"Mounted deletion target: {target}")
    for name in targets:
        safe_remove(root, name, mounts)
    for ref in plan['delete_images']:
        used = {c['Image'] for c in docker.containers()}
        if docker.image(ref)['id'] in used:
            raise ValueError(f"Image became active during cleanup: {ref}")
        docker.remove_image(ref)
    # Removing version tags can expose more untagged build intermediates.
    builds = docker.managed_build_images() if plan['delete_images'] else plan['delete_build_images']
    plan['removed_build_images'] = docker.remove_build_images(builds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/home/yibocho/vm2api')
    parser.add_argument('--active-release')
    parser.add_argument('--expected-image')
    parser.add_argument('--lock-fd', type=int)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = valid_root(args.root)
    with release_lock(root, args.lock_fd):
        docker = Docker()
        plan = build_plan(root, docker, args.active_release, args.expected_image)
        report = root / 'deploy' / ('retention-last.json' if args.apply else 'retention-plan.json')
        contained(root, report)
        report.write_text(json.dumps(plan, indent=2) + '\n')
        os.chmod(report, 0o600)
        if args.apply:
            apply_plan(plan, docker)
            plan['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            report.write_text(json.dumps(plan, indent=2) + '\n')
        print(json.dumps({'applied': args.apply, 'keep_backups': plan['keep_backups'],
                          'keep_releases': plan['keep_releases'], 'report': str(report),
                          **{key: len(plan[key]) for key in ('delete_backups', 'delete_releases', 'delete_archives', 'delete_images', 'delete_build_images')},
                          'removed_build_images': len(plan.get('removed_build_images', []))}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, http.client.HTTPException, subprocess.CalledProcessError) as error:
        # Do not dump captured Docker/credential output in failure logs.
        if isinstance(error, subprocess.CalledProcessError):
            print(f'Retention stopped: {" ".join(error.cmd[:3])} failed (exit {error.returncode})', file=sys.stderr)
        else:
            print(f'Retention stopped: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
