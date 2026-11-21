import type { CampaignTiming } from '../../../contracts/src/index.ts'

type CronPreview = (expression: string, from: Date, count: number) => Date[]
type Recurring = Extract<CampaignTiming, { mode: 'recurring' }>
export type SchedulePolicy = {
  timing: Exclude<CampaignTiming, { mode: 'instant' }>
  overlap: 'skip' | 'queue_one'
  misfire: { policy: 'skip' | 'coalesce'; graceMinutes: number }
}

function cronExpression(timing: Recurring) {
  if (timing.frequency === 'cron') return timing.cron
  const [hour, minute] = timing.localTime.split(':').map(Number)
  if (timing.frequency === 'monthly') return [minute, hour, timing.dayOfMonth, '*', '*'].join(' ')
  const weekdays = timing.frequency === 'weekly' ? [...new Set(timing.weekdays)].join(',') : '*'
  return [minute, hour, '*', '*', weekdays].join(' ')
}

function wallClock(timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return (instant: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, Number(part.value)]))
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  }
}

export function upcoming(timing: CampaignTiming | undefined, from: Date, count: number, previewCron: CronPreview) {
  if (!timing || timing.mode === 'instant') return []
  if (timing.mode === 'once') {
    const scheduled = new Date(timing.scheduledFor)
    return scheduled > from ? [scheduled] : []
  }

  const local = wallClock(timing.timezone)
  const expression = cronExpression(timing)
  let cursor = new Date(local(from))
  const result: Date[] = []
  const offsetSample = 36 * 60 * 60 * 1000
  for (let checked = 0; checked < 2_000 && result.length < count; checked += 16) {
    const candidates = previewCron(expression, cursor, 16)
    if (!candidates.length) break
    for (const candidate of candidates) {
      const wall = candidate.getTime()
      const samples = [wall - offsetSample, wall, wall + offsetSample]
      const instants = samples.map(sample => wall - (local(new Date(sample)) - sample))
        .filter(instant => local(new Date(instant)) === wall)
      // A missing wall time has no match. A repeated wall time uses its first instant.
      const instant = Math.min(...instants)
      if (Number.isFinite(instant) && instant > from.getTime()) result.push(new Date(instant))
      if (result.length === count) break
    }
    cursor = candidates[candidates.length - 1]
  }
  return result
}

export function previewTime(utc: Date, timezone: string) {
  return {
    utc: utc.toISOString(),
    local: new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
    }).format(utc),
    timezone,
  }
}
