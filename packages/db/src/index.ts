import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator'

export type DatabasePool = pg.Pool
export const credentialProvisioningLock = 4305021
export function openDatabase(url: string) {
  return new pg.Pool({ connectionString: url })
}

export async function migrate(pool: DatabasePool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(4305020)')
    await applyMigrations(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsSchema: 'drizzle',
    })
  } finally {
    // Destroy the connection even if a broken connection prevents unlocking.
    client.release(true)
  }
}

export async function transaction<T>(pool: DatabasePool, operation: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

if (import.meta.main) {
  if (!process.env.MIGRATOR_DATABASE_URL) throw Error('Set MIGRATOR_DATABASE_URL')
  const pool = openDatabase(process.env.MIGRATOR_DATABASE_URL)
  try {
    await migrate(pool)
  } finally {
    await pool.end()
  }
}
