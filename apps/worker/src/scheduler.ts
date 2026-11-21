import { lockCampaign, plannedRun } from '../../../packages/db/src/campaigns.ts'
import type { ScheduleRow, Tx } from '../../../packages/db/src/campaigns.ts'
import { transaction } from '../../../packages/db/src/index.ts'
import type { DatabasePool } from '../../../packages/db/src/index.ts'
import { latestDue, nextOccurrences } from './calendar.ts'

async function launch(client: Tx, schedule: ScheduleRow, due: Date) {
  return plannedRun(client, schedule.campaign_id, 'scheduled', due, schedule.recurrence)
}

async function finishSchedule(client: Tx, schedule: ScheduleRow) {
  await client.query("UPDATE schedules SET state='done',next_due_at=NULL WHERE id=$1", [schedule.id])
  await client.query("UPDATE campaigns SET state='draft' WHERE id=$1", [schedule.campaign_id])
}

export async function scheduleDue(pool: DatabasePool, now: Date) {
  const { rows } = await pool.query<{ id: string; campaign_id: string }>(`
    SELECT s.id,s.campaign_id FROM schedules s
    WHERE s.state='active' AND (s.next_due_at<=$1 OR (
      EXISTS (SELECT 1 FROM occurrences o WHERE o.schedule_id=s.id AND o.disposition='waiting_overlap')
      AND NOT EXISTS (
        SELECT 1 FROM runs r WHERE r.campaign_id=s.campaign_id
          AND r.state IN ('queued','running','retry_wait','waiting_user','cancelling')
      )
    ))
    ORDER BY COALESCE(s.next_due_at,'-infinity'::timestamptz),s.id LIMIT 20
  `, [now])
  for (const candidate of rows) {
    await transaction(pool, async client => {
      await lockCampaign(client, candidate.campaign_id)
      const { rows: [schedule] } = await client.query<ScheduleRow>(`
        SELECT * FROM schedules WHERE id=$1 AND state='active' FOR UPDATE
      `, [candidate.id])
      if (!schedule) return
      const { rowCount: active } = await client.query(`
        SELECT 1 FROM runs WHERE campaign_id=$1 AND state IN ('queued','running','retry_wait','waiting_user','cancelling')
        LIMIT 1
      `, [schedule.campaign_id])
      const { rows: [pending] } = await client.query<{ id: string; scheduled_for: Date }>(`
        SELECT id,scheduled_for FROM occurrences WHERE schedule_id=$1 AND disposition='waiting_overlap'
      `, [schedule.id])
      if (pending && !active) {
        const runId = await launch(client, schedule, pending.scheduled_for)
        await client.query('UPDATE occurrences SET disposition=$2,run_id=$3 WHERE id=$1', [
          pending.id, runId ? 'launched' : 'policy_blocked', runId,
        ])
        if (!schedule.next_due_at) await finishSchedule(client, schedule)
        return
      }

      const first = schedule.next_due_at
      if (!first || first > now) return
      const due = schedule.misfire === 'coalesce' && +now - +first > 30_000
        ? latestDue(schedule.recurrence, first, now, schedule.grace_minutes) : first
      const age = now.getTime() - due.getTime()
      const missed = age > 30_000 && (schedule.misfire === 'skip' || age > schedule.grace_minutes * 60_000)
      const next = nextOccurrences(schedule.recurrence, now, 1)[0] ?? null
      const { rows: [occurrence] } = await client.query<{ id: string }>(`
        INSERT INTO occurrences(schedule_id,scheduled_for,disposition) VALUES($1,$2,'pending')
        ON CONFLICT(schedule_id,scheduled_for) DO UPDATE SET disposition='pending'
        WHERE occurrences.disposition='paused' AND $3 RETURNING id
      `, [schedule.id, due, schedule.recurrence.mode === 'once'])

      let waiting = Boolean(pending)
      if (occurrence) {
        let disposition = 'missed'
        let runId: string | undefined
        if (!missed && active) {
          waiting = waiting || schedule.overlap === 'queue_one'
          disposition = !pending && waiting ? 'waiting_overlap' : 'overlap_skipped'
        } else if (!missed) {
          runId = await launch(client, schedule, due)
          disposition = runId ? 'launched' : 'policy_blocked'
        }
        await client.query('UPDATE occurrences SET disposition=$2,run_id=$3 WHERE id=$1', [
          occurrence.id, disposition, runId,
        ])
      }
      if (next || waiting) await client.query('UPDATE schedules SET next_due_at=$2 WHERE id=$1', [schedule.id, next])
      else await finishSchedule(client, schedule)
    })
  }
}
