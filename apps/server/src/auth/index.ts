import { randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { hashPassword } from 'better-auth/crypto'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import type { Role } from '../../../../packages/security/src/index.ts'

export function createAuth(pool: DatabasePool, origin: string, secret: string, cookiePrefix?: string) {
  if (cookiePrefix !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(cookiePrefix)) {
    throw Error('AUTH_COOKIE_PREFIX must contain 1–32 ASCII letters, digits, underscores or hyphens')
  }
  return betterAuth({
    database: pool,
    baseURL: origin,
    secret,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    advanced: {
      ...(cookiePrefix === undefined ? {} : { cookiePrefix }),
      database: { generateId: () => randomUUID() },
      useSecureCookies: true,
      ipAddress: { ipAddressHeaders: ['x-skyscrape-client-ip'] },
    },
    logger: { disabled: true },
    session: { cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true, window: 60, max: 40,
      customRules: { '/sign-in/email': { window: 60, max: 6 } },
    },
    databaseHooks: {
      session: {
        create: { after: async session => {
          await pool.query("INSERT INTO audit_events(actor_id,action) VALUES($1,'session.login')", [session.userId])
        } },
        delete: { after: async session => {
          await pool.query("INSERT INTO audit_events(actor_id,action) VALUES($1,'session.logout')", [session.userId])
        } },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

export async function createUser(
  client: Pick<DatabasePool, 'query'>,
  email: string,
  password: string,
  role: Role,
) {
  const id = randomUUID()
  const digest = await hashPassword(password)
  await client.query('INSERT INTO "user"(id,name,email,role) VALUES($1,$2,$2,$3)', [id, email, role])
  await client.query(
    `INSERT INTO account(id,"userId","accountId","providerId",password) VALUES($1,$2::uuid,($2::uuid)::text,'credential',$3)`,
    [randomUUID(), id, digest],
  )
  return id
}

export { hashPassword }
