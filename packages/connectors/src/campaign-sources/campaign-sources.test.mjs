import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { taskRequest, taskResult } from '../../../contracts/src/collection/index.ts'
import { evaluateTemplate } from '../../../domain/src/templates/index.ts'
import { buildMunicipalTask, readMunicipalPage, readVettedEvidence, censusSourceId, buildCensusTask, readCensusPage } from './index.ts'
import { AUSTIN_PERMITS_SOURCE_ID as austin, SEATTLE_PERMITS_SOURCE_ID as seattle } from '../municipal/index.ts'

// All records, IDs, grants and manifests in this file are synthetic.
const query = { asOf: '2026-11-21', countyFips: ['53033', '48453'], eligibleSourceIds: [austin, seattle, 'local', censusSourceId],
  kinds: ['permit', 'transfer', 'ownership', 'listing', 'contact', 'market'], limit: 20, windowDays: 365 }
const attempt = { runId: 'run', taskId: 'task', attemptId: 'first', correlationId: 'corr', deadline: '2026-11-21T11:00:00Z',
  assessmentId: 'assessment', byteLimit: 524288, allowedFields: ['permitnum', 'issueddate', 'permittypemapped', 'statuscurrent',
    'permitclass', 'project_id', 'permit_number', 'issue_date', 'permittype', 'status_current', 'permit_class'] }
const time = '2026-11-21T10:00:00Z'
function manifest(task, rows) {
  taskRequest.parse(task)
  const evidence = [{ artifactId: 'artifact', bytes: 100, mediaType: 'application/json', sha256: 'ab'.repeat(32) }]
  return taskResult.parse({ protocolVersion: 1, taskId: task.taskId, attemptId: task.attemptId,
    classification: 'success', finalUrl: task.url, httpStatus: 200, responseMediaType: 'application/json', redirects: [],
    retrievedAt: time, engineVersion: 'synthetic', counters: { ...task.limits, bytes: 100 }, evidence, contentClassification: 'expected',
    observations: rows.flatMap((row, i) => Object.entries(row).map(([field, original]) => ({
      artifactId: 'artifact', field, original, locator: '/' + i + '/' + field }))) })
}
const evidence = { evidenceId: () => 'verified-doc' }
test('Seattle projection reads approved fields, filters the page and feeds permit monitoring', () => {
  const q = { ...query, permitClass: 'Residential', permitType: 'Building', limit: 4 }
  const task = buildMunicipalTask(q, seattle, attempt)
  const params = new URL(task.url).searchParams
  assert.ok(params.get('$where').includes("issueddate >= '2025-11-22'"))
  assert.ok(params.get('$where').includes("permitclass = 'Residential'"))
  assert.equal(params.get('$limit'), '4')
  const row = { permitnum: 'P1', issueddate: query.asOf, statuscurrent: 'Issued', permittypemapped: 'Building', permitclass: 'Residential' }
  const result = manifest(task, [row, { ...row, permitclass: 'Commercial' }, { ...row, issueddate: '2025-11-21' }])
  const batch = readMunicipalPage(q, seattle, attempt, result, evidence)
  assert.equal(batch.records.length, 1)
  assert.equal(batch.records[0].countyFips, '53033')
  assert.equal(batch.provenance.license, 'Public domain')
  assert.deepEqual(batch.coverageGaps, [])
  assert.deepEqual(evaluateTemplate('permit_monitoring', {}, batch.records, q).rows[0].evidenceIds, ['verified-doc'])
  assert.equal(buildMunicipalTask(q, seattle, { ...attempt, allowedFields: ['permitnum'] }), null)
  assert.equal(buildMunicipalTask({ ...q, eligibleSourceIds: [] }, seattle, attempt), null)
  assert.throws(() => readMunicipalPage(q, seattle, attempt, { ...result, attemptId: 'other' }, evidence))
  assert.throws(() => readMunicipalPage(q, seattle, attempt, { ...result,
    observations: [{ ...result.observations[0], artifactId: 'other' }] }, evidence))
})
test('Austin needs a vetted county match and a durable evidence reference', () => {
  const task = buildMunicipalTask(query, austin, attempt)
  const result = manifest(task, [{ project_id: '123', permit_number: 'P1', issue_date: query.asOf, permittype: 'BP' }])
  assert.equal(readMunicipalPage(query, austin, attempt, result, evidence).records.length, 0)
  const context = { ...evidence, austinCounty: id => id.endsWith(':record:123') ? { countyFips: '48453', evidenceId: 'county-doc' } : undefined }
  const [permit] = readMunicipalPage(query, austin, attempt, result, context).records
  assert.equal(permit.facts.rawType, 'BP')
  assert.deepEqual(permit.evidenceIds, ['verified-doc', 'county-doc'])
  assert.equal(readMunicipalPage(query, austin, attempt, result, { ...context, evidenceId: () => undefined }).records.length, 0)
})
function local(facts, extra = {}) {
  return { countyFips: '53033', sourceId: 'local', sourceRecordId: 'record', evidenceIds: ['doc'],
    acceptance: 'verified', eventDate: query.asOf, observedAt: time, facts, ...extra }
}
function grant(facts) {
  return { sourceId: 'local', kind: facts.kind, publisher: 'Synthetic publisher', sourceUrl: 'https://example.org/synthetic',
    license: 'Synthetic test grant', termsUrl: 'https://example.org/terms', attribution: 'Synthetic publisher',
    assessmentId: 'assessment', eligible: true, freeOnly: true, allowedFields: Object.keys(facts), evidenceAllowed: (_, ref) => ref === 'doc' }
}
test('vetted deeds, ownership and listings project accepted fields and keep original rights', () => {
  for (const [facts, template] of [
    [{ kind: 'transfer', instrumentId: 'deed', buyerId: 'org', asset: 'vacant_land' }, 'land_buyer_discovery'],
    [{ kind: 'transfer', instrumentId: 'purchase', asset: 'single_family', buyerId: 'org', buyerType: 'fund' }, 'institutional_sfr_acquisition_research'],
    [{ kind: 'permit', jurisdiction: 'Synthetic City', permitNumber: 'P1', participantId: 'org', participantRole: 'builder' }, 'builder_activity'],
    [{ kind: 'market', seriesId: 'synthetic', asset: 'vacant_land', trailingMonths: 3, completeCoverage: true, activeInventory: 5, closedTransactions: 2 }, 'market_snapshot'],
    [{ kind: 'ownership', apn: 'APN1', ownerId: 'org', basis: 'deed' }, 'ownership_transfer_lookup'],
    [{ kind: 'listing', listingId: 'L1', asset: 'single_family', price: { amount: 100, currency: 'USD', type: 'down_payment' } }, 'land_sfr_listing_watch'],
  ]) {
    const policy = grant(facts)
    const batch = readVettedEvidence(query, policy, [local({ ...facts, confidentialNote: 'omit' })])
    assert.deepEqual(batch.records[0].facts, facts)
    assert.equal(batch.provenance.termsUrl, policy.termsUrl)
    assert.ok(evaluateTemplate(template, {}, batch.records, query).rows.length >= 1)
  }
})
test('buyer evaluation excludes restricted related-party and nominal deeds', () => {
  const facts = { kind: 'transfer', instrumentId: 'ordinary', buyerId: 'org', asset: 'vacant_land' }
  const rows = [local(facts), ...['relatedParty', 'nominal'].map(flag =>
    local({ ...facts, instrumentId: flag, [flag]: true }, { sourceRecordId: flag }))]
  const batch = readVettedEvidence(query, grant(facts), rows)
  const [buyer] = evaluateTemplate('land_buyer_discovery', {}, batch.records, query).rows
  assert.equal(buyer.values.acquisitionCount, 1)
  for (const record of batch.records) {
    assert.equal('relatedParty' in record.facts || 'nominal' in record.facts, false)
  }
})
test('asset-filtered acquisitions join verified evidence only to matched buyers', () => {
  const q = { ...query, asset: 'vacant_land', kinds: ['transfer', 'contact'] }
  const transfer = { kind: 'transfer', instrumentId: 'deed', buyerId: 'org', asset: 'vacant_land' }
  const contact = { kind: 'contact', organizationId: 'org', role: 'acquisitions', verifiedPublicBusiness: true,
    suppressed: false, channel: 'website', checkedOn: query.asOf }
  const deeds = readVettedEvidence(q, grant(transfer), [local(transfer),
    local({ ...transfer, asset: 'single_family', buyerId: 'other' }, { sourceRecordId: 'other' })])
  const refs = { ...grant(contact), evidenceAllowed: (id, ref) => ref === id }
  const contacts = readVettedEvidence(q, refs, ['org', 'other'].map(id =>
    local({ ...contact, organizationId: id }, { sourceRecordId: id, evidenceIds: [id] })))
  assert.equal(deeds.records.length, 1)
  const rows = evaluateTemplate('land_buyer_discovery', {}, [...deeds.records, ...contacts.records], q).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].values.contactability, 'verified_public_business')
  assert.deepEqual(rows[0].evidenceIds, ['doc', 'org'])
})
test('empty or filtered local evidence stays empty, and a bounded result keeps the newest matching row', () => {
  const facts = { kind: 'listing', listingId: 'L1', asset: 'single_family', status: 'active' }
  const policy = grant(facts)
  const q = { ...query, asset: 'single_family', limit: 1 }
  assert.deepEqual(readVettedEvidence(q, policy, []).records, [])
  const batch = readVettedEvidence(q, policy, [local(facts, { sourceRecordId: 'old', eventDate: '2026-10-05' }),
    local(facts, { sourceRecordId: 'outside', countyFips: '12001' }), local({ ...facts, asset: 'vacant_land' }, { sourceRecordId: 'land' }),
    local(facts, { sourceRecordId: 'expired', eventDate: '2025-01-11' }), local(facts)])
  assert.deepEqual(batch.records.map(r => r.sourceRecordId), ['record'])
  assert.equal(batch.coverageGaps.length, 1)
})
test('business verification emits metadata only and fails closed for withdrawn or unauthorized evidence', () => {
  const facts = { kind: 'contact', organizationId: 'org', role: 'acquisitions', verifiedPublicBusiness: true,
    suppressed: false, channel: 'website', checkedOn: query.asOf }
  const policy = grant(facts)
  const row = local({ ...facts, contactValue: 'omit' })
  assert.deepEqual(readVettedEvidence(query, policy, [row]).records[0].facts, facts)
  for (const invalid of [local({ ...facts, suppressed: true }), local({ ...facts, verifiedPublicBusiness: false }),
    local(facts, { evidenceIds: ['elsewhere'] }), local(facts, { acceptance: 'stale' })]) {
    assert.deepEqual(readVettedEvidence(query, policy, [invalid]).records, [])
  }
  assert.deepEqual(readVettedEvidence(query, { ...policy, freeOnly: false }, [row]).records, [])
  assert.deepEqual(readVettedEvidence(query, { ...policy, allowedFields: ['organizationId'] }, [row]).records, [])
  assert.throws(() => readVettedEvidence(query, policy, [row, local({ ...facts, suppressed: true })]))
})
test('Census reads the hash-verified release with the assessed layout and emits only county aggregates', () => {
  const headers = ['Year,State,County,Name,Units']
  const layout = { headers, surveyYear: 0, stateFips: 1, countyFips: 2, oneUnitUnitsIncludingImputation: 4 }
  const task = buildCensusTask(query, attempt, layout)
  const bytes = Buffer.from(headers[0] + '\r\n2025,53,033,"Synthetic, County",42\r\n2025,12,001,Other,1\r\n')
  const file = { artifactId: 'artifact', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/plain', bytes: bytes.length }
  const result = { ...manifest(task, [{ countyRow: '2025' }]), responseMediaType: 'text/plain', evidence: [file] }
  const promoted = { evidenceId: 'doc', bytes }
  const batch = readCensusPage(query, attempt, layout, result, promoted)
  assert.deepEqual(batch.records, [])
  assert.deepEqual(batch.aggregates, [{ countyFips: '53033', surveyYear: 2025, oneUnitUnitsIncludingImputation: 42, observedAt: time, evidenceId: 'doc' }])
  assert.deepEqual(batch.coverageGaps, ['County 48453 is absent from the Census release.'])
  assert.throws(() => readCensusPage(query, attempt, layout, result, { ...promoted, bytes: Buffer.from('unverified') }))
})

test('one-day listing watch compares the latest authorized event for the same episode', () => {
  const q = { ...query, windowDays: 1, asset: 'single_family' }
  const listing = { kind: 'listing', listingId: 'L1', asset: q.asset, status: 'active',
    price: { type: 'asking_cash', currency: 'USD', amount: 100 } }
  const policy = { ...grant(listing), evidenceAllowed: (id, ref) => id === ref && id !== 'withheld' }
  const prior = (id, instant, extra = {}) => local(listing, { sourceRecordId: id, evidenceIds: [id],
    eventDate: '2026-11-20', observedAt: instant, ...extra })
  const history = [
    prior('selected', '2026-11-20T10:00:00Z'),
    prior('alternate', '2026-11-20T10:00:00Z'),
    prior('z-earlier', '2026-11-20T11:00:00+02:00'),
    prior('older', time, { eventDate: '2026-11-19' }),
    prior('withheld', time), prior('other-county', time, { countyFips: '48453' }),
    prior('other-episode', time, { facts: { ...listing, listingId: 'L2' } }),
  ]
  const today = local({ ...listing, status: 'pending', price: { ...listing.price, amount: 90 } },
    { sourceRecordId: 'today', evidenceIds: ['today'] })
  const batch = readVettedEvidence(q, policy, [today, ...history])
  assert.deepEqual(batch.records.map(r => r.sourceRecordId), ['today', 'selected'])
  const rows = evaluateTemplate('land_sfr_listing_watch', { windowDays: 1 }, batch.records, q).rows
  assert.equal(rows.length, 1)
  const { previousStatus, status, statusChanged, priceType, currency, priceChange } = rows[0].values
  assert.deepEqual([previousStatus, status, statusChanged, priceType, currency, priceChange],
    ['active', 'pending', true, 'asking_cash', 'USD', -10])
  assert.deepEqual(rows[0].evidenceIds, ['selected', 'today'])
  assert.deepEqual(readVettedEvidence(q, policy, history).records, [])
  const bounded = readVettedEvidence({ ...q, limit: 1 }, policy, [today, history[0]])
  assert.deepEqual(bounded.records.map(r => r.sourceRecordId), ['today'])
  assert.deepEqual(bounded.coverageGaps, ['Local evidence result limit reached.'])
})

test('parcel lookup retains the cited deed and projects only permitted fields', () => {
  const q = { ...query, templateId: 'ownership_transfer_lookup' }
  const facts = { kind: 'transfer', instrumentId: 'deed', buyerId: 'org', apn: 'APN1', asset: 'vacant_land' }
  const input = [local({ ...facts, relatedParty: true, nominal: true })]
  const batch = readVettedEvidence(q, grant(facts), input)
  assert.deepEqual(batch.records.map(row => row.facts), [facts])
  const [deed] = evaluateTemplate(q.templateId, { apn: 'APN1' }, batch.records, q).rows
  assert.equal(deed.classification, 'recorded_transfer')
  assert.deepEqual(deed.values, { countyFips: '53033', apn: 'APN1', instrumentId: 'deed',
    granteeId: 'org', relatedParty: null, nominal: null })
  assert.deepEqual(deed.evidenceIds, ['doc'])
  const buyers = readVettedEvidence({ ...q, templateId: 'land_buyer_discovery' }, grant(facts), input)
  assert.deepEqual(buyers.records, [])
})

test('a capped listing watch reports the latest same-day status and cash ask', () => {
  const q = { ...query, windowDays: 1, limit: 1 }
  const facts = { kind: 'listing', listingId: 'L1', asset: 'single_family', status: 'active',
    price: { type: 'asking_cash', currency: 'USD', amount: 100 } }
  const batch = readVettedEvidence(q, grant(facts), [
    local(facts, { sourceRecordId: 'a', observedAt: '2026-11-21T11:00:00+02:00' }),
    local({ ...facts, status: 'pending', price: { ...facts.price, amount: 90 } }, { sourceRecordId: 'z' }),
  ])
  const [row] = evaluateTemplate('land_sfr_listing_watch', { windowDays: 1 }, batch.records, q).rows
  assert.deepEqual([row.values.status, row.values.amount], ['pending', 90])
  assert.deepEqual(batch.coverageGaps, ['Local evidence result limit reached.'])
})

test('custom transfer research cites the permitted deed without a restricted flag or false gap', () => {
  const q = { ...query, countyFips: ['53033'], templateId: 'custom_research', kinds: ['transfer'] }
  const facts = { kind: 'transfer', instrumentId: 'deed', buyerId: 'org', asset: 'single_family' }
  const input = [local({ ...facts, relatedParty: true })]
  const batch = readVettedEvidence(q, grant(facts), input)
  assert.deepEqual(batch.coverageGaps, [])
  assert.deepEqual(batch.records.map(row => row.facts), [facts])
  const result = evaluateTemplate(q.templateId, { recordKind: 'transfer', subjectId: 'deed' }, batch.records, q)
  assert.deepEqual(result.coverageGaps, [])
  assert.equal(result.rows[0].values.instrumentId, 'deed')
  assert.deepEqual(result.rows[0].evidenceIds, ['doc'])
  const institutional = readVettedEvidence({ ...q, templateId: 'institutional_sfr_acquisition_research' }, grant(facts), input)
  assert.deepEqual(institutional.records, [])
})
