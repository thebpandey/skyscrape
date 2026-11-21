import { createHash } from 'node:crypto'
import type { TaskRequest, TaskResult } from '../../../contracts/src/collection/index.ts'
import type { MunicipalAttempt } from './municipal.ts'
import { observedBy, windowStart, type CampaignQuery } from './shared.ts'

export const censusSourceId = 'census-bps-county-2025'
const url = 'https://www2.census.gov/econ/bps/County/co2025a.txt'

/** Operator-qualified header lines and zero-based column positions for this release. */
export interface CensusLayout {
  headers: readonly string[]
  surveyYear: number
  stateFips: number
  countyFips: number
  oneUnitUnitsIncludingImputation: number
}

type CensusAttempt = Omit<MunicipalAttempt, 'offset' | 'allowedFields'>

export function buildCensusTask(query: CampaignQuery, attempt: CensusAttempt, layout: CensusLayout): TaskRequest | null {
  const start = windowStart(query)
  if (!query.kinds.includes('market') || !query.eligibleSourceIds.includes(censusSourceId) || !query.countyFips.length
    || query.asOf < '2026-05-14' || start > '2025-12-31' || query.permitClass || query.permitType
    || query.asset === 'vacant_land') return null
  const columns = [layout.surveyYear, layout.stateFips, layout.countyFips, layout.oneUnitUnitsIncludingImputation]
  const firstKey = layout.headers[0]?.split(',')[0]?.replace(/^"(.*)"$/, '$1')
  if (!firstKey || !/^[A-Za-z][A-Za-z 0-9_-]{0,79}$/.test(firstKey) || !layout.headers.length
    || !columns.every(n => Number.isInteger(n) && n >= 0 && n < layout.headers[0].split(',').length)
    || new Set(columns).size !== columns.length) throw new RangeError('Missing assessed Census column layout')
  if (!Number.isSafeInteger(attempt.byteLimit) || attempt.byteLimit < 1 || attempt.byteLimit > 8 * 1024 * 1024)
    throw new RangeError('Invalid Census file budget')
  const { taskId, attemptId, runId, correlationId, deadline, assessmentId } = attempt
  return { protocolVersion: 1, taskId, attemptId, runId, correlationId, deadline, sourceId: censusSourceId,
    sourceVersion: 'co2025a', recipeVersion: 'county-units-1', url, mode: 'structured', allowedMethods: ['structured'],
    permissions: { allowedDomains: ['www2.census.gov'], assessmentId },
    limits: { requests: 1, bytes: attempt.byteLimit, quotaUnits: 1, browserSeconds: 0, costMicros: 0 },
    recipe: { format: 'csv', fields: [{ field: 'countyRow', key: firstKey }] } }
}

export function readCensusPage(query: CampaignQuery, attempt: CensusAttempt, layout: CensusLayout, result: TaskResult,
  promoted?: { bytes: Uint8Array; evidenceId: string }) {
  const provenance = { sourceId: censusSourceId, sourceUrl: url, assessmentId: attempt.assessmentId,
    publisher: 'U.S. Census Bureau', license: 'Census open data policy',
    termsUrl: 'https://www.census.gov/about/policies/open-gov.html', attribution: 'U.S. Census Bureau, Building Permits Survey, 2025 annual county release' }
  const aggregates: { countyFips: string; surveyYear: 2025; oneUnitUnitsIncludingImputation: number;
    evidenceId: string; observedAt: string }[] = []
  const batch = { records: [], aggregates, provenance, coverageGaps: [] as string[] }
  const task = buildCensusTask(query, attempt, layout)
  if (!task) { batch.coverageGaps.push('Census release outside campaign scope.'); return batch }
  if (task.taskId !== result.taskId || task.attemptId !== result.attemptId) throw new Error('Collector attempt mismatch')
  if (result.finalUrl !== url || result.redirects.length || result.httpStatus !== 200 || result.contentClassification !== 'expected'
    || !observedBy(result.retrievedAt, query.asOf) || (result.classification !== 'success'
      && !(result.classification === 'partial' && result.error.code === 'PARTIAL_CONTENT'))) {
    batch.coverageGaps.push('Complete Census release unavailable.')
    return batch
  }
  // The 128 inline observations can be truncated even when the collector staged the entire CSV.
  const file = result.evidence[0]
  if (!promoted?.evidenceId.trim() || result.evidence.length !== 1 || !['text/plain', 'text/csv'].includes(file.mediaType)
    || file.mediaType !== result.responseMediaType || file.bytes > attempt.byteLimit || promoted.bytes.length !== file.bytes
    || createHash('sha256').update(promoted.bytes).digest('hex') !== file.sha256) throw new Error('Unverified Census artifact')
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(promoted.bytes).split(/\r?\n/)
  if (!layout.headers.every((line, index) => lines[index] === line)) throw new Error('Census release header changed')
  const seen = new Set<string>()
  for (const line of lines.slice(layout.headers.length)) {
    if (!line.trim()) continue
    // Published county records have no multiline fields. Accept quoted county names containing commas.
    const matches = [...(line + ',').matchAll(/(?:"((?:[^"]|"")*)"|([^",]*)),/gy)]
    const last = matches.at(-1)
    if (!last || last.index + last[0].length !== line.length + 1) throw new Error('Invalid Census CSV row')
    const cells = matches.map(m => (m[1] ?? m[2]).trim())
    if (cells[layout.surveyYear] !== '2025' || !/^\d{1,2}$/.test(cells[layout.stateFips] ?? '')
      || !/^\d{1,3}$/.test(cells[layout.countyFips] ?? '')) throw new Error('Invalid Census county row')
    const countyFips = cells[layout.stateFips].padStart(2, '0') + cells[layout.countyFips].padStart(3, '0')
    if (!query.countyFips.includes(countyFips)) continue
    const raw = cells[layout.oneUnitUnitsIncludingImputation]
    if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(+raw) || seen.has(countyFips))
      throw new Error('Ambiguous Census county measure')
    seen.add(countyFips)
    if (aggregates.length < query.limit) aggregates.push({ countyFips, surveyYear: 2025,
      oneUnitUnitsIncludingImputation: +raw, evidenceId: promoted.evidenceId, observedAt: result.retrievedAt })
  }
  for (const county of new Set(query.countyFips)) {
    if (!seen.has(county)) batch.coverageGaps.push(`County ${county} is absent from the Census release.`)
  }
  if (seen.size > aggregates.length) batch.coverageGaps.push('Census county result limit reached.')
  return batch
}
