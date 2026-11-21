import { randomUUID } from 'node:crypto'
import { fromNodeHeaders } from 'better-auth/node'
import swagger from '@fastify/swagger'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import Fastify, { LogController } from 'fastify'
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  envelope, envelopeSchema, evidenceProjection, idParams, loginEmail, recordProjection, recordsQuery,
} from '../../../packages/contracts/src/index.ts'
import { credentialProvisioningLock, openDatabase, transaction } from '../../../packages/db/src/index.ts'
import type { DatabasePool } from '../../../packages/db/src/index.ts'
import { readEvidence, readPermits } from '../../../packages/db/src/permits.ts'
import { roles, scopes } from '../../../packages/security/src/index.ts'
import { logger } from '../../../packages/shared/src/index.ts'
import { createAuth } from './auth/index.ts'
import { authenticatedOf, principalOf, registerAccess } from './middleware/access.ts'
import { fail, registerErrors } from './middleware/errors.ts'
import { ChatGPT } from './chatgpt/provider.ts'
import { hostStore } from './chatgpt/store.ts'
import { registerChatGPT } from './routes/chatgpt-settings.ts'
import { registerAdminAuth } from './routes/admin-auth.ts'
import { registerCampaigns } from './routes/campaigns.ts'
import { registerRuns } from './routes/runs.ts'

export function buildApp({
  pool, authPool, adminPool, origin, authSecret, authCookiePrefix, keyPepper, masterKey, masterKeyVersion = 1, chatgpt,
}: {
  pool: DatabasePool
  authPool: DatabasePool
  adminPool: DatabasePool
  origin: string
  authSecret: string
  authCookiePrefix?: string
  keyPepper: string
  masterKey: Buffer
  chatgpt?: { owner: string; dir: string; port: number }
  masterKeyVersion?: number
}) {
  const publicUrl = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
  if (publicUrl.origin !== origin || (publicUrl.protocol !== 'https:' && !(loopback && publicUrl.protocol === 'http:'))) {
    throw Error('Set APP_ORIGIN to an HTTPS origin or a loopback HTTP origin')
  }
  if (authSecret.length < 32 || keyPepper.length < 32 || masterKey.length !== 32
      || !Number.isSafeInteger(masterKeyVersion) || masterKeyVersion < 1 || masterKeyVersion > 2147483647) {
    throw Error('Set application secrets and a valid key version')
  }

  const auth = createAuth(authPool, origin, authSecret, authCookiePrefix)
  const loggerInstance: FastifyBaseLogger = logger
  const app = Fastify({
    loggerInstance,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.addHook('onReady', async () => {
    const connections: [DatabasePool, string][] = [
      [pool, 'skyscrape_runtime'], [authPool, 'skyscrape_auth'], [adminPool, 'skyscrape_admin'],
    ]
    await Promise.all(connections.map(async ([connection, expected]) => {
      const { rows: [database] } = await connection.query<{ role: string }>('SELECT current_user AS role')
      if (database.role !== expected) throw Error(`Expected database role ${expected}`)
    }))
  })
  if (chatgpt && (!z.uuid().safeParse(chatgpt.owner).success || !chatgpt.dir.startsWith('/')
      || !Number.isInteger(chatgpt.port) || chatgpt.port < 1 || chatgpt.port > 65535)) {
    throw Error('Configure the ChatGPT owner UUID, absolute storage directory and callback port')
  }
  const provider = chatgpt && new ChatGPT(hostStore(pool, chatgpt.dir, chatgpt.owner, masterKey, masterKeyVersion), origin, chatgpt.port)
  app.addHook('onClose', async () => { provider?.close() })
  registerErrors(app)
  registerAccess(app, authPool, auth, origin, keyPepper)
  app.register(swagger, {
    openapi: { openapi: '3.1.0', info: { title: 'Skyscrape API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
  })

  app.after(() => {
    const routes = app.withTypeProvider<ZodTypeProvider>()

    async function handleAuth(req: FastifyRequest, reply: FastifyReply, email?: string) {
      const passwordBefore = email === undefined ? undefined : (
        await authPool.query<{ id: string; password_revision: number }>(`
          SELECT account.id, account.password_revision FROM account
          JOIN "user" owner ON owner.id=account."userId"
          WHERE owner.email=$1 AND account."providerId"='credential'
        `, [email.toLowerCase()])
      ).rows[0]
      const headers = fromNodeHeaders(req.headers)
      headers.set('x-skyscrape-client-ip', req.ip)
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      const result = await auth.handler(new Request(origin + req.routeOptions.url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }))
      if (!result.ok) {
        if (result.status === 429) {
          const retryAfter = result.headers.get('retry-after')
          if (retryAfter) reply.header('Retry-After', retryAfter)
          fail(429, 'RATE_LIMITED', 'Try again later')
        }
        if (result.status < 500) fail(401, 'UNAUTHORIZED', 'Sign-in or sign-out failed')
        fail(502, 'AUTH_UNAVAILABLE', 'Authentication unavailable')
      }
      if (email !== undefined) {
        const { token } = z.object({ token: z.string() }).parse(await result.json())
        const sessionIsCurrent = await transaction(authPool, async client => {
          // Read the password revision after any in-progress reset commits.
          await client.query('SELECT pg_advisory_xact_lock_shared($1)', [credentialProvisioningLock])
          const { rowCount } = await client.query(`
            SELECT 1 FROM account
            JOIN session ON session."userId"=account."userId"
            WHERE account.id=$1 AND account.password_revision=$2 AND session.token=$3
          `, [passwordBefore?.id, passwordBefore?.password_revision, token])
          if (!rowCount) await client.query('DELETE FROM session WHERE token=$1', [token])
          return Boolean(rowCount)
        })
        if (!sessionIsCurrent) fail(401, 'UNAUTHORIZED', 'Sign-in or sign-out failed')
      }
      const cookies = result.headers.getSetCookie()
      if (cookies.length) reply.header('Set-Cookie', cookies)
      return reply.code(204).send()
    }

    routes.post('/api/auth/sign-in/email', {
      schema: { hide: true, body: z.strictObject({
        email: loginEmail,
        password: z.string().min(1).max(128),
        rememberMe: z.boolean().optional(),
      }) },
    }, (req, reply) => handleAuth(req, reply, req.body.email))
    routes.post('/api/auth/sign-out', { schema: { hide: true } }, (req, reply) => handleAuth(req, reply))

    routes.get('/api/v1/me', {
      schema: { response: { 200: envelopeSchema(z.strictObject({
        chatgptSettings: z.literal(true).optional(), id: z.uuid(), role: z.enum(roles), kind: z.enum(['session', 'key']), scopes: z.array(z.enum(scopes)),
      })) } },
    }, req => {
      const principal = principalOf(req)
      return envelope({ ...principal, ...(chatgpt?.owner === principal.id && principal.kind === 'session' ? { chatgptSettings: true as const } : {}), scopes: [...principal.scopes] }, req.id)
    })

    routes.get('/api/v1/records', {
      preHandler: app.requireScope('records:read'),
      schema: {
        querystring: recordsQuery,
        response: { 200: envelopeSchema(z.array(recordProjection)) },
      },
    }, async req => {
      const { cursor, ...filter } = req.query
      let after: string | undefined
      if (cursor) {
        const parsed = z.uuid().safeParse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!parsed.success) fail(400, 'INVALID_CURSOR', 'Invalid cursor')
        after = parsed.data
      }
      const records = await readPermits(pool, authenticatedOf(req), { ...filter, after, limit: filter.limit + 1 })
      const page = records.slice(0, filter.limit)
      const last = page.at(-1)
      const nextCursor = records.length > filter.limit && last ? Buffer.from(last.id).toString('base64url') : undefined
      return envelope(page, req.id, nextCursor)
    })

    routes.get('/api/v1/records/:id', {
      preHandler: app.requireScope('records:read'),
      schema: { params: idParams, response: { 200: envelopeSchema(recordProjection) } },
    }, async req => {
      const [record] = await readPermits(pool, authenticatedOf(req), { id: req.params.id, limit: 1 })
      if (!record) fail(404, 'NOT_FOUND', 'Record not found')
      return envelope(record, req.id)
    })

    routes.get('/api/v1/evidence/:id', {
      preHandler: app.requireScope('evidence:read'),
      schema: { params: idParams, response: { 200: envelopeSchema(evidenceProjection) } },
    }, async req => {
      const evidence = await readEvidence(pool, principalOf(req), req.params.id)
      if (!evidence) fail(404, 'NOT_FOUND', 'Evidence not found')
      return envelope(evidence, req.id)
    })

    routes.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())
    registerChatGPT(app, chatgpt?.owner, provider)
    registerAdminAuth(app, { adminPool, keyPepper, masterKey, masterKeyVersion })
    registerCampaigns(app, pool)
    registerRuns(app, pool)
  })
  return app
}

if (import.meta.main) {
  const {
    DATABASE_URL, AUTH_DATABASE_URL, ADMIN_DATABASE_URL, APP_ORIGIN, AUTH_SECRET,
    API_KEY_PEPPER, MASTER_KEY, MASTER_KEY_VERSION,
  } = process.env
  if (!DATABASE_URL || !AUTH_DATABASE_URL || !ADMIN_DATABASE_URL) {
    throw Error('Set DATABASE_URL, AUTH_DATABASE_URL and ADMIN_DATABASE_URL')
  }
  if (!APP_ORIGIN || !AUTH_SECRET || !API_KEY_PEPPER || !MASTER_KEY) {
    throw Error('Set APP_ORIGIN, AUTH_SECRET, API_KEY_PEPPER and MASTER_KEY')
  }
  const origin = new URL(APP_ORIGIN)
  const port = Number(process.env.PORT ?? (origin.port || '3000'))
  const pool = openDatabase(DATABASE_URL)
  const authPool = openDatabase(AUTH_DATABASE_URL)
  const adminPool = openDatabase(ADMIN_DATABASE_URL)
  const app = buildApp({
    pool, authPool, adminPool, origin: APP_ORIGIN, authSecret: AUTH_SECRET, keyPepper: API_KEY_PEPPER,
    authCookiePrefix: process.env.AUTH_COOKIE_PREFIX,
    chatgpt: process.env.CHATGPT_OWNER_ID || process.env.CHATGPT_STATE_DIR ? {
      owner: process.env.CHATGPT_OWNER_ID ?? '', dir: process.env.CHATGPT_STATE_DIR ?? '',
      port: Number(process.env.CHATGPT_CALLBACK_PORT ?? 1455),
    } : undefined,
    masterKey: Buffer.from(MASTER_KEY, 'base64'), masterKeyVersion: Number(MASTER_KEY_VERSION ?? 1),
  })
  app.addHook('onClose', async () => {
    await Promise.all([pool.end(), authPool.end(), adminPool.end()])
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close() })
  }
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port })
}
