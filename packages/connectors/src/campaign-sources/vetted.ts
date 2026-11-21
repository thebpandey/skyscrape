import type { Facts, RecordKind, TemplateRecord } from '../../../domain/src/templates/types.ts'
import { day, empty, observedBy, windowStart, type CampaignQuery, type SourceProvenance } from './shared.ts'

/** Trusted local assessment. Never populate this grant from the submitted rows. */
export interface VettedGrant extends SourceProvenance {
  kind: RecordKind
  allowedFields: readonly string[]
  eligible: boolean
  freeOnly: boolean
  /** Current, unsuppressed evidence approved for this source, logical record, fields and campaign. */
  evidenceAllowed(recordId: string, evidenceId: string): boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

const id = (value: unknown) => typeof value === 'string' && /^[\w][\w.:/-]{0,199}$/.test(value)
const label = (value: unknown) => typeof value === 'string' && value.length <= 160 && value.trim().length > 0
const flag = (value: unknown) => typeof value === 'boolean'
const oneOf = (...values: string[]) => (value: unknown) => typeof value === 'string' && values.includes(value)
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableCount = (value: unknown) => value === null || count(value)
const asset = oneOf('vacant_land', 'single_family')
const priceKinds = oneOf('asking_cash', 'closing', 'down_payment', 'monthly_payment', 'valuation', 'model_estimate')
function price(value: unknown) {
  return object(value) && Object.keys(value).every(key => ['amount', 'currency', 'type'].includes(key))
    && typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0
    && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && priceKinds(value.type)
}

// Required fields must survive the source-specific grant. Unknown input fields never cross the boundary.
const schemas = {
  transfer: { required: ['instrumentId'], fields: { instrumentId: id, buyerId: id,
    buyerType: oneOf('builder', 'developer', 'fund', 'reit', 'operator', 'manager', 'other'),
    asset, apn: label, relatedParty: flag, nominal: flag } },
  ownership: { required: ['apn', 'ownerId', 'basis'], fields: { apn: label, ownerId: id, basis: oneOf('assessor', 'deed') } },
  permit: { required: ['jurisdiction', 'permitNumber'], fields: { jurisdiction: label, permitNumber: label,
    rawStatus: label, status: label, rawType: label, projectId: id, participantId: id,
    participantRole: oneOf('builder', 'developer', 'contractor', 'applicant') } },
  listing: { required: ['listingId', 'asset'], fields: { listingId: id, asset,
    status: oneOf('active', 'pending', 'sold', 'removed'), price } },
  market: { required: ['seriesId', 'asset', 'trailingMonths', 'completeCoverage', 'activeInventory', 'closedTransactions'],
    fields: { seriesId: id, asset, trailingMonths: (value: unknown) => count(value) && value !== 0,
      completeCoverage: flag, activeInventory: nullableCount, closedTransactions: nullableCount } },
  contact: { required: ['organizationId', 'role', 'channel', 'verifiedPublicBusiness', 'suppressed', 'checkedOn'],
    fields: { organizationId: id, role: oneOf('acquisitions', 'general_business'), channel: oneOf('website', 'email', 'phone'),
      verifiedPublicBusiness: (value: unknown) => value === true, suppressed: (value: unknown) => value === false, checkedOn: day } },
} satisfies Record<RecordKind, { required: string[]; fields: Record<string, (value: unknown) => boolean> }>

function projectFacts(grant: VettedGrant, input: unknown, templateId: CampaignQuery['templateId']): Facts | undefined {
  if (!object(input) || input.kind !== grant.kind) return
  // A restricted disqualifier cannot be projected away and leave an apparent acquisition.
  const forAcquisition = templateId === undefined || templateId === 'land_buyer_discovery'
    || templateId === 'institutional_sfr_acquisition_research'
  if (grant.kind === 'transfer' && forAcquisition && ['relatedParty', 'nominal'].some(
    field => input[field] === true && !grant.allowedFields.includes(field))) return
  const schema = schemas[grant.kind]
  const facts: Record<string, unknown> = { kind: grant.kind }
  for (const [field, valid] of Object.entries(schema.fields)) {
    if (!grant.allowedFields.includes(field) || !Object.hasOwn(input, field)) continue
    if (!valid(input[field])) return
    facts[field] = input[field]
  }
  if (schema.required.every(key => Object.hasOwn(facts, key))) return facts as Facts
}

function newestFirst(a: TemplateRecord, b: TemplateRecord) {
  const date = (row: TemplateRecord) => row.eventDate ?? (row.facts.kind === 'contact' ? row.facts.checkedOn : '')
  return date(b).localeCompare(date(a)) || Date.parse(b.observedAt) - Date.parse(a.observedAt)
    || (a.sourceRecordId < b.sourceRecordId ? 1 : a.sourceRecordId > b.sourceRecordId ? -1 : 0)
}

export function readVettedEvidence(query: CampaignQuery, grant: VettedGrant, rows: readonly unknown[]) {
  const start = windowStart(query)
  const { sourceId, publisher, sourceUrl, license, termsUrl, attribution, assessmentId } = grant
  const provenance = { sourceId, publisher, sourceUrl, license, termsUrl, attribution, assessmentId }
  if (grant.eligible !== true || grant.freeOnly !== true || !Object.values(provenance).every(label)
    || !query.eligibleSourceIds.includes(sourceId) || !query.kinds.includes(grant.kind))
    return empty(provenance, 'Local source lacks an eligible assessment for this run.')
  if (query.permitClass) return empty(provenance, 'Vetted record format does not establish permit class.')
  const batch = empty(provenance)
  const seen = new Set<string>()
  // Each grant covers one source. County and listing ID identify an episode within it.
  const baselines = new Map<string, TemplateRecord>()
  let rejected = false
  for (const row of rows) {
    if (!object(row) || row.sourceId !== sourceId || typeof row.sourceRecordId !== 'string' || !id(row.sourceRecordId)) {
      rejected = true
      continue
    }
    // Input must be a current snapshot. Never revive an earlier revision after a withdrawal.
    if (seen.has(row.sourceRecordId)) throw new Error('Vetted snapshot contains multiple revisions of one source record')
    seen.add(row.sourceRecordId)
    if (typeof row.countyFips !== 'string' || !query.countyFips.includes(row.countyFips)) continue
    if (!observedBy(row.observedAt, query.asOf) || !['verified', 'corroborated'].some(value => value === row.acceptance)
      || !Array.isArray(row.evidenceIds) || !row.evidenceIds.length
      || !row.evidenceIds.every(ref => id(ref) && grant.evidenceAllowed(row.sourceRecordId as string, ref))) {
      rejected = true
      continue
    }
    const facts = projectFacts(grant, row.facts, query.templateId)
    if (!facts) { rejected = true; continue }
    const date = facts.kind === 'contact' ? facts.checkedOn : row.eventDate
    if (!day(date)) { rejected = true; continue }
    const buyerContact = facts.kind === 'contact' && query.kinds.includes('transfer')
    if ((date < start && facts.kind !== 'listing') || date > query.asOf || (query.asset && !buyerContact && (!('asset' in facts) || facts.asset !== query.asset))
      || (query.permitType && (facts.kind !== 'permit' || facts.rawType !== query.permitType))) continue
    const record: TemplateRecord = { sourceId, sourceRecordId: row.sourceRecordId, observedAt: row.observedAt,
      eventDate: facts.kind === 'contact' ? null : date, evidenceIds: [...row.evidenceIds], countyFips: row.countyFips,
      acceptance: row.acceptance as 'verified' | 'corroborated', facts }
    if (date < start && facts.kind === 'listing') {
      const episode = row.countyFips + '/' + facts.listingId
      const prior = baselines.get(episode)
      if (!prior || newestFirst(record, prior) < 0) baselines.set(episode, record)
    } else {
      batch.records.push(record)
    }
  }
  if (rejected) batch.coverageGaps.push('Some local observations lacked approved, current evidence or required fields.')
  batch.records.sort(newestFirst)
  for (const current of batch.records.slice(0, query.limit)) {
    if (current.facts.kind !== 'listing') continue
    const episode = current.countyFips + '/' + current.facts.listingId
    const baseline = baselines.get(episode)
    if (baseline) {
      batch.records.push(baseline)
      baselines.delete(episode)
    }
  }
  if (batch.records.length > query.limit) {
    batch.records.length = query.limit
    batch.coverageGaps.push('Local evidence result limit reached.')
  }
  return batch
}
