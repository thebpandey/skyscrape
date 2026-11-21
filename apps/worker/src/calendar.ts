import { PgBoss } from 'pg-boss'
import type { CampaignTiming } from '../../../packages/contracts/src/index.ts'
import { upcoming } from '../../../packages/domain/src/campaigns/schedule.ts'

// Reuse the installed cron parser without starting pg-boss's own scheduler.
const calendar = new PgBoss({ schedule: false })

export function nextOccurrences(timing: CampaignTiming | undefined, from: Date, count: number) {
  return upcoming(timing, from, count, (expression, cursor, size) =>
    calendar.previewSchedule(expression, { from: cursor, count: size, tz: 'UTC' }))
}

// Find the last due occurrence without replaying every minute of a long outage.
export function latestDue(timing: CampaignTiming, first: Date, now: Date, graceMinutes: number) {
  let due = first
  let low = Math.max(+first, +now - Math.max(30_000, graceMinutes * 60_000) - 1)
  let high = +now
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const next = nextOccurrences(timing, new Date(mid), 1)[0]
    if (next && next <= now) {
      due = next
      low = +next
    } else high = mid - 1
  }
  return due
}
