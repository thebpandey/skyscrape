import { randomUUID } from 'node:crypto'
import { addPage, enqueueTask, sourceStillQualified, terminalRun, unqueriedCounties } from '../../../packages/db/src/campaigns.ts'
import type { RunRow, Tx } from '../../../packages/db/src/campaigns.ts'
import { transaction } from '../../../packages/db/src/index.ts'
import type { DatabasePool } from '../../../packages/db/src/index.ts'
import { validateCriteria } from '../../../packages/domain/src/templates/index.ts'
import { ArtifactStorageError, commitPage } from './ingest.ts'
import { pageBytes, pageSize, runBytes } from './municipal.ts'
import type { CollectPage, PageOutcome, PageRequest } from './municipal.ts'

const leaseMs = 30_000
const actionMs = 60_000
const maxAttempts = 3

type TaskRow = {
  id: string; run_id: string; attempt: number; attempt_id: string | null; state: string;
  checkpoint: { offset: number }; lease_until: Date | null
}
type Claim = {
  run: RunRow; page: PageRequest; prior: string | null; attempt: number; cancelOnly: boolean
}

async function lockRun(client: Tx, runId: string) {
  return (await client.query<RunRow>('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
}

async function updateTask(client: Tx, id: string, state: string, code: string | null, retryable: boolean, now: Date) {
  await client.query(`
    UPDATE run_tasks SET state=$2,error_code=$3,retryable=$4,available_at=$5,lease_until=NULL
    WHERE id=$1
  `, [id, state, code, retryable, now])
}

async function endRun(client: Tx, runId: string, state: string, counters: Record<string, number>, now: Date) {
  await client.query('UPDATE runs SET state=$2,counters=$3,finished_at=$4 WHERE id=$1', [
    runId, state, JSON.stringify(counters), terminalRun(state) ? now : null,
  ])
}

function failureState(counters: Record<string, number>) {
  return (counters.observations ?? 0) > 0 ? 'partial' : 'failed'
}

async function claimTask(pool: DatabasePool, taskId: string, now: Date): Promise<Claim | undefined> {
  return transaction(pool, async client => {
    const { rows: [target] } = await client.query<{ run_id: string }>(
      'SELECT run_id FROM run_tasks WHERE id=$1', [taskId],
    )
    if (!target) return undefined
    const run = await lockRun(client, target.run_id)
    if (terminalRun(run.state)) return undefined
    const { rows: [task] } = await client.query<TaskRow>(
      "SELECT * FROM run_tasks WHERE id=$1 AND state='queued' FOR UPDATE", [taskId],
    )
    if (!task) return undefined
    const cancelOnly = run.state === 'cancelling'
    const snapshot = run.config_snapshot
    const started = run.started_at ?? now
    const runDeadline = started.getTime() + snapshot.campaign.limits.maxMinutes * 60_000
    const bytes = Math.min(pageBytes, runBytes - (run.counters.bytes ?? 0))
    if (!cancelOnly && (runDeadline <= now.getTime()
        || (run.counters.attempts ?? 0) >= snapshot.campaign.limits.maxPages || bytes < 1)) {
      await updateTask(client, task.id, 'failed', 'BUDGET_EXHAUSTED', false, now)
      await endRun(client, run.id, failureState(run.counters), run.counters, now)
      return undefined
    }
    if (!cancelOnly && !await sourceStillQualified(client, snapshot.source)) {
      await updateTask(client, task.id, 'failed', 'SOURCE_POLICY_CHANGED', false, now)
      await endRun(client, run.id, failureState(run.counters), run.counters, now)
      return undefined
    }
    const settings = validateCriteria('permit_monitoring', snapshot.campaign.criteria)
    const attemptId = randomUUID()
    await client.query(`
      UPDATE run_tasks SET state='running',attempt=attempt+1,attempt_id=coalesce(attempt_id,$2),lease_until=$3,error_code=NULL
      WHERE id=$1
    `, [task.id, attemptId, new Date(now.getTime() + leaseMs)])
    if (!cancelOnly) {
      await client.query("UPDATE runs SET state='running',started_at=$2,counters=$3 WHERE id=$1", [
        run.id, started, JSON.stringify({
          ...run.counters, attempts: (run.counters.attempts ?? 0) + 1, bytes: (run.counters.bytes ?? 0) + bytes,
        }),
      ])
    }
    return {
      run, cancelOnly, prior: task.attempt_id, attempt: task.attempt + 1,
      page: { runId: run.id, taskId, attemptId, asOf: (snapshot.scheduledFor ?? run.created_at.toISOString()).slice(0,10),
        windowDays: settings.windowDays, status: settings.status, countyFips: snapshot.campaign.geography.countyFips,
        remainingResults: settings.maxResults - (run.counters.observations ?? 0), offset: task.checkpoint.offset, bytes: cancelOnly ? 0 : bytes,
        deadline: new Date(Math.min(runDeadline, now.getTime() + actionMs)), source: snapshot.source },
    }
  })
}

async function heartbeat(pool: DatabasePool, claim: Claim, now: Date) {
  const { page } = claim
  const { rows: [run] } = await pool.query<{ state: string }>(`
    UPDATE run_tasks task SET lease_until=$3 FROM runs r
    WHERE task.id=$1 AND task.attempt=$2 AND task.state='running' AND task.lease_until>$4 AND r.id=task.run_id
    RETURNING r.state
  `, [page.taskId, claim.attempt, new Date(now.getTime() + leaseMs), now])
  if (!run) return 'lost'
  if (run.state === 'cancelling') return 'cancel'
  if (now >= page.deadline) return 'deadline'
  return await sourceStillQualified(pool, page.source) ? 'continue' : 'policy'
}

async function finishTask(pool: DatabasePool, claim: Claim, outcome: PageOutcome, now: Date) {
  return transaction(pool, async client => {
    const { page } = claim
    const run = await lockRun(client, page.runId)
    const { rowCount } = await client.query(`
      SELECT 1 FROM run_tasks WHERE id=$1 AND attempt=$2 AND state='running' AND lease_until>$3 FOR UPDATE
    `, [page.taskId, claim.attempt, now])
    if (!rowCount || terminalRun(run.state)) return
    if (run.state === 'cancelling') {
      // An unavailable collector is retried by lease recovery before reporting cancellation.
      if (outcome.kind === 'failed') return
      await updateTask(client, page.taskId, 'cancelled', null, false, now)
      await endRun(client, run.id, 'cancelled', run.counters, now)
      return
    }
    if (outcome.kind === 'stopped' && outcome.reason === 'lost') return
    const deadlineMissed = now >= page.deadline
    const allowed = await sourceStillQualified(client, page.source)
    const counters = { ...run.counters }
    const observedBytes = outcome.kind === 'page' ? outcome.page.bytes
      : 'bytes' in outcome ? outcome.bytes : undefined
    if (observedBytes !== undefined) counters.bytes = (counters.bytes ?? 0) - page.bytes + observedBytes
    const limits = run.config_snapshot.campaign.limits
    const budgetLeft = (counters.attempts ?? 0) < limits.maxPages && (counters.bytes ?? 0) < runBytes
      && now.getTime() < (run.started_at ?? now).getTime() + limits.maxMinutes * 60_000
    if (!allowed || (deadlineMissed && outcome.kind === 'page')) {
      await updateTask(client, page.taskId, 'failed', allowed ? 'BUDGET_EXHAUSTED' : 'SOURCE_POLICY_CHANGED', false, now)
      await endRun(client, run.id, failureState(counters), counters, now)
      return
    }

    if (outcome.kind === 'page') {
      let code = outcome.partialCode
      const linked = await commitPage(client, { runId: run.id, taskId: page.taskId, source: page.source, page: outcome.page })
      counters.observations = (counters.observations ?? 0) + linked
      if (outcome.page.resultSize === pageSize && linked >= page.remainingResults && !code) code = 'RESULT_LIMIT'
      const more = outcome.page.resultSize === pageSize && !code
      counters.pages = (counters.pages ?? 0) + 1
      if (more && !budgetLeft) code = 'BUDGET_EXHAUSTED'
      else if (!more && !code && unqueriedCounties(run.config_snapshot.campaign, page.source).length) code = 'UNQUERIED_COUNTIES'
      else if (!more && !code && run.config_snapshot.unsupportedFields?.length) code = 'UNSUPPORTED_FIELDS'
      await updateTask(client, page.taskId, 'completed', code ?? null, false, now)
      if (more && budgetLeft) {
        // Offsets are page checkpoints; unchanged source revisions still link once per run.
        await addPage(client, run.id, page.offset + pageSize)
        await endRun(client, run.id, 'running', counters, now)
      } else {
        await endRun(client, run.id, code ? 'partial' : 'completed', counters, now)
      }
      return
    }

    const code = outcome.kind === 'failed' ? outcome.code : outcome.reason === 'policy'
      ? 'SOURCE_POLICY_CHANGED' : 'BUDGET_EXHAUSTED'
    const transient = outcome.kind === 'failed' && outcome.retryable
    const waiting = ['AUTH_REQUIRED','CHALLENGE_REQUIRED'].includes(code)
    const retry = transient && budgetLeft && claim.attempt < maxAttempts
    await client.query(`
      INSERT INTO retrieval_attempts(task_id,source_version_id,method,error_code,bytes)
      VALUES($1,$2,'structured',$3,$4)
    `, [page.taskId, page.source.versionId, code, observedBytes])
    const state = retry ? 'retry_wait' : waiting && budgetLeft ? 'waiting_user' : 'failed'
    await updateTask(client, page.taskId, state, code, transient || waiting,
      new Date(now.getTime() + (retry ? Math.min(30, 2 ** claim.attempt) * 1000 : 0)))
    await endRun(client, run.id, state === 'failed' ? failureState(counters) : state, counters, now)
  })
}

export async function recoverDeliveries(pool: DatabasePool, now: Date) {
  await transaction(pool, async client => {
    const { rows } = await client.query<{ id: string; run_id: string; redeliveries: number; counters: Record<string, number> }>(`
      SELECT t.id,t.run_id,coalesce((t.checkpoint->>'redeliveries')::int,0) AS redeliveries,r.counters
      FROM run_tasks t JOIN runs r ON r.id=t.run_id
      JOIN LATERAL (SELECT id,dispatched_at FROM outbox WHERE event_type='campaign.task.ready'
        AND payload->>'taskId'=t.id::text ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
      LEFT JOIN campaign_queue.job j ON j.name='permit-pages' AND j.id=e.id
      WHERE t.state='queued' AND e.dispatched_at IS NOT NULL
        AND (j.state IN ('failed','cancelled','completed') OR (j.id IS NULL AND e.dispatched_at<$1::timestamptz-interval '2 minutes'))
      ORDER BY t.id LIMIT 25 FOR UPDATE OF r,t SKIP LOCKED
    `, [now])
    for (const task of rows) {
      if (task.redeliveries >= 2) {
        await updateTask(client, task.id, 'failed', 'DELIVERY_EXHAUSTED', true, now)
        await endRun(client, task.run_id, failureState(task.counters), task.counters, now)
      } else {
        await client.query("UPDATE run_tasks SET checkpoint=jsonb_set(checkpoint,'{redeliveries}',to_jsonb($2::int)) WHERE id=$1",
          [task.id, task.redeliveries + 1])
        await enqueueTask(client, task.id)
      }
    }
  })
}

export async function recoverTasks(pool: DatabasePool, now: Date) {
  await transaction(pool, async client => {
    const { rows } = await client.query<{ id: string }>(`
      SELECT id FROM run_tasks WHERE (state='running' AND lease_until<=$1)
        OR (state='retry_wait' AND available_at<=$1) ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED
    `, [now])
    for (const { id } of rows) {
      await client.query("UPDATE run_tasks SET state='queued',lease_until=NULL,available_at=$2 WHERE id=$1", [id, now])
      await enqueueTask(client, id)
    }
    const { rows: [expired] } = await client.query<{ id: string; counters: Record<string, number> }>(`
      SELECT id,counters FROM runs
      WHERE state='waiting_user' AND started_at+interval '24 hours'<=$1
      ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED
    `, [now])
    if (expired) {
      await client.query("UPDATE run_tasks SET state='failed',error_code='WAITING_USER_EXPIRED' WHERE run_id=$1 AND state='waiting_user'", [expired.id])
      await endRun(client, expired.id, failureState(expired.counters), expired.counters, now)
    }
  })
}

export async function executeTask(pool: DatabasePool, collector: CollectPage, taskId: string, clock: () => Date) {
  const claim = await claimTask(pool, taskId, clock())
  if (!claim) return
  let outcome: PageOutcome
  try {
    if (claim.prior) {
      await collector.cancel(taskId, claim.prior)
      if (!claim.cancelOnly) {
        // Persist the replacement only after its predecessor has stopped and this lease still owns the task.
        const { rowCount } = await pool.query(`
          UPDATE run_tasks SET attempt_id=$3 WHERE id=$1 AND attempt=$2 AND state='running' AND lease_until>$4
        `, [taskId, claim.attempt, claim.page.attemptId, clock()])
        if (!rowCount) return
      }
    }
    outcome = claim.cancelOnly ? { kind: 'stopped', reason: 'cancel' }
      : await collector.execute(claim.page, () => heartbeat(pool, claim, clock()))
  } catch {
    outcome = { kind: 'failed', code: 'COLLECTION_UNAVAILABLE', retryable: true }
  }
  try {
    await finishTask(pool, claim, outcome, clock())
  } catch (error) {
    if (!(error instanceof ArtifactStorageError) || outcome.kind !== 'page') throw error
    await finishTask(pool, claim, { kind: 'failed', code: 'STORAGE_FAILED', retryable: true, bytes: outcome.page.bytes }, clock())
  }
}
