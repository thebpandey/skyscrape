import { setTimeout } from 'node:timers/promises'
import { PgBoss } from 'pg-boss'
import { idParams } from '../../../packages/contracts/src/index.ts'
import { openDatabase, transaction } from '../../../packages/db/src/index.ts'
import type { DatabasePool } from '../../../packages/db/src/index.ts'
import { logger } from '../../../packages/shared/src/index.ts'
import { createMunicipalAction } from './municipal.ts'
import type { CollectPage } from './municipal.ts'
import { scheduleDue } from './scheduler.ts'
import { executeTask, recoverTasks, recoverDeliveries } from './tasks.ts'

const queue = 'permit-pages'
const cityGate = 220021

async function dispatch(pool: DatabasePool, boss: PgBoss) {
  await transaction(pool, async client => {
    const { rows } = await client.query<{ id: string; payload: { taskId: string } }>(`
      SELECT id,payload FROM outbox WHERE event_type='campaign.task.ready' AND dispatched_at IS NULL
      ORDER BY created_at,id LIMIT 25 FOR UPDATE SKIP LOCKED
    `)
    for (const event of rows) {
      if (idParams.safeParse({ id: event.payload.taskId }).success) {
        await boss.send(queue, { taskId: event.payload.taskId }, {
          id: event.id, db: { executeSql: (query, values) => client.query(query, values) },
        })
      }
      await client.query('UPDATE outbox SET dispatched_at=now(),attempts=attempts+1 WHERE id=$1', [event.id])
    }
  })
}

export async function startWorker(options: {
  databaseUrl: string; collector: CollectPage; clock?: () => Date; tickMs?: number
}) {
  const { databaseUrl, collector, clock = () => new Date(), tickMs = 1000 } = options
  const pool = openDatabase(databaseUrl)
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'campaign_queue', createSchema: false, schedule: false })
  const stop = new AbortController()
  boss.on('error', () => logger.error({ code: 'CAMPAIGN_QUEUE_ERROR' }, 'Campaign queue error'))

  try {
    const { rows: [login] } = await pool.query<{ role: string }>('SELECT current_user AS role')
    if (login.role !== 'skyscrape_worker') throw Error('Expected database role skyscrape_worker')
    await boss.start()
    await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 120 })
    await boss.work<{ taskId: string }>(queue, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      const validated = idParams.safeParse({ id: job.data.taskId })
      if (!validated.success) return
      const client = await pool.connect()
      try {
        // The first registered source shares one publisher crawl slot across worker processes.
        await client.query('SELECT pg_advisory_lock($1)', [cityGate])
        const started = Date.now()
        await executeTask(pool, collector, validated.data.id, clock)
        const remaining = 1000 - (Date.now() - started)
        if (remaining > 0) await setTimeout(remaining)
      } finally {
        client.release(true)
      }
    })
  } catch (error) {
    await boss.stop()
    await pool.end()
    throw error
  }

  async function tick() {
    const now = clock()
    await scheduleDue(pool, now)
    await recoverTasks(pool, now)
    await recoverDeliveries(pool, now)
    await dispatch(pool, boss)
  }

  const loop = (async () => {
    while (!stop.signal.aborted) {
      try { await tick() } catch {
        logger.error({ code: 'CAMPAIGN_TICK_FAILED' }, 'Campaign dispatch failed')
      }
      try { await setTimeout(tickMs, undefined, { signal: stop.signal }) } catch { break }
    }
  })()

  return {
    tick,
    async close() {
      stop.abort()
      await loop
      await boss.stop({ graceful: true, timeout: 70_000 })
      await pool.end()
    },
  }
}

if (import.meta.main) {
  const {
    WORKER_DATABASE_URL, COLLECTION_TOKEN, COLLECTION_SOCKET_PATH,
    COLLECTION_STAGING_DIR, EVIDENCE_STORE_DIR, COLLECTION_SYNTHETIC,
  } = process.env
  if (!WORKER_DATABASE_URL || !COLLECTION_TOKEN || !EVIDENCE_STORE_DIR) {
    throw Error('Set WORKER_DATABASE_URL, COLLECTION_TOKEN and EVIDENCE_STORE_DIR')
  }
  const collector = await createMunicipalAction({
    socketPath: COLLECTION_SOCKET_PATH ?? '/run/collection/collection.sock', token: COLLECTION_TOKEN,
    stagingDir: COLLECTION_STAGING_DIR ?? '/var/staging/collection', artifactDir: EVIDENCE_STORE_DIR,
    synthetic: COLLECTION_SYNTHETIC === '1',
  })
  const worker = await startWorker({ databaseUrl: WORKER_DATABASE_URL, collector })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void worker.close() })
  }
}
