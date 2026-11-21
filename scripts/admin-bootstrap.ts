import { timingSafeEqual } from 'node:crypto'
import { loginEmail } from '../packages/contracts/src/index.ts'
import { credentialProvisioningLock, openDatabase, transaction } from '../packages/db/src/index.ts'
import type { DatabasePool } from '../packages/db/src/index.ts'
import { createUser, hashPassword } from '../apps/server/src/auth/index.ts'
import { tokenDigest } from '../packages/security/src/index.ts'

class BootstrapError extends Error {}

export async function bootstrap(pool: DatabasePool, mode: string, env: NodeJS.ProcessEnv) {
  const { BOOTSTRAP_TOKEN: token, API_KEY_PEPPER: pepper, ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = env
  if (!token || token.length < 32 || !pepper || pepper.length < 32) {
    throw new BootstrapError('Set a host-generated BOOTSTRAP_TOKEN and API_KEY_PEPPER (32+ characters each)')
  }
  if (!['issue', 'create', 'reset'].includes(mode)) throw new BootstrapError('Expected issue, create or reset')
  const digest = tokenDigest(token, pepper)

  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [credentialProvisioningLock])
    if (mode === 'issue') {
      await client.query(`
        INSERT INTO bootstrap_token(singleton,digest,expires_at) VALUES(true,$1,now()+interval '10 minutes')
        ON CONFLICT(singleton) DO UPDATE SET digest=excluded.digest,expires_at=excluded.expires_at
      `, [digest])
      await client.query("INSERT INTO audit_events(action) VALUES('bootstrap.issued')")
      return
    }

    const { rows: [ticket] } = await client.query<{ digest: Buffer }>(
      'DELETE FROM bootstrap_token WHERE expires_at>now() RETURNING digest',
    )
    if (!ticket || !timingSafeEqual(ticket.digest, digest)) throw new BootstrapError('Invalid or expired setup token')
    const parsedEmail = loginEmail.safeParse(email)
    if (!parsedEmail.success || !password || password.length < 12 || password.length > 128) {
      throw new BootstrapError('Set ADMIN_EMAIL and a 12–128 character ADMIN_PASSWORD')
    }

    const normalized = parsedEmail.data.toLowerCase()
    let id: string
    if (mode === 'create') {
      const existing = await client.query('SELECT 1 FROM "user" LIMIT 1')
      if (existing.rowCount) throw new BootstrapError('Already bootstrapped')
      id = await createUser(client, normalized, password, 'admin')
    } else {
      const { rows: [admin] } = await client.query<{ id: string }>(
        `SELECT id FROM "user" WHERE role='admin' AND email=$1 FOR UPDATE`, [normalized],
      )
      if (!admin) throw new BootstrapError('Admin not found')
      id = admin.id
      const reset = await client.query(`
        UPDATE account SET password=$2,password_revision=password_revision+1,"updatedAt"=now()
        WHERE "userId"=$1 AND "providerId"='credential'
      `, [id, await hashPassword(password)])
      if (reset.rowCount !== 1) throw new BootstrapError('Admin credential not found')
      await client.query('DELETE FROM session WHERE "userId"=$1', [id])
    }

    await client.query('INSERT INTO audit_events(actor_id,action) VALUES($1,$2)', [id, 'bootstrap.' + mode])
  })
}

if (import.meta.main) {
  const url = process.env.MIGRATOR_DATABASE_URL
  if (!url) {
    process.stderr.write('Set MIGRATOR_DATABASE_URL\n')
    process.exitCode = 1
  } else {
    const pool = openDatabase(url)
    try {
      await bootstrap(pool, process.argv[2] ?? '', process.env)
    } catch (error) {
      process.stderr.write(error instanceof BootstrapError ? error.message + '\n' : 'Database operation failed\n')
      process.exitCode = 1
    } finally {
      await pool.end()
    }
  }
}
