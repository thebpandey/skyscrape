import type { TaskRequest, TaskResult } from '../../../contracts/src/collection/index.ts'
import {
  AUSTIN_PERMITS_SOURCE as austin, SEATTLE_PERMITS_SOURCE as seattle, buildAustinPermitsUrl,
  buildSeattlePermitsUrl, normalizeAustinPermit, normalizeSeattlePermit, type MunicipalPermitSourceId,
} from '../municipal/index.ts'
import { empty, observedBy, windowStart, type CampaignQuery } from './shared.ts'

const sources = {
  [austin.id]: { source: austin, url: buildAustinPermitsUrl, normalize: normalizeAustinPermit,
    counties: ['48453', '48491', '48209'], number: 'permit_number', issued: 'issue_date',
    type: 'permittype', status: 'status_current', class: 'permit_class', keys: ['project_id'] },
  [seattle.id]: { source: seattle, url: buildSeattlePermitsUrl, normalize: normalizeSeattlePermit,
    counties: ['53033'], number: 'permitnum', issued: 'issueddate',
    type: 'permittypemapped', status: 'statuscurrent', class: 'permitclass', keys: [] },
} as const

export type MunicipalAttempt = Pick<TaskRequest, 'runId' | 'taskId' | 'attemptId' | 'correlationId' | 'deadline'> & {
  assessmentId: string
  offset?: number
  allowedFields: readonly string[]
  byteLimit: number
}

export function buildMunicipalTask(query: CampaignQuery, sourceId: MunicipalPermitSourceId, attempt: MunicipalAttempt): TaskRequest | null {
  const start = windowStart(query)
  const dataset = sources[sourceId]
  if (!dataset || !query.eligibleSourceIds.includes(sourceId) || !query.kinds.includes('permit') || query.asset
    || !dataset.counties.some(county => query.countyFips.includes(county))) return null
  if (!Number.isSafeInteger(attempt.byteLimit) || attempt.byteLimit < 1 || attempt.byteLimit > 8 * 1024 * 1024)
    throw new RangeError('Invalid collection byte budget')
  const fields: string[] = [...dataset.keys, dataset.number, dataset.issued]
  if (query.permitClass) fields.push(dataset.class)
  if (query.permitType) fields.push(dataset.type)
  if (!fields.every(field => attempt.allowedFields.includes(field))) return null
  for (const field of [dataset.status, dataset.type]) {
    if (attempt.allowedFields.includes(field) && !fields.includes(field)) fields.push(field)
  }
  // The collector returns at most 128 field observations per attempt.
  const limit = Math.min(query.limit, Math.floor(128 / fields.length))
  const url = new URL(dataset.url({ limit, offset: attempt.offset }))
  url.searchParams.set('$select', fields.join(','))
  const end = new Date(Date.parse(query.asOf) + 86400000).toISOString().slice(0, 10)
  const where = [dataset.issued + " >= '" + start + "'", dataset.issued + " < '" + end + "'"]
  for (const [key, value] of [[dataset.class, query.permitClass], [dataset.type, query.permitType]] as const) {
    if (value === undefined) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9 /&()._-]{0,79}$/.test(value)) throw new RangeError('Invalid permit filter')
    where.push(key + " = '" + value + "'")
  }
  url.searchParams.set('$where', where.join(' AND '))
  const { runId, taskId, attemptId, correlationId, deadline, assessmentId } = attempt
  return { protocolVersion: 1, runId, taskId, attemptId, correlationId, deadline, sourceId,
    sourceVersion: dataset.source.version, recipeVersion: 'campaign-permit-1', url: url.href,
    mode: 'structured', allowedMethods: ['structured'], permissions: { assessmentId, allowedDomains: [url.hostname] },
    limits: { requests: 1, quotaUnits: 1, bytes: attempt.byteLimit, browserSeconds: 0, costMicros: 0 },
    recipe: { format: 'json', fields: fields.map(key => ({ key, field: key })) } }
}

export interface MunicipalContext {
  /** Return the authorized durable evidence ID only after size, MIME and digest verification and promotion. */
  evidenceId(manifest: TaskResult['evidence'][number]): string | undefined
  /** Return the vetted county for this Austin source record. */
  austinCounty?(sourceRecordId: string): { countyFips: string; evidenceId: string } | undefined
}

export function readMunicipalPage(query: CampaignQuery, sourceId: MunicipalPermitSourceId, attempt: MunicipalAttempt,
  result: TaskResult, context: MunicipalContext) {
  const dataset = sources[sourceId]
  const { publisher, queryUrl: sourceUrl, license, termsUrl, attribution } = dataset.source
  const batch = empty({ sourceId, publisher, sourceUrl, license, termsUrl, attribution, assessmentId: attempt.assessmentId })
  const task = buildMunicipalTask(query, sourceId, attempt)
  if (!task || task.mode !== 'structured') return empty(batch.provenance, 'Municipal source outside campaign scope.')
  if (result.taskId !== task.taskId || result.attemptId !== task.attemptId) throw new Error('Collector attempt mismatch')
  const finalUrl = result.finalUrl && new URL(result.finalUrl)
  const page = new URL(task.url)
  const limit = Number(page.searchParams.get('$limit'))
  // The Python collector re-encodes the query string after enforcing the projection.
  if (!finalUrl || finalUrl.origin + finalUrl.pathname !== sourceUrl
    || finalUrl.searchParams.toString() !== page.searchParams.toString()
    || result.redirects.length || result.httpStatus !== 200 || result.responseMediaType !== 'application/json')
    return empty(batch.provenance, 'Collector did not confirm the requested permit page.')
  if (result.classification !== 'success') {
    // EMPTY_CONTENT also covers an empty HTTP body. The protocol cannot prove an empty array.
    return empty(batch.provenance, result.error.code)
  }
  if (!observedBy(result.retrievedAt, query.asOf)) return empty(batch.provenance, 'Evidence postdates the run.')
  const manifest = result.evidence[0]
  if (result.evidence.length !== 1 || manifest.mediaType !== 'application/json'
    || result.contentClassification !== 'expected') throw new Error('Unexpected municipal evidence')
  const evidenceRef = context.evidenceId(manifest)
  if (!evidenceRef?.trim()) return empty(batch.provenance, 'Evidence was not promoted or authorized.')
  const fields = new Set(task.recipe.fields.map(field => field.key))
  const rows = new Map<number, Record<string, string>>()
  for (const observation of result.observations) {
    const match = /^\/(0|[1-9]\d*)\/([a-z0-9_]+)$/.exec(observation.locator)
    if (!match || Number(match[1]) >= limit || match[2] !== observation.field || !fields.has(observation.field)
      || observation.artifactId !== manifest.artifactId) throw new Error('Unexpected permit observation')
    const row = rows.get(+match[1]) ?? {}
    if (Object.hasOwn(row, observation.field)) throw new Error('Duplicate permit field')
    row[observation.field] = observation.original
    rows.set(+match[1], row)
  }
  const start = windowStart(query)
  const gaps = new Set<string>()
  for (const row of rows.values()) {
    const permit = dataset.normalize(row, { fetchedAt: result.retrievedAt, evidenceRef, evidenceDigest: manifest.sha256 })
    if (!permit?.eventDate) { gaps.add('Missing permit identity or issuance date.'); continue }
    const location = sourceId === seattle.id ? { countyFips: '53033', evidenceId: evidenceRef }
      : context.austinCounty?.(permit.sourceRecordId)
    if (!location?.evidenceId.trim()) { gaps.add('Austin county unverified.'); continue }
    const county = location.countyFips
    const date = permit.eventDate.slice(0, 10)
    if (!query.countyFips.includes(county) || date < start || date > query.asOf
      || (query.permitClass && row[dataset.class] !== query.permitClass)
      || (query.permitType && row[dataset.type] !== query.permitType)) continue
    batch.records.push({ sourceId, sourceRecordId: permit.sourceRecordId, countyFips: county, eventDate: date,
      observedAt: result.retrievedAt, acceptance: 'verified', evidenceIds: [...new Set([evidenceRef, location.evidenceId])],
      facts: { kind: 'permit', jurisdiction: permit.jurisdiction, permitNumber: permit.permitNumber,
        rawStatus: row[dataset.status], status: row[dataset.status]?.trim().toLowerCase(), rawType: row[dataset.type] } })
  }
  if (rows.size === limit) gaps.add('Permit page limit reached. Additional records may exist.')
  batch.coverageGaps = [...gaps]
  return batch
}
