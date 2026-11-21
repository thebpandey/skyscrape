import type { Setting, SettingsByTemplate, TemplateCriteria, TemplateDefinition, TemplateId } from './types.ts'
import type { EvaluationScope, Facts, RecordKind, TemplateEvaluation, TemplateRecord, TemplateRow } from './types.ts'
export type * from './types.ts'

const integer = (min: number, max: number, value: number): Setting => ({ kind: 'integer', min, max, default: value })
const choice = (...options: string[]): Setting => ({ kind: 'choice', options, default: options[0] })
const text: Setting = { kind: 'text', maxLength: 128, default: '' }
const kinds = ['permit', 'transfer', 'ownership', 'listing', 'contact', 'market']

function template<K extends TemplateId>(id: K, title: string, aliases: string[], window: number,
  settings: Record<keyof SettingsByTemplate[K], Setting>): TemplateDefinition {
  return { id, title, aliases, settings: {
    windowDays: integer(1, 3650, window), maxResults: integer(1, 1000, 100), ...settings,
  } }
}

export const templateCatalog: readonly TemplateDefinition[] = [
  template('land_buyer_discovery', 'Land-buyer discovery', ['land_buyers', 'find_land_buyers'], 180,
    { minAcquisitions: integer(1, 1000, 1) }),
  template('builder_activity', 'Builder activity', ['builders'], 90,
    { participantRole: choice('any', 'builder', 'developer', 'contractor', 'applicant') }),
  template('institutional_sfr_acquisition_research', 'Institutional SFR acquisition research',
    ['institutional_sfr', 'sfr_acquisitions', 'institutional_sfr_acquisition'], 365,
    { institutionType: choice('any', 'fund', 'reit', 'operator') }),
  template('permit_monitoring', 'Permit monitoring', ['permit_monitor', 'permit_watch', 'permits'], 90, { status: text }),
  template('ownership_transfer_lookup', 'Ownership/transfer lookup', ['ownership_lookup', 'ownership_transfer'], 365,
    { apn: text }),
  template('land_sfr_listing_watch', 'Land/SFR listing watch', ['listing_watch', 'listing_monitoring'], 90,
    { asset: choice('any', 'vacant_land', 'single_family') }),
  template('market_snapshot', 'Market snapshot', ['market'], 90,
    { asset: choice('vacant_land', 'single_family'), supplyMonths: integer(1, 24, 3) }),
  template('contact_enrichment', 'Contact enrichment', ['contacts'], 180, { role: choice('acquisitions', 'general_business') }),
  template('source_gap_investigation', 'Source-gap investigation', ['source_gap', 'source_gaps'], 90,
    { requiredKind: choice(...kinds) }),
  template('custom_research', 'Custom research', ['custom'], 180, { recordKind: choice(...kinds), subjectId: text }),
]

function definition(id: string) {
  const key = typeof id === 'string' ? id.trim().toLowerCase().replace(/[- /]+/g, '_') : ''
  return templateCatalog.find(entry => entry.id === key || entry.aliases.includes(key))
}

export function resolveTemplateId(value: string): TemplateId | undefined {
  return definition(value)?.id
}

export function validateCriteria<K extends TemplateId>(id: K, input?: unknown): TemplateCriteria<K>
export function validateCriteria(id: string, input?: unknown): TemplateCriteria
export function validateCriteria(id: string, input: unknown = {}): TemplateCriteria {
  const entry = definition(id)
  if (!entry) throw new RangeError('Unknown campaign template')
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('Expected a criteria object')
  }
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(entry.settings, name)) throw new RangeError('Unknown template setting')
  }
  const result: Record<string, string | number> = {}
  for (const [name, field] of Object.entries(entry.settings)) {
    const value = Object.hasOwn(input, name) ? (input as Record<string, unknown>)[name] : field.default
    if (field.kind === 'integer' && typeof value === 'number' && Number.isInteger(value)
        && value >= field.min && value <= field.max) result[name] = value
    else if (field.kind === 'choice' && typeof value === 'string' && field.options.includes(value)) result[name] = value
    else if (field.kind === 'text' && typeof value === 'string' && value.length <= field.maxLength) result[name] = value.trim()
    else throw new RangeError(`Invalid template setting: ${name}`)
  }
  // The catalog supplies each required key and validates its primitive before returning.
  return result as TemplateCriteria
}

type Observation<K extends RecordKind> = TemplateRecord & { facts: Extract<Facts, { kind: K }> }
type Dated = TemplateRecord & { date: string; rowKey: string }
type Sample<K extends RecordKind> = Dated & Observation<K>
const key = (...parts: string[]) => JSON.stringify(parts)
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const dayMs = 86400000

function calendarDay(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date)) return false
  const time = Date.parse(date)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(date + 'T')
}

function instant(value: string) {
  if (typeof value !== 'string' || !calendarDay(value.slice(0, 10))
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN
  return Date.parse(value)
}

function group<T>(items: readonly T[], identity: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const id = identity(item)
    const list = groups.get(id)
    if (list) list.push(item)
    else groups.set(id, [item])
  }
  return groups
}

function citations(records: readonly TemplateRecord[]) {
  return [...new Set(records.flatMap(r => r.evidenceIds))].sort()
}

type LocatedRow = TemplateRow & { counties: string[], observationTime?: number }

function result(id: string, classification: string, records: readonly Dated[],
  values: TemplateRow['values']): LocatedRow {
  return { key: id, classification, counties: [...new Set(records.map(r => r.countyFips))], date: records.reduce<string | null>((latest, r) =>
    latest === null || latest < r.date ? r.date : latest, null), values, evidenceIds: citations(records) }
}

function kind<K extends RecordKind>(records: readonly Dated[], name: K) {
  return records.filter((r): r is Sample<K> => r.facts.kind === name)
}

function subjectIds(f: Facts) {
  switch (f.kind) {
    case 'transfer': return [f.instrumentId, f.buyerId, f.apn]
    case 'listing': return [f.listingId]
    case 'market': return [f.seriesId]
    case 'ownership': return [f.ownerId, f.apn]
    case 'contact': return [f.organizationId]
    case 'permit': return [f.permitNumber, f.projectId, f.participantId]
  }
}

// Custom research returns a structured, cited finding for the selected subject.
function finding(f: Facts): TemplateRow['values'] {
  switch (f.kind) {
    case 'transfer': return { instrumentId: f.instrumentId, granteeId: f.buyerId ?? null, asset: f.asset ?? null }
    case 'listing': return { listingId: f.listingId, asset: f.asset, observedStatus: f.status ?? null }
    case 'market': return { seriesId: f.seriesId, asset: f.asset, activeInventory: f.activeInventory,
      closedTransactions: f.closedTransactions, trailingMonths: f.trailingMonths, completeCoverage: f.completeCoverage }
    case 'ownership': return { apn: f.apn, namedOwner: f.ownerId, basis: f.basis }
    case 'contact': return { organizationId: f.organizationId, verifiedRole: f.role, channel: f.channel, checkedOn: f.checkedOn }
    case 'permit': return { jurisdiction: f.jurisdiction, permitNumber: f.permitNumber, rawStatus: f.rawStatus ?? null,
      normalizedStatus: f.status ?? null, participantRole: f.participantRole ?? null }
  }
}

type Selection = { [K in TemplateId]: { id: K; settings: TemplateCriteria<K> } }[TemplateId]

function relevant(selection: Selection): RecordKind[] {
  switch (selection.id) {
    case 'land_buyer_discovery':
    case 'institutional_sfr_acquisition_research': return ['transfer', 'contact']
    case 'builder_activity':
    case 'permit_monitoring': return ['permit']
    case 'ownership_transfer_lookup': return ['ownership', 'transfer']
    case 'market_snapshot': return ['listing', 'market']
    case 'land_sfr_listing_watch': return ['listing']
    case 'contact_enrichment': return ['contact']
    case 'source_gap_investigation': return [selection.settings.requiredKind]
    case 'custom_research': return [selection.settings.recordKind]
  }
}

// Each source revision can contain several facts with the same observation instant.
function latestRevision(records: TemplateRecord[], before: number) {
  let latest = -Infinity
  let revision: TemplateRecord[] = []
  for (const record of records) {
    const time = instant(record.observedAt)
    if (!Number.isFinite(time) || time >= before || time < latest) continue
    if (time > latest) revision = []
    latest = time
    revision.push(record)
  }
  return revision
}

function accepted(record: TemplateRecord) {
  return ['verified', 'corroborated'].includes(record.acceptance) && record.evidenceIds?.length > 0
    && record.evidenceIds.every(id => typeof id === 'string' && id.trim())
}

function contactIdentity(county: string, f: Extract<Facts, { kind: 'contact' }>) {
  return key(county, f.organizationId, f.role, f.channel)
}

function verifiedContacts(revision: TemplateRecord[]) {
  const allowed = new Set<string>()
  const denied = new Set<string>()
  for (const r of revision) {
    const f = r.facts
    if (f.kind !== 'contact') continue
    const id = contactIdentity(r.countyFips, f)
    if (f.verifiedPublicBusiness === true && f.suppressed === false && accepted(r)) allowed.add(id)
    else denied.add(id)
  }
  for (const id of denied) allowed.delete(id)
  return allowed
}

// A replay can reorder JSON fields or carry another citation for the same fact.
function factKey(r: TemplateRecord) {
  return JSON.stringify([r.countyFips, r.eventDate, r.facts], (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b))) : value)
}

function selectRecords(records: readonly TemplateRecord[], scope: EvaluationScope, start: string,
  selection: Selection, gaps: Set<string>) {
  const end = Date.parse(scope.asOf) + dayMs
  const sources = new Set(scope.eligibleSourceIds)
  const counties = new Set(scope.countyFips)
  const kinds = relevant(selection)
  const eligible = records.filter(r => sources.has(r.sourceId) && r.sourceId?.trim() && r.sourceRecordId?.trim())
  const selected: Dated[] = []
  const excludedInstruments = new Set<string>()
  const histories = group(eligible, r => {
    if (kinds.includes(r.facts.kind)) {
      // A shared report ID can carry independently revised periods and market cohorts.
      if (r.facts.kind === 'market') return key(r.sourceId, r.sourceRecordId, 'market', r.eventDate ?? '',
        r.countyFips, r.facts.seriesId, r.facts.asset, String(r.facts.trailingMonths))
      if (r.facts.kind === 'ownership') return key(r.sourceId, r.sourceRecordId, 'ownership', r.eventDate ?? '')
      if (r.facts.kind === 'permit' || r.facts.kind === 'listing') return key(r.sourceId, r.sourceRecordId, r.eventDate ?? '')
    }
    return key(r.sourceId, r.sourceRecordId)
  })
  for (const [id, history] of histories) {
    const revision = latestRevision(history, end)
    const factsByKey = group(revision, factKey)
    // Channel values are private. A later revision cannot attest to the earlier address.
    const currentContacts = verifiedContacts(revision)
    if (currentContacts.size && history.some(r => instant(r.observedAt) >= end)) currentContacts.clear()
    for (const [identity, observations] of factsByKey) {
      const record = observations.find(r => r.acceptance === 'verified') ?? observations[0]
      const facts = record.facts
      if (!counties.has(record.countyFips) || !kinds.includes(facts.kind)) continue
      if (facts.kind === 'contact') {
        const contact = contactIdentity(record.countyFips, facts)
        if (!currentContacts.has(contact) || !facts.organizationId
            || !['acquisitions', 'general_business'].includes(facts.role)
            || !['website', 'email', 'phone'].includes(facts.channel)) continue
      }
      if (!observations.every(accepted)) {
        gaps.add('Some observations lack accepted evidence.')
        continue
      }
      const date = facts.kind === 'contact' ? facts.checkedOn : record.eventDate
      const dated = calendarDay(date)
      if (dated && date > scope.asOf) continue
      if (facts.kind === 'transfer' && (facts.relatedParty || facts.nominal)) {
        excludedInstruments.add(key(record.countyFips, facts.instrumentId))
      }
      if (!dated) {
        gaps.add(`Some ${facts.kind} observations lack a usable ${facts.kind === 'contact' ? 'verification' : 'event'} date.`)
        continue
      }
      if (date < start && selection.id !== 'land_sfr_listing_watch') continue
      const rowKey = factsByKey.size === 1 ? id : key(record.sourceId, record.sourceRecordId, identity)
      selected.push({ ...record, date, rowKey, evidenceIds: citations(observations) })
    }
  }
  selected.sort((a, b) => compare(a.date, b.date) || instant(a.observedAt) - instant(b.observedAt)
    || compare(a.rowKey, b.rowKey))
  return { selected, excludedInstruments }
}

function buyers(records: Dated[], excludedInstruments: Set<string>, institution: string | undefined, minimum: number, gaps: Set<string>) {
  const deeds = kind(records, 'transfer')
  const instrumentKey = (r: Sample<'transfer'>) => key(r.countyFips, r.facts.instrumentId)
  const transfers = deeds.filter(r => {
    const { facts } = r
    if (!facts.asset || !facts.buyerId || !facts.instrumentId) {
      gaps.add('Some transfers lack an acquisition category, instrument or identified grantee.')
      return false
    }
    if (facts.asset !== (institution ? 'single_family' : 'vacant_land') || excludedInstruments.has(instrumentKey(r))) return false
    if (!institution) return true
    if (!facts.buyerType) gaps.add('Institutional classification is unknown for some grantees.')
    return ['fund', 'reit', 'operator'].includes(facts.buyerType ?? '') && (institution === 'any' || facts.buyerType === institution)
  })
  const contacts = group(kind(records, 'contact').filter(r => r.facts.role === 'acquisitions'), r => r.facts.organizationId)
  const rows: LocatedRow[] = []
  for (const [buyerId, observations] of group(transfers, r => r.facts.buyerId!)) {
    const count = new Set(observations.map(instrumentKey)).size
    if (count < minimum) continue
    const verified = contacts.get(buyerId) ?? []
    const row = result(buyerId, institution ? 'observed_institutional_sfr_buyer' : 'observed_land_buyer', observations, {
      buyerId, acquisitionCount: count, criteriaBasis: 'observed', assetFit: observations[0].facts.asset!,
      lastAcquisition: observations.at(-1)!.date, evidenceSources: new Set(observations.map(r => r.sourceId)).size,
      contactability: verified.length ? 'verified_public_business' : 'unknown',
      buyerTypes: [...new Set(observations.map(r => r.facts.buyerType).filter(Boolean))].sort().join(', ') || null,
    })
    row.evidenceIds = citations([...observations, ...verified])
    rows.push(row)
  }
  if (rows.some(r => r.values.contactability === 'unknown')) gaps.add('Acquisitions contact coverage is incomplete.')
  return rows
}

type Listing = Sample<'listing'>

function listingEvent(records: Listing[]) {
  const asset = records.every(r => r.facts.asset === records[0].facts.asset) ? records[0].facts.asset : null
  const eventCount = new Set(records.map(r => r.sourceRecordId)).size
  const tied = eventCount > 1
  const coversEvents = (claims: Listing[]) => !tied || new Set(claims.map(r => r.sourceRecordId)).size === eventCount
  const statusClaims = records.filter(r => r.facts.status)
  const statuses = group(statusClaims, r => r.facts.status!)
  const status = statuses.size === 1 && coversEvents(statusClaims) ? statusClaims[0] : undefined
  const priced = records.filter(({ facts: { price } }) => price && Number.isFinite(price.amount)
    && price.amount >= 0 && /^[A-Z]{3}$/.test(price.currency))
  const prices = new Map<string, { quotes: Listing[], amount: number | null }>()
  for (const [id, quotes] of group(priced, r => key(r.facts.price!.type, r.facts.price!.currency))) {
    const amount = quotes[0].facts.price!.amount
    const supported = coversEvents(quotes) && quotes.every(r => r.facts.price!.amount === amount)
    prices.set(id, { quotes, amount: supported ? amount : null })
  }
  const conflictingStatuses = statuses.size > 1 ? [...statuses.values()].flat() : []
  const statusGap = conflictingStatuses.length ? 'Conflicting listing statuses prevent a supported status determination.'
    : status ? undefined : 'Some observed listing episodes lack an explicit status.'
  return { records, asset, tied, status, conflictingStatuses, statusGap, prices }
}

const tiedListingGap = 'Some listing events share a date and observation time. Their order is unknown.'
type ListingEvent = ReturnType<typeof listingEvent>

function listingChanges(id: string, events: ListingEvent[], asset: string, start: string, gaps: Set<string>) {
  const changes: LocatedRow[] = []
  let fallback: LocatedRow | undefined
  for (const [index, current] of events.entries()) {
    if (current.asset === null || (asset !== 'any' && asset !== current.asset)) continue
    const previous = events[index - 1]
    const prior = previous?.asset === current.asset ? previous : undefined
    const record = current.records[0]
    if (record.date >= start) {
      if (current.tied || prior?.tied) gaps.add(tiedListingGap)
      if (!prior) gaps.add('Some listing episodes lack a preceding accepted observation in the same asset segment.')
      const status = current.status?.facts.status ?? null
      const previousStatus = prior?.status?.facts.status ?? null
      const statusChanged = status && previousStatus ? status !== previousStatus : null
      if (current.statusGap) gaps.add(current.statusGap)
      if (prior?.statusGap) gaps.add(prior.statusGap)
      const transitions: LocatedRow[] = []
      const meaningful: LocatedRow[] = []
      if (prior) {
        for (const [priceId, { quotes }] of prior.prices) {
          if (current.prices.has(priceId)) continue
          const { type, currency } = quotes[0].facts.price!
          gaps.add(`The current observation lacks a comparable ${type} quote in ${currency}.`)
        }
        if (!current.prices.size && !prior.prices.size) gaps.add('Neither listing observation has a usable price quote.')
      }
      const candidates = current.prices.size ? current.prices : new Map([['', { quotes: [record], amount: null }]])
      for (const [priceId, { quotes, amount }] of [...candidates].sort(([a], [b]) => compare(a, b))) {
        const quote = quotes[0]
        const price = priceId ? quote.facts.price : undefined
        const before = prior?.prices.get(priceId)
        const unresolved = price && (amount === null || before?.amount === null)
        if (unresolved) gaps.add(`Conflicting or incomplete ${price.type} prices in ${price.currency} prevent a supported comparison.`)
        else if (prior && price && !before) gaps.add(`The preceding observation lacks a comparable ${price.type} quote in ${price.currency}.`)
        const delta = amount !== null && before && before.amount !== null ? amount - before.amount : null
        const evidence = [...quotes, ...current.conflictingStatuses, ...(prior?.conflictingStatuses ?? [])]
        if (prior) evidence.push(...(before?.quotes ?? [prior.status ?? prior.records[0]]))
        if (current.status && quote.facts.status !== status) evidence.push(current.status)
        if (prior?.status && before && before.quotes[0].facts.status !== previousStatus) evidence.push(prior.status)
        if (current.tied) evidence.push(...current.records)
        if (prior?.tied) evidence.push(...prior.records)
        const rowKey = current.tied ? key(id, record.date, String(instant(record.observedAt)), priceId)
          : key(id, record.date, record.sourceRecordId, priceId)
        const row = result(rowKey, 'observed_listing_episode', evidence, {
          countyFips: record.countyFips, listingId: record.facts.listingId, asset: record.facts.asset,
          status, previousStatus, statusChanged, priceType: price?.type ?? null,
          amount, currency: price?.currency ?? null, priceChange: delta,
        })
        row.observationTime = instant(record.observedAt)
        transitions.push(row)
        if (unresolved || (delta !== null && delta !== 0)) meaningful.push(row)
      }
      fallback = transitions.find(row => row.values.priceChange !== null) ?? transitions[0]
      if (meaningful.length) {
        meaningful.sort((a, b) => compare(a.key, b.key))
        if (statusChanged) {
          for (const extra of meaningful.slice(1)) extra.values.statusChanged = null
        }
        changes.push(...meaningful)
      } else if (!prior || statusChanged || current.conflictingStatuses.length || (current.tied && !current.status)) {
        changes.push(fallback)
      }
    }
  }
  return changes.length ? changes : fallback ? [fallback] : []
}

function listings(records: Dated[], asset: string, start: string, snapshot: boolean, gaps: Set<string>) {
  const episodes = group(kind(records, 'listing').filter(r => r.facts.listingId),
    r => key(r.countyFips, r.sourceId, r.facts.listingId))
  const rows: LocatedRow[] = []
  const current: ListingEvent[] = []
  for (const [id, observations] of episodes) {
    const events = Array.from(group(observations, r => key(r.date, String(instant(r.observedAt)))).values(), listingEvent)
    const latest = events.at(-1)!
    if (latest.records[0].date < start) continue
    if ((snapshot ? [latest] : events).some(e => e.records[0].date >= start && e.asset === null)) {
      gaps.add('Conflicting listing asset classifications prevent segment attribution.')
    }
    if (snapshot) {
      if (latest.asset !== asset) continue
      if (latest.tied) gaps.add(tiedListingGap)
      current.push(latest)
      if (latest.statusGap) gaps.add(latest.statusGap)
    } else {
      rows.push(...listingChanges(id, events, asset, start, gaps))
    }
  }
  if (snapshot) {
    for (const [county, sample] of group(current, event => event.records[0].countyFips)) {
      const evidence = sample.flatMap(event => event.status && !event.tied ? [event.status] : event.records)
      rows.push(result(county, 'observed_listing_sample', evidence, {
        countyFips: county, asset, sampleSize: sample.length,
        active: sample.filter(event => event.status?.facts.status === 'active').length,
        pending: sample.filter(event => event.status?.facts.status === 'pending').length,
        sold: sample.filter(event => event.status?.facts.status === 'sold').length,
        removed: sample.filter(event => event.status?.facts.status === 'removed').length,
        unknownStatus: sample.filter(event => !event.status).length, monthsOfSupply: null,
      }))
    }
  }
  return rows
}

export function evaluateTemplate(id: string, criteria: unknown, records: readonly TemplateRecord[],
  scope: EvaluationScope): TemplateEvaluation {
  const templateId = resolveTemplateId(id)
  if (!templateId) throw new RangeError('Unknown campaign template')
  // validateCriteria uses this same catalog ID to choose the settings schema.
  const selection = { id: templateId, settings: validateCriteria(templateId, criteria) } as Selection
  const { settings } = selection
  if (!calendarDay(scope.asOf) || !scope.countyFips.every(county => /^\d{5}$/.test(county))) {
    throw new RangeError('Invalid evaluation date or county FIPS')
  }
  const gaps = new Set<string>()
  if (!scope.eligibleSourceIds.length) gaps.add('No eligible sources selected.')
  if (!scope.countyFips.length) gaps.add('No counties selected.')
  const start = new Date(Date.parse(scope.asOf) - (settings.windowDays - 1) * dayMs).toISOString().slice(0, 10)
  const { selected, excludedInstruments } = selectRecords(records, scope, start, selection, gaps)
  let rows: LocatedRow[] = []
  switch (selection.id) {
    case 'land_buyer_discovery':
    case 'institutional_sfr_acquisition_research': {
      rows = buyers(selected, excludedInstruments, 'institutionType' in settings ? settings.institutionType : undefined,
        'minAcquisitions' in settings ? settings.minAcquisitions : 1, gaps)
      break
    }
    case 'builder_activity': {
      const role = selection.settings.participantRole
      const permits = kind(selected, 'permit').filter(({ facts: f }) => {
        if (!f.participantId || !f.participantRole || !f.jurisdiction || !f.permitNumber) {
          gaps.add('Some permits lack a qualified permit identity or named participant role.')
          return false
        }
        return role === 'any' || f.participantRole === role
      })
      for (const [id, sample] of group(permits, r => key(r.facts.participantId!, r.facts.participantRole!))) {
        const projects = sample.filter(r => r.facts.projectId)
        if (projects.length < sample.length) gaps.add('Some permits lack a confirmed project link.')
        rows.push(result(id, 'observed_permit_participant', sample, {
          participantId: sample[0].facts.participantId!, role: sample[0].facts.participantRole!,
          permitCount: new Set(sample.map(r => key(r.facts.jurisdiction, r.facts.permitNumber))).size,
          linkedProjectCount: projects.length ? new Set(projects.map(r => key(r.facts.jurisdiction, r.facts.projectId!))).size : null,
        }))
      }
      break
    }
    case 'permit_monitoring': {
      const status = selection.settings.status.toLowerCase()
      for (const r of kind(selected, 'permit')) {
        const f = r.facts
        if (!f.jurisdiction || !f.permitNumber) { gaps.add('Some permits lack a qualified permit identity.'); continue }
        if (!f.status) gaps.add('Normalized permit status is unavailable for some events.')
        if (status && ![f.rawStatus, f.status].some(s => s?.toLowerCase() === status)) continue
        rows.push(result(r.rowKey, 'permit_event', [r], {
          countyFips: r.countyFips, jurisdiction: f.jurisdiction, permitNumber: f.permitNumber, rawStatus: f.rawStatus ?? null,
          status: f.status ?? null, rawType: f.rawType ?? null, projectId: f.projectId ?? null,
          participantId: f.participantId ?? null, participantRole: f.participantRole ?? null,
        }))
      }
      break
    }
    case 'ownership_transfer_lookup': {
      const apn = selection.settings.apn
      for (const r of selected) {
        const f = r.facts
        if (f.kind !== 'ownership' && f.kind !== 'transfer') continue
        if (!f.apn) { gaps.add('Some observations lack a parcel link.'); continue }
        if (apn && f.apn !== apn) continue
        const values = { countyFips: r.countyFips, apn: f.apn }
        rows.push(f.kind === 'ownership'
          ? result(r.rowKey, 'dated_ownership_observation', [r], { ...values, ownerId: f.ownerId, basis: f.basis })
          : result(r.rowKey, 'recorded_transfer', [r], { ...values, instrumentId: f.instrumentId,
            granteeId: f.buyerId ?? null, relatedParty: f.relatedParty ?? null, nominal: f.nominal ?? null }))
      }
      break
    }
    case 'land_sfr_listing_watch': {
      rows = listings(selected, selection.settings.asset, start, false, gaps)
      break
    }
    case 'market_snapshot': {
      const { asset, supplyMonths } = selection.settings
      rows = listings(selected, asset, start, true, gaps)
      const metrics = kind(selected, 'market').filter(r => r.facts.asset === asset && r.facts.trailingMonths === supplyMonths)
      const covered = new Set<string>()
      for (const [id, history] of group(metrics, r => key(r.countyFips, r.sourceId, r.facts.seriesId))) {
        const latest = history.at(-1)!
        const claims = history.filter(r => r.date === latest.date && instant(r.observedAt) === instant(latest.observedAt))
        let conflict = false
        const agreed = <K extends 'activeInventory' | 'closedTransactions' | 'completeCoverage'>(field: K) => {
          const values = claims.map(r => r.facts[field]).filter(v => field === 'completeCoverage' || v != null)
          if (values.every(v => v === values[0])) return values[0] ?? null
          conflict = true
          return null
        }
        const activeInventory = agreed('activeInventory')
        const closedTransactions = agreed('closedTransactions')
        const completeCoverage = agreed('completeCoverage')
        const usable = completeCoverage === true && activeInventory !== null && Number.isSafeInteger(activeInventory)
          && activeInventory >= 0 && closedTransactions !== null && Number.isSafeInteger(closedTransactions) && closedTransactions > 0
        rows.push(result(id, 'publisher_market_snapshot', claims, { countyFips: latest.countyFips,
          asset, trailingMonths: supplyMonths, activeInventory, closedTransactions, completeCoverage,
          monthsOfSupply: usable ? activeInventory / (closedTransactions / supplyMonths) : null }))
        if (usable) covered.add(latest.countyFips)
        else if (conflict) gaps.add('Conflicting publisher figures prevent a supported months-of-supply estimate.')
        else gaps.add('A publisher sample lacks complete inventory, closing history or a positive closing denominator.')
      }
      for (const county of scope.countyFips) {
        if (!covered.has(county)) gaps.add(`Months of supply unavailable in county ${county} for the requested trailing period.`)
      }
      break
    }
    case 'contact_enrichment': {
      const role = selection.settings.role
      for (const r of kind(selected, 'contact').filter(r => r.facts.role === role)) {
        rows.push(result(r.rowKey, 'verified_public_business_channel', [r], {
          organizationId: r.facts.organizationId, role, channel: r.facts.channel, checkedOn: r.facts.checkedOn,
        }))
      }
      break
    }
    case 'source_gap_investigation': {
      const { requiredKind } = selection.settings
      const counties = group(selected, r => r.countyFips)
      for (const county of new Set(scope.countyFips)) {
        const sample = counties.get(county) ?? []
        rows.push(result(county, sample.length ? 'evidence_available' : 'coverage_gap', sample, {
          countyFips: county, requiredKind, observedRecords: sample.length,
          observedSources: new Set(sample.map(r => r.sourceId)).size,
        }))
      }
      break
    }
    case 'custom_research': {
      const { subjectId, recordKind } = selection.settings
      for (const r of selected) {
        if (subjectId && !subjectIds(r.facts).includes(subjectId)) continue
        rows.push(result(r.rowKey, 'supported_' + recordKind, [r], {
          countyFips: r.countyFips, subjectId: subjectId || subjectIds(r.facts)[0]!, recordKind,
          sourceId: r.sourceId, sourceRecordId: r.sourceRecordId, acceptance: r.acceptance, ...finding(r.facts),
        }))
      }
      break
    }
  }
  const countyMatches = new Set(rows.flatMap(r => r.counties))
  for (const county of scope.countyFips) {
    if (!countyMatches.has(county)) gaps.add(`No matching ${templateId} evidence in county ${county} within the selected window.`)
  }
  const rank = (r: TemplateRow) => Number(r.values.acquisitionCount ?? r.values.permitCount ?? 0)
  rows.sort((a, b) => rank(b) - rank(a) || compare(b.date ?? '', a.date ?? '')
    || (b.observationTime ?? 0) - (a.observationTime ?? 0) || compare(a.key, b.key))
  return { templateId, rows: rows.slice(0, settings.maxResults).map(({ counties, observationTime, ...row }) => row), matchedRows: rows.length, coverageGaps: [...gaps].sort() }
}
