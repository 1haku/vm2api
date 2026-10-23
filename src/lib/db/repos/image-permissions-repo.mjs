export class ImagePermissionsRepo {
  constructor(db) {
    this.db = db
  }

  enabled(userId) {
    return (
      !!userId &&
      this.db.prepare('SELECT enabled FROM custom_user_image_permissions WHERE user_id=?').get(userId)?.enabled === 1
    )
  }

  save(userId, enabled) {
    if (typeof enabled !== 'boolean')
      throw Object.assign(new Error('生图权限必须是布尔值'), { code: 'invalid_image_permission', status: 400 })
    this.db
      .prepare(
        'INSERT INTO custom_user_image_permissions(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled',
      )
      .run(userId, enabled ? 1 : 0)
  }
}
