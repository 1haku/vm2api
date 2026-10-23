import { getDb, isDbOpen } from '../db/database.mjs'
import { ImagePermissionsRepo } from '../db/repos/image-permissions-repo.mjs'
import { canonicalImageToolModel, imageGenerationTools } from '../protocol/image-tool-models.mjs'

export function imagePermissionError(req, body, { force = false, db = null } = {}) {
  if (!force && !canonicalImageToolModel(body?.model) && imageGenerationTools(body).length === 0) return null
  // Authentication precedes this check. The master key is an administrator credential;
  // every managed key, including admin-owned keys, needs its user's explicit opt-in.
  if (!req.apiKeyRecord) return null
  const database = db || (isDbOpen() ? getDb() : null)
  if (database && new ImagePermissionsRepo(database).enabled(req.apiKeyRecord.user_id)) return null
  return { type: 'permission_error', code: 'image_generation_disabled', message: '该用户未开通生图权限，请联系管理员' }
}
