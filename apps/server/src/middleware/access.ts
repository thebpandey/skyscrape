import { timingSafeEqual } from 'node:crypto'
import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Auth } from '../auth/index.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { can, roleScopes, tokenDigest } from '../../../../packages/security/src/index.ts'
import type { Principal, Role, Scope } from '../../../../packages/security/src/index.ts'
import { fail } from './errors.ts'

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null }
  interface FastifyInstance { requireScope: (scope: Scope) => Guard; requireAdmin: Guard }
}

export function principalOf(req: FastifyRequest) {
  return req.principal ?? fail(401, 'UNAUTHORIZED', 'Sign in required')
}

export function registerAccess(app: FastifyInstance, pool: DatabasePool, auth: Auth, origin: string, pepper: string) {
  app.decorateRequest('principal', null)
  app.decorate('requireScope', (scope: Scope): Guard => async req => {
    if (!can(principalOf(req), scope)) fail(403, 'FORBIDDEN', 'Scope required')
  })
  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    const principal = principalOf(req)
    if (principal.kind !== 'session' || principal.role !== 'admin') {
      fail(403, 'FORBIDDEN', 'Admin session required')
    }
  })
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Request-Id', req.id)
    const path = req.routeOptions.url
    const versioned = path?.startsWith('/api/v1/')
    const authorization = req.headers.authorization
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      fail(403, 'ORIGIN_DENIED', 'Origin denied')
    }
    if (!['HEAD', 'GET', 'OPTIONS'].includes(req.method) && (!versioned || !authorization)
        && req.headers.origin !== origin) {
      fail(403, 'ORIGIN_DENIED', 'Origin required')
    }
    if (!versioned) return
    if (authorization !== undefined) {
      req.principal = await authorizeKey(pool, authorization, pepper)
      return
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) fail(401, 'UNAUTHORIZED', 'Sign in required')
    const { rows: [user] } = await pool.query<{ id: string; role: Role }>(
      'SELECT id,role FROM "user" WHERE id=$1', [session.user.id],
    )
    if (!user) fail(401, 'UNAUTHORIZED', 'Sign in required')
    req.principal = { ...user, kind: 'session', scopes: roleScopes(user.role) }
  })
}

async function authorizeKey(pool: DatabasePool, authorization: string, pepper: string): Promise<Principal> {
  const match = /^Bearer (sky_([a-f0-9]{16})_[A-Za-z0-9_-]{43})$/i.exec(authorization)
  if (!match) fail(401, 'UNAUTHORIZED', 'Invalid credentials')
  const { rows: [key] } = await pool.query<{ id: string; digest: Buffer }>(
    'SELECT id,digest FROM api_keys WHERE prefix=$1', [match[2]],
  )
  if (!key || !timingSafeEqual(tokenDigest(match[1], pepper), key.digest)) {
    fail(401, 'UNAUTHORIZED', 'Invalid credentials')
  }
  const { rows: [authorized] } = await pool.query<{ id: string; role: Role; scopes: Scope[] }>(`
    UPDATE api_keys key SET last_used=now(), usage_date=current_date,
      usage_count=CASE WHEN key.usage_date=current_date THEN key.usage_count+1 ELSE 1 END
    FROM "user" owner WHERE key.id=$1 AND key.owner_id=owner.id
    AND key.revoked_at IS NULL AND key.expires_at>now()
    AND (key.usage_date IS DISTINCT FROM current_date OR key.usage_count<key.daily_quota)
    RETURNING owner.id,owner.role,key.scopes
  `, [key.id])
  if (!authorized) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM api_keys WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()', [key.id],
    )
    if (rowCount) fail(429, 'RATE_LIMITED', 'Key quota exhausted')
    fail(401, 'UNAUTHORIZED', 'Key unavailable')
  }
  return {
    ...authorized, kind: 'key',
    scopes: authorized.scopes.filter(scope => roleScopes(authorized.role).includes(scope)),
  }
}
