import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transaction, type DatabasePool } from '../../../../packages/db/src/index.ts'
import { seal, unseal } from '../../../../packages/security/src/index.ts'

export type Registration = {
  id: string; label: string; client: string; subject: string
  tokens?: { access: string; refresh: string; identity: string; expires: number; scopes: string[] }
  identityOnly?: string; model?: string; effort?: string
}
export type Host = { host: string; revision?: number; welcomed?: boolean; accounts: Registration[]; active?: string }
export type WithHost = <T>(work: (host: Host, persist: () => Promise<void>) => Promise<T>) => Promise<T>

export function hostStore(pool: DatabasePool, dir: string, owner: string, key: Buffer, version: number): WithHost {
  const purpose = 'chatgpt-plan:' + owner
  const path = join(dir, owner + '.enc')
  return work => transaction(pool, async db => {
    // Both private preview API processes share this file and rotating refresh tokens.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [purpose])
    await mkdir(dir, { recursive: true, mode: 0o700 })
    let host: Host
    const save = async () => {
      const temp = path + '.' + randomUUID()
      try {
        await writeFile(temp, seal(JSON.stringify(host), key, version, purpose), { flag: 'wx', mode: 0o600 })
        await rename(temp, path)
      } finally { await rm(temp, { force: true }) }
    }
    try { host = JSON.parse(unseal(await readFile(path), key, version, purpose)) as Host }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      host = { host: 'urn:uuid:' + randomUUID(), accounts: [] }
      await save()
    }
    return work(host, save)
  })
}
