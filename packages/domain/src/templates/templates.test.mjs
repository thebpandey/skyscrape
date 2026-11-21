import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateTemplate, resolveTemplateId, templateCatalog, validateCriteria } from './index.ts'

// Synthetic normalized observations only. Source text and actual contact values stay outside the domain projection.
const scope = { asOf: '2026-11-15', countyFips: ['48001'], eligibleSourceIds: ['fixture'] }
function record(id, facts, extra = {}) {
  return { sourceId: 'fixture', sourceRecordId: id, evidenceIds: [id], acceptance: 'verified',
    countyFips: '48001', observedAt: '2026-11-12T10:00:00Z', eventDate: '2026-11-10', facts, ...extra }
}
function run(id, records, criteria = {}, overrides = {}) {
  return evaluateTemplate(id, criteria, records, { ...scope, ...overrides })
}
function transfer(id, buyerId, fields = {}, extra = {}) {
  return record(id, { kind: 'transfer', instrumentId: id, asset: 'vacant_land', buyerId, ...fields }, extra)
}
const permit = { kind: 'permit', jurisdiction: 'J', permitNumber: '001', projectId: 'P',
  participantId: 'builder', participantRole: 'builder', rawStatus: 'ISSUED', status: 'issued', rawType: 'electrical' }
const contact = { kind: 'contact', organizationId: 'B', role: 'acquisitions', channel: 'website',
  verifiedPublicBusiness: true, suppressed: false, checkedOn: '2026-11-13' }
const listing = { kind: 'listing', asset: 'vacant_land', listingId: 'L', status: 'active' }

test('all ten templates resolve legacy spellings, strictly validate their limits and report empty county coverage', () => {
  assert.equal(new Set(templateCatalog.map(t => t.id)).size, 10)
  for (const t of templateCatalog) {
    assert.equal(resolveTemplateId(t.title), t.id)
    for (const alias of t.aliases) assert.equal(resolveTemplateId(alias), t.id)
    const defaults = validateCriteria(t.id)
    assert.ok(defaults.windowDays > 0 && defaults.maxResults > 0)
    assert.throws(() => validateCriteria(t.id, { maxResults: 1001 }))
    assert.ok(run(t.id, []).coverageGaps.some(g => g.includes('48001')))
  }
  assert.equal(resolveTemplateId('unrecognized'), undefined)
  assert.throws(() => validateCriteria('unknown'))
  assert.throws(() => validateCriteria('builder_activity', { participantRole: 'grantee' }))
  assert.throws(() => validateCriteria('permit_monitoring', { freeOnly: false }))
  assert.throws(() => validateCriteria('market_snapshot', { asset: null }))
})

test('land buyers rank by distinct instruments after asset, date and county filters; contacts do not change activity dates', () => {
  const input = [transfer('one', 'A'), transfer('two', 'B'), transfer('three', 'B'),
    transfer('other-parcel', 'B', { instrumentId: 'two', apn: '009' }),
    transfer('related', 'A', { relatedParty: true }), transfer('home', 'A', { asset: 'single_family' }),
    transfer('old', 'A', {}, { eventDate: '2025-01-01' }), transfer('out', 'A', {}, { countyFips: '48003' }),
    record('channel', contact), record('trade', permit)]
  const actual = run('land_buyers', input, { maxResults: 1 })
  assert.deepEqual(actual, run('land_buyers', input.toReversed(), { maxResults: 1 }))
  assert.equal(actual.matchedRows, 2)
  assert.equal(actual.rows.length, 1)
  const [row] = actual.rows
  assert.equal(row.key, 'B')
  assert.equal(row.date, '2026-11-10')
  assert.equal(row.values.acquisitionCount, 2)
  assert.equal(row.values.contactability, 'verified_public_business')
  assert.deepEqual(row.evidenceIds, ['channel', 'other-parcel', 'three', 'two'])
  assert.equal(run('land_buyers', input, { minAcquisitions: 3 }).rows.length, 0)
})

test('institutional SFR research uses evidenced grantee type and excludes managers, land deals and unknown LLC types', () => {
  const home = { asset: 'single_family' }
  const rows = run('institutional_sfr', [transfer('a', 'fund', { ...home, buyerType: 'fund' }),
    transfer('b', 'manager', { ...home, buyerType: 'manager' }), transfer('c', 'LLC', home),
    transfer('d', 'other', { buyerType: 'fund' })], { institutionType: 'fund' }).rows
  assert.deepEqual(rows.map(r => [r.key, r.values.buyerTypes, r.values.contactability]), [['fund', 'fund', 'unknown']])
})

test('builder activity distinguishes named roles and counts separately evidenced permits and linked projects', () => {
  const records = [record('one', permit), record('two', { ...permit, permitNumber: '002' }),
    record('three', { ...permit, participantRole: 'contractor' })]
  const rows = run('builders', records, { participantRole: 'builder' }).rows
  assert.deepEqual(rows.map(r => [r.values.role, r.values.permitCount, r.values.linkedProjectCount]), [['builder', 2, 1]])
})

test('permit events retain source status, unknown normalization and the inclusive date boundary', () => {
  const row = record('one', { ...permit, rawStatus: 'Final / expired', status: undefined }, { eventDate: scope.asOf })
  const actual = run('permit_watch', [row, record('old', permit)], { status: 'FINAL / EXPIRED', windowDays: 1 })
  assert.deepEqual(actual.rows.map(r => [r.date, r.values.rawStatus, r.values.status, r.values.permitNumber]),
    [[scope.asOf, 'Final / expired', null, '001']])
  assert.ok(actual.coverageGaps.some(g => g.includes('status')))
})

test('parcel lookup preserves text APNs and separate dated assessor, deed and instrument evidence', () => {
  const owner = { kind: 'ownership', apn: '001', ownerId: 'A', basis: 'assessor' }
  const actual = run('ownership_lookup', [record('roll', owner), record('deed', { ...owner, ownerId: 'B', basis: 'deed' }),
    transfer('instrument', 'B', { apn: '001', nominal: false }), record('other', { ...owner, apn: '1' })], { apn: '001' })
  assert.deepEqual(actual.rows.map(r => r.values.basis ?? r.classification), ['deed', 'recorded_transfer', 'assessor'])
  assert.equal(actual.rows[1].values.nominal, false)
})

test('a reused assessor record preserves each effective date and its latest correction', () => {
  const roll = (eventDate, published, ownerId, citation) => record('roll', {
    kind: 'ownership', apn: '001', ownerId, basis: 'assessor',
  }, { eventDate, observedAt: published + 'T10:00:00Z', evidenceIds: [citation] })
  const records = [roll('2026-01-01', '2026-01-03', 'A', 'original'),
    roll('2026-10-01', '2026-10-03', 'B', 'october'), roll('2026-01-01', '2026-11-01', 'C', 'corrected')]
  const { rows } = run('ownership_lookup', records, { apn: '001' })
  assert.deepEqual(rows.map(r => [r.date, r.values.ownerId, r.evidenceIds]), [
    ['2026-10-01', 'B', ['october']], ['2026-01-01', 'C', ['corrected']],
  ])
})

test('listing watch compares only like prices and explicit statuses in a source-qualified episode', () => {
  const ask = { type: 'asking_cash', currency: 'USD', amount: 100 }
  const latest = record('second', { ...listing, status: 'pending', price: { ...ask, amount: 0 } }, { eventDate: scope.asOf })
  const runWatch = price => run('listing_watch', [latest,
    record('first', { ...listing, price }, { eventDate: '2026-11-14' })], { windowDays: 1 })
  const comparable = runWatch(ask)
  assert.equal(comparable.rows[0].values.priceChange, -100)
  assert.deepEqual(comparable.coverageGaps, [])
  const { rows: [row], coverageGaps } = runWatch({ ...ask, type: 'monthly_payment' })
  assert.equal(row.values.priceChange, null)
  assert.ok(coverageGaps.some(gap => gap.includes('asking_cash') && gap.includes('USD')))
  assert.equal(row.values.status, 'pending')
  assert.equal(row.values.statusChanged, true)
  assert.deepEqual(row.evidenceIds, ['first', 'second'])
})

test('market snapshot reconciles latest source episodes by segment and marks unavailable supply', () => {
  const actual = run('market_snapshot', [record('early', listing, { eventDate: '2026-10-01' }),
    record('late', { ...listing, status: 'sold' }), record('unknown', { ...listing, listingId: 'X', status: undefined }),
    record('sfr', { ...listing, listingId: 'S', asset: 'single_family' })])
  const [r] = actual.rows
  assert.deepEqual([r.values.sampleSize, r.values.active, r.values.sold, r.values.unknownStatus, r.values.monthsOfSupply],
    [2, 0, 1, 1, null])
  assert.deepEqual(r.evidenceIds, ['late', 'unknown'])
})

test('publisher market snapshots compute supply from a matching complete trailing cohort and keep missing distinct from zero', () => {
  const market = { kind: 'market', seriesId: 'series', asset: 'vacant_land', trailingMonths: 3, completeCoverage: true,
    activeInventory: 8, closedTransactions: 6 }
  const supply = patch => run('market_snapshot', [record('metric', { ...market, ...patch })]).rows[0]?.values.monthsOfSupply
  assert.equal(supply({}), 4)
  assert.equal(supply({ activeInventory: 0 }), 0)
  assert.equal(supply({ closedTransactions: 0 }), null)
  assert.equal(supply({ completeCoverage: false }), null)
  assert.equal(supply({ trailingMonths: 6 }), undefined)
})

test('complementary tables in one publisher revision support a cited supply estimate', () => {
  const table = (activeInventory, closedTransactions, citation) => record('report', {
    kind: 'market', seriesId: 'series', asset: 'vacant_land', trailingMonths: 3,
    completeCoverage: true, activeInventory, closedTransactions,
  }, { evidenceIds: [citation] })
  const { rows: [row], coverageGaps } = run('market_snapshot', [table(8, null, 'inventory'), table(null, 6, 'closings')])
  assert.deepEqual([row.values.activeInventory, row.values.closedTransactions, row.values.monthsOfSupply], [8, 6, 4])
  assert.deepEqual(row.evidenceIds, ['closings', 'inventory'])
  assert.deepEqual(coverageGaps, [])
})

test('a late publisher correction revises only its reporting period and market cohort', () => {
  const release = (eventDate, published, activeInventory, evidenceId, trailingMonths = 3) => record('monthly-report', {
    kind: 'market', seriesId: 'series', asset: 'vacant_land', trailingMonths,
    completeCoverage: true, activeInventory, closedTransactions: 6,
  }, { eventDate, observedAt: published + 'T10:00:00Z', evidenceIds: [evidenceId] })
  const september = release('2026-09-30', '2026-10-01', 12, 'sep')
  const october = release('2026-10-31', '2026-11-01', 8, 'oct')
  const correction = release('2026-09-30', '2026-11-02', 16, 'sep-corrected')
  const sixMonths = release('2026-10-31', '2026-11-03', 9, 'oct-six-month', 6)
  const snapshot = (records, supplyMonths = 3) => run('market_snapshot', records, { supplyMonths }).rows.map(row =>
    [row.date, row.values.monthsOfSupply, row.evidenceIds])
  assert.deepEqual(snapshot([correction, september, october]), [['2026-10-31', 4, ['oct']]])
  assert.deepEqual(snapshot([correction, september]), [['2026-09-30', 8, ['sep-corrected']]])
  const releases = [correction, sixMonths, september, october]
  assert.deepEqual(snapshot(releases), [['2026-10-31', 4, ['oct']]])
  assert.deepEqual(snapshot(releases, 6), [['2026-10-31', 9, ['oct-six-month']]])
})

test('contact enrichment and custom findings require current verified public, unsuppressed business evidence', () => {
  const records = [record('public', contact), record('withdrawn', contact),
    record('withdrawn', { ...contact, suppressed: true }, { observedAt: '2026-11-17T00:00:00Z' }),
    record('uncertain', { ...contact, verifiedPublicBusiness: false }),
    record('outdated', { ...contact, checkedOn: '2025-01-15' })]
  for (const [id, settings] of [['contacts', {}], ['custom', { recordKind: 'contact', subjectId: 'B' }]]) {
    const rows = run(id, records, settings).rows
    assert.deepEqual(rows.map(r => [r.evidenceIds, r.date, r.values.channel]), [[['public'], '2026-11-13', 'website']])
    assert.equal('value' in rows[0].values, false)
  }
})

test('source gaps report uncovered counties without implying zero market activity', () => {
  const r = run('source_gap', [record('in', permit), record('blocked', permit, { countyFips: '48003', sourceId: 'unqualified' })],
    { requiredKind: 'permit' }, { countyFips: ['48001', '48003'] })
  assert.deepEqual(r.rows.map(r => [r.key, r.classification, r.evidenceIds]), [
    ['48001', 'evidence_available', ['in']], ['48003', 'coverage_gap', []]])
  assert.ok(r.coverageGaps.some(g => g.includes('48003')))
})

test('custom research answers a scoped subject query and excludes unsupported, undated and future observations', () => {
  const owner = { kind: 'ownership', apn: '005', ownerId: 'A', basis: 'assessor' }
  const sample = record('supported', owner)
  const records = [sample, sample, record('other', { ...owner, apn: '5' }), record('permit', permit),
    record('future', owner, { observedAt: '2026-11-16T01:00:00Z' }), record('impossible', owner, { eventDate: '2026-09-31' }),
    record('undated', owner, { eventDate: null }), record('inferred', owner, { acceptance: 'inferred' }),
    record('uncited', owner, { evidenceIds: [] }), record('foreign', owner, { sourceId: 'blocked' })]
  const actual = run('custom', records, { recordKind: 'ownership', subjectId: '005' })
  assert.deepEqual(actual.rows.map(r => [r.values.namedOwner, r.values.basis, r.evidenceIds]), [['A', 'assessor', ['supported']]])
  assert.ok(actual.coverageGaps.some(g => g.includes('event date')))
  assert.ok(actual.coverageGaps.some(g => g.includes('accepted evidence')))
})

test('one source revision retains each parcel and permit role and supersedes the older revision', () => {
  const parcels = [transfer('deed', 'B', { apn: '002' }), transfer('deed', 'B', { apn: '001' }),
    transfer('deed', 'B', { apn: '003' }, { observedAt: '2026-11-01T00:00:00Z' })]
  const lookup = run('ownership_lookup', [...parcels, parcels[0]])
  assert.deepEqual(lookup.rows.map(r => r.values.apn).sort(), ['001', '002'])
  assert.equal(new Set(lookup.rows.map(r => r.key)).size, 2)
  assert.deepEqual(run('ownership_lookup', parcels.toReversed()), lookup)
  assert.equal(run('land_buyers', parcels).rows[0].values.acquisitionCount, 1)
  const roles = [record('one', permit), record('one', { ...permit, participantRole: 'applicant' })]
  assert.deepEqual(run('builders', roles).rows.map(r => r.values.role).sort(), ['applicant', 'builder'])
})

test('historical contact citations require the same currently verified organization, role and channel', () => {
  const email = { ...contact, channel: 'email' }
  const old = record('channel', email)
  for (const patch of [{ role: 'general_business' }, { organizationId: 'A' }, { channel: 'phone' }]) {
    const current = record('channel', { ...email, ...patch }, { observedAt: '2026-11-17T00:00:00Z' })
    assert.deepEqual(run('contacts', [old, current]).rows, [])
    assert.equal(run('land_buyers', [old, current, transfer('deed', 'B')]).rows[0].values.contactability, 'unknown')
  }
})

test('a one-day listing watch cites its preceding observation and omits episodes outside the window', () => {
  const ask = { amount: 100, currency: 'USD', type: 'asking_cash' }
  const before = record('prior', { ...listing, price: ask }, { eventDate: '2026-11-14' })
  const latest = record('today', { ...listing, price: { ...ask, amount: 90 }, status: 'pending' }, { eventDate: scope.asOf })
  const stale = record('old', { ...listing, listingId: 'old' })
  const { rows } = run('listing_watch', [latest, before, stale], { windowDays: 1 })
  assert.deepEqual(rows.map(r => [r.date, r.values.statusChanged, r.values.priceChange, r.evidenceIds]),
    [[scope.asOf, true, -10, ['prior', 'today']]])
})

function listingEvent(day, status, amount, type = 'asking_cash', currency = 'USD') {
  return record(day, { ...listing, status, price: { amount, type, currency } },
    { eventDate: day, observedAt: day + 'T10:00:00Z', evidenceIds: [day + '/' + type + '/' + currency] })
}

test('market snapshot cites the explicit status in the latest multi-quote event', () => {
  const day = scope.asOf
  const cash = listingEvent(day, 'active', 100)
  const installment = listingEvent(day, undefined, 7, 'monthly_payment')
  const snapshot = records => run('market_snapshot', records).rows[0]
  const row = snapshot([cash, installment])
  assert.deepEqual([row.values.sampleSize, row.values.active, row.values.unknownStatus], [1, 1, 0])
  assert.deepEqual(row.evidenceIds, cash.evidenceIds)
  const pending = listingEvent(day, 'pending', 7, 'monthly_payment')
  const conflict = snapshot([pending, cash])
  assert.deepEqual([conflict.values.active, conflict.values.pending, conflict.values.unknownStatus], [0, 0, 1])
  assert.deepEqual(conflict.evidenceIds, [...cash.evidenceIds, ...pending.evidenceIds])
})

test('listing watch pairs simultaneous price quotes by type and currency across source events', () => {
  const yesterday = '2026-11-14', today = scope.asOf
  const events = [listingEvent(yesterday, 'active', 100), listingEvent(yesterday, 'active', 7, 'monthly_payment'),
    listingEvent(today, 'pending', 90), listingEvent(today, 'pending', 5, 'monthly_payment'),
    listingEvent(today, 'pending', 120, 'asking_cash', 'CAD')]
  const watch = records => run('listing_watch', records, { windowDays: 1 })
  const actual = watch(events)
  assert.deepEqual(actual, watch(events.toReversed()))
  assert.deepEqual(actual.rows.map(r => [r.values.priceType, r.values.currency, r.values.priceChange,
    r.values.previousStatus, r.values.status]).sort(), [
    ['asking_cash', 'USD', -10, 'active', 'pending'], ['monthly_payment', 'USD', -2, 'active', 'pending']])
  assert.equal(actual.rows.filter(row => row.values.statusChanged === true).length, 1)
  for (const row of actual.rows) {
    assert.deepEqual(row.evidenceIds, [yesterday, today].map(day => day + '/' + row.values.priceType + '/USD'))
  }
  assert.equal(new Set(actual.rows.map(r => r.key)).size, 2)
})

test('listing watch reports each in-window transition with its original citations across an unchanged refresh', () => {
  const days = ['2026-11-12', '2026-11-13', '2026-11-14', scope.asOf]
  const events = [listingEvent(days[0], 'active', 100), listingEvent(days[1], 'pending', 90),
    listingEvent(days[2], 'pending', 90), listingEvent(days[3], 'sold', 80)]
  const watch = (records, asOf) => run('listing_watch', records, { windowDays: 2 }, { asOf }).rows
  const changed = watch(events, days[2])
  assert.deepEqual(changed.map(r => [r.date, r.values.statusChanged, r.values.priceChange, r.evidenceIds]),
    [[days[1], true, -10, days.slice(0, 2).map(d => d + '/asking_cash/USD')]])
  const both = run('listing_watch', events, { windowDays: 3 }).rows
  assert.deepEqual(both.map(r => [r.date, r.evidenceIds]), [[days[3], days.slice(2).map(d => d + '/asking_cash/USD')],
    [days[1], changed[0].evidenceIds]])
  assert.equal(new Set(both.map(r => r.key)).size, 2)
  const stable = run('listing_watch', events.slice(1, 3), { windowDays: 1 }, { asOf: days[2] }).rows
  assert.deepEqual(stable.map(r => [r.date, r.values.statusChanged, r.values.priceChange]), [[days[2], false, 0]])
  assert.equal(watch(events.slice(0, 1), days[0])[0].values.statusChanged, null)
})

test('listing watch returns the latest same-day transition under a one-row limit', () => {
  const morning = record('a', { ...listing, status: 'pending' },
    { eventDate: scope.asOf, observedAt: scope.asOf + 'T09:00:00Z' })
  const afternoon = record('z', { ...listing, status: 'sold' },
    { eventDate: scope.asOf, observedAt: scope.asOf + 'T15:00:00Z' })
  const result = run('listing_watch', [afternoon, record('baseline', listing), morning], { windowDays: 1, maxResults: 1 })
  assert.equal(result.matchedRows, 2)
  assert.deepEqual(result.rows.map(r => [r.values.previousStatus, r.values.status, r.evidenceIds]),
    [['pending', 'sold', ['a', 'z']]])
})

test('listing watch reports conflicting cash asks with both citations despite an unchanged monthly quote', () => {
  const prior = '2026-11-14'
  const events = [listingEvent(prior, 'active', 7, 'monthly_payment'), listingEvent(scope.asOf, 'active', 7, 'monthly_payment'),
    ...[90, 100].map(amount => ({ ...listingEvent(scope.asOf, 'active', amount), evidenceIds: ['cash-' + amount] }))]
  const result = run('listing_watch', events, { windowDays: 1 })
  const cash = result.rows.find(r => r.values.priceType === 'asking_cash')
  assert.ok(cash)
  assert.deepEqual([cash.values.currency, cash.values.amount, cash.values.priceChange], ['USD', null, null])
  assert.ok(['cash-90', 'cash-100'].every(id => cash.evidenceIds.includes(id)))
  assert.ok(result.coverageGaps.some(g => /conflict/i.test(g) && g.includes('asking_cash') && g.includes('USD')))
  assert.deepEqual(run('listing_watch', events.toReversed(), { windowDays: 1 }), result)
})

test('a first in-window listing observation survives an unchanged refresh and a later price cut', () => {
  const first = listingEvent('2026-11-14', 'active', 100)
  for (const amount of [100, 90]) {
    const refresh = listingEvent(scope.asOf, 'active', amount)
    const { rows } = run('listing_watch', [refresh, first], { windowDays: 2 })
    const observed = rows.at(-1)
    assert.deepEqual([observed.date, observed.values.status, observed.values.previousStatus, observed.values.priceChange,
      observed.evidenceIds], [first.eventDate, 'active', null, null, first.evidenceIds])
    assert.deepEqual(rows.map(r => r.values.priceChange), amount === 100 ? [null] : [-10, null])
  }
})

test('listing watch cites conflicting statuses separately from a supported cash price cut', () => {
  const before = listingEvent('2026-11-14', 'active', 100)
  const cash = listingEvent(scope.asOf, undefined, 90)
  const claims = ['active', 'pending'].map(status => record(scope.asOf, { ...listing, status },
    { eventDate: cash.eventDate, observedAt: cash.observedAt, evidenceIds: [status] }))
  const events = [before, cash, ...claims]
  const watch = records => run('listing_watch', records, { windowDays: 1 })
  const result = watch(events)
  const [row] = result.rows
  assert.deepEqual([row.values.status, row.values.statusChanged, row.values.priceChange], [null, null, -10])
  assert.deepEqual(row.evidenceIds, [...before.evidenceIds, ...cash.evidenceIds, 'active', 'pending'].sort())
  assert.ok(result.coverageGaps.some(gap => /conflicting.*status/i.test(gap)))
  assert.ok(!result.coverageGaps.some(gap => gap.includes('lack an explicit status')))
  assert.deepEqual(watch(events.toReversed()), result)
})

test('tied observations cannot establish a listing transition or a latest status by source ID', () => {
  for (const [first, second] of [['a', 'z'], ['z', 'a']]) {
    const events = [
      { ...listingEvent(scope.asOf, 'active', 100), sourceRecordId: first, evidenceIds: ['active-ask'] },
      { ...listingEvent(scope.asOf, 'pending', 90), sourceRecordId: second, evidenceIds: ['pending-ask'] },
    ]
    const watch = run('listing_watch', events)
    assert.deepEqual(watch.rows.map(r => [r.values.status, r.values.statusChanged, r.values.amount,
      r.values.priceChange, r.evidenceIds]), [[null, null, null, null, ['active-ask', 'pending-ask']]])
    const [snapshot] = run('market_snapshot', events).rows
    assert.deepEqual([snapshot.values.active, snapshot.values.pending, snapshot.values.unknownStatus,
      snapshot.evidenceIds], [0, 0, 1, ['active-ask', 'pending-ask']])
  }
})

test('reclassified listing observations stay in their own asset segment', () => {
  const land = listingEvent('2026-11-13', 'active', 100)
  const house = (day, status, amount) => {
    const observation = listingEvent(day, status, amount)
    return { ...observation, facts: { ...observation.facts, asset: 'single_family' } }
  }
  const home = house('2026-11-14', 'pending', 200)
  const sold = house(scope.asOf, 'sold', 190)
  const events = [sold, land, home]
  const rows = asset => run('listing_watch', events, { asset }).rows
  assert.deepEqual(rows('single_family').map(r => [r.values.asset, r.values.previousStatus, r.values.priceChange,
    r.evidenceIds]), [['single_family', 'pending', -10, [...home.evidenceIds, ...sold.evidenceIds]],
    ['single_family', null, null, home.evidenceIds]])
  assert.deepEqual(rows('vacant_land').map(r => r.evidenceIds), [land.evidenceIds])
  assert.deepEqual(rows('any').map(r => r.values.priceChange), [-10, null, null])
  assert.deepEqual(run('market_snapshot', events, { asset: 'vacant_land' }).rows, [])
})

test('a replacement email cannot reauthorize a withdrawn historical citation', () => {
  const email = { ...contact, channel: 'email' }
  const records = [record('directory', email, { evidenceIds: ['original'] }),
    record('directory', { ...email, suppressed: true }, { evidenceIds: ['withdrawal'], observedAt: '2026-11-16T00:00:00Z' }),
    record('directory', email, { evidenceIds: ['replacement'], observedAt: '2026-11-17T00:00:00Z' })]
  assert.deepEqual(run('contacts', records).rows, [])
  assert.deepEqual(run('contacts', records, {}, { asOf: '2026-11-17' }).rows.map(r => r.evidenceIds), [['replacement']])
})

test('tied publisher figures retain both citations and withhold disputed supply', () => {
  const market = { kind: 'market', seriesId: 'series', asset: 'vacant_land', trailingMonths: 3,
    completeCoverage: true, activeInventory: 8, closedTransactions: 6 }
  for (const counts of [[8, 12], [12, 8], [8, 8]]) {
    const records = counts.map((activeInventory, i) => record(String(i), { ...market, activeInventory }))
    const { rows: [row], coverageGaps } = run('market_snapshot', records)
    const disputed = counts[0] !== counts[1]
    assert.equal(row.values.monthsOfSupply, disputed ? null : 4)
    assert.equal(row.values.activeInventory, disputed ? null : 8)
    assert.equal(row.values.closedTransactions, 6)
    assert.deepEqual(row.evidenceIds, ['0', '1'])
    assert.equal(coverageGaps.some(g => /conflict/i.test(g)), disputed)
  }
})

test('buyer rankings exclude all parcels of a flagged instrument only in its recording county', () => {
  for (const [template, flag, asset] of [['land_buyers', 'relatedParty', 'vacant_land'],
    ['institutional_sfr', 'nominal', 'single_family']]) {
    const deed = { instrumentId: '001', asset, buyerType: 'fund' }
    const records = [transfer('flagged', 'B', { ...deed, apn: '1', [flag]: true }),
      transfer('sibling', 'B', { ...deed, apn: '2' }),
      transfer('eligible', 'B', deed, { countyFips: '48003' })]
    const { rows } = run(template, records, {}, { countyFips: ['48001', '48003'] })
    assert.deepEqual(rows.map(r => [r.values.acquisitionCount, r.evidenceIds]), [[1, ['eligible']]])
  }
})

test('accepted undated instrument flags exclude dated acquisitions in both buyer rankings', () => {
  for (const [template, asset, flag] of [['land_buyers', 'vacant_land', 'relatedParty'],
    ['institutional_sfr', 'single_family', 'nominal']]) {
    const deed = { instrumentId: '001', asset, buyerType: 'fund' }
    const metadata = { kind: 'transfer', instrumentId: '001', [flag]: true }
    const records = [transfer('parcel', 'B', deed), record('metadata', metadata, { eventDate: null }),
      transfer('eligible', 'B', deed, { countyFips: '48003' }),
      record('unverified', metadata, { eventDate: null, countyFips: '48003', acceptance: 'inferred' })]
    const { rows } = run(template, records, {}, { countyFips: ['48001', '48003'] })
    assert.deepEqual(rows.map(r => [r.values.acquisitionCount, r.evidenceIds]), [[1, ['eligible']]])
  }
})

test('status-only listing update retains the transition and reports the missing current cash quote', () => {
  const previous = listingEvent('2026-11-14', 'active', 100)
  const current = record('status-update', { ...listing, status: 'pending' }, { eventDate: scope.asOf })
  const { rows, coverageGaps } = run('listing_watch', [previous, current], { windowDays: 1 })
  assert.deepEqual(rows.map(r => [r.values.previousStatus, r.values.status, r.values.statusChanged,
    r.values.priceChange, r.evidenceIds]), [['active', 'pending', true, null, [...previous.evidenceIds, 'status-update']]])
  assert.ok(coverageGaps.some(gap => /current/i.test(gap) && gap.includes('asking_cash') && gap.includes('USD')))
})

test('a persistent listing ID keeps each dated event and only its latest revision', () => {
  const events = [
    listingEvent('2026-11-13', 'active', 100),
    listingEvent('2026-11-14', 'pending', 95),
    { ...listingEvent('2026-11-14', 'pending', 90), observedAt: '2026-11-14T12:00:00Z', evidenceIds: ['corrected'] },
    listingEvent(scope.asOf, 'sold', 80),
  ].map(r => ({ ...r, sourceRecordId: 'persistent' }))
  const { rows } = run('listing_watch', events.toReversed(), { windowDays: 2 })
  assert.deepEqual(rows.map(r => [r.date, r.values.previousStatus, r.values.status, r.values.priceChange, r.evidenceIds]), [
    [scope.asOf, 'pending', 'sold', -10, [...events[3].evidenceIds, 'corrected']],
    ['2026-11-14', 'active', 'pending', -10, [...events[0].evidenceIds, 'corrected']],
  ])
  assert.equal(new Set(rows.map(r => r.key)).size, 2)
})

test('a future deed flag affects both buyer rankings only from its event date', () => {
  for (const [template, asset, flag] of [['land_buyers', 'vacant_land', 'relatedParty'],
    ['institutional_sfr', 'single_family', 'nominal']]) {
    const future = '2026-11-16'
    const records = [transfer('parcel', 'B', { instrumentId: '001', asset, buyerType: 'fund' }),
      record('metadata', { kind: 'transfer', instrumentId: '001', [flag]: true }, { eventDate: future })]
    assert.deepEqual(run(template, records).rows.map(r => [r.values.acquisitionCount, r.evidenceIds]), [[1, ['parcel']]])
    assert.deepEqual(run(template, records, {}, { asOf: future }).rows, [])
  }
})

test('permit watch retains issuance and finalization and selects the corrected revision for each event date', () => {
  const event = (date, time, status, citation) => record('permit-001', { ...permit, status, rawStatus: status.toUpperCase() },
    { eventDate: date, observedAt: date + 'T' + time + 'Z', evidenceIds: [citation] })
  const records = [event(scope.asOf, '10:00:00', 'finalized', 'final'),
    event('2026-11-14', '11:00:00', 'issued', 'issue'), event('2026-11-14', '09:00:00', 'draft', 'prior')]
  const watch = status => run('permit_watch', records, { status, windowDays: 2 }).rows
  assert.deepEqual(watch('issued').map(r => [r.date, r.evidenceIds]), [['2026-11-14', ['issue']]])
  const rows = watch('')
  assert.deepEqual(rows.map(r => [r.values.status, r.evidenceIds]), [['finalized', ['final']], ['issued', ['issue']]])
  assert.equal(new Set(rows.map(r => r.key)).size, 2)
})

test('buyer rankings with a verified acquisitions channel have no coverage gaps', () => {
  for (const [template, asset] of [['land_buyers', 'vacant_land'], ['institutional_sfr', 'single_family']]) {
    const deed = transfer('purchase', 'B', { asset, buyerType: 'fund' })
    const result = run(template, [deed, record('channel', contact)])
    assert.deepEqual(result.rows.map(r => r.values.criteriaBasis), ['observed'])
    assert.deepEqual(result.coverageGaps, [])
    assert.ok(run(template, [deed]).coverageGaps.some(gap => gap.includes('contact')))
  }
})

test('an observed listing sample and complete publisher figures have no coverage gaps', () => {
  const market = { kind: 'market', seriesId: 'series', asset: 'vacant_land', trailingMonths: 3,
    completeCoverage: true, activeInventory: 8, closedTransactions: 6 }
  const sample = record('episode', listing)
  const result = run('market_snapshot', [sample, record('metric', market)])
  assert.deepEqual(result.rows.map(r => r.classification).sort(), ['observed_listing_sample', 'publisher_market_snapshot'])
  assert.deepEqual(result.coverageGaps, [])
  assert.ok(run('market_snapshot', [sample]).coverageGaps.some(gap => gap.includes('Months of supply')))
})
