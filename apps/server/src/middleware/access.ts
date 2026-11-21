import { timingSafeEqual } from 'node:crypto'
import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Auth } from '../auth/index.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { can, roleScopes, tokenDigest } from '../../../../packages/security/src/index.ts'
import type { Authenticated, Role, Scope } from '../../../../packages/security/src/index.ts'
import { fail } from './errors.ts'

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>

declare module 'fastify' {
  interface FastifyRequest { authenticated: Authenticated | null }
  interface FastifyInstance { requireScope: (scope: Scope) => Guard; requireAdmin: Guard }
}

export function authenticatedOf(req: FastifyRequest) {
  return req.authenticated ?? fail(401, 'UNAUTHORIZED', 'Sign in required')
}

export function principalOf(req: FastifyRequest) {
  return authenticatedOf(req).principal
}

export function adminSessionId(req: FastifyRequest) {
  const { principal, proof } = authenticatedOf(req)
  if (principal.role !== 'admin' || proof.kind !== 'session') fail(403, 'FORBIDDEN', 'Admin session required')
  return proof.id
}

export function registerAccess(app: FastifyInstance, pool: DatabasePool, auth: Auth, origin: string, pepper: string) {
  app.decorateRequest('authenticated', null)
  app.decorate('requireScope', (scope: Scope): Guard => async req => {
    if (!can(principalOf(req), scope)) fail(403, 'FORBIDDEN', 'Scope required')
  })
  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    adminSessionId(req)
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
      req.authenticated = await authorizeKey(pool, authorization, pepper)
      return
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) fail(401, 'UNAUTHORIZED', 'Sign in required')
    const { rows: [user] } = await pool.query<{ id: string; role: Role }>(
      'SELECT id,role FROM "user" WHERE id=$1', [session.user.id],
    )
    if (!user) fail(401, 'UNAUTHORIZED', 'Sign in required')
    req.authenticated = {
      principal: { ...user, kind: 'session', scopes: roleScopes(user.role) },
      proof: { kind: 'session', id: session.session.id },
    }
  })
}

type KeyUse =
  | { owner_id: string; role: Role; scopes: Scope[]; limited: false }
  | { limited: true }

async function authorizeKey(pool: DatabasePool, authorization: string, pepper: string): Promise<Authenticated> {
  const match = /^Bearer (sky_([a-f0-9]{16})_[A-Za-z0-9_-]{43})$/i.exec(authorization)
  if (!match) fail(401, 'UNAUTHORIZED', 'Invalid credentials')
  const digest = tokenDigest(match[1], pepper)
  const { rows: [key] } = await pool.query<{ digest: Buffer }>(
    'SELECT digest FROM api_keys WHERE prefix=$1', [match[2]],
  )
  if (!key || !timingSafeEqual(digest, key.digest)) fail(401, 'UNAUTHORIZED', 'Invalid credentials')
  const { rows: [use] } = await pool.query<KeyUse>(
    'SELECT * FROM skyscrape_access.consume_key($1,$2)', [match[2], digest],
  )
  if (!use) fail(401, 'UNAUTHORIZED', 'Key unavailable')
  if (use.limited) fail(429, 'RATE_LIMITED', 'Key quota exhausted')
  return {
    principal: {
      id: use.owner_id, role: use.role, kind: 'key',
      scopes: use.scopes.filter(scope => roleScopes(use.role).includes(scope)),
    },
    proof: { kind: 'key', digest },
  }
}
