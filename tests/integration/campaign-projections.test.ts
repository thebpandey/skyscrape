import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readPageResult, collectionPlan } from '../../apps/worker/src/municipal.ts'
import { latestDue } from '../../apps/worker/src/calendar.ts'
import type { TaskResult } from '../../packages/contracts/src/collection/index.ts'
import { csvCell, evidenceLocation } from '../../packages/db/src/run-results.ts'

test('CSV quotes delimiters and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell(' =1+1'), '"\' =1+1"')
  assert.equal(csvCell('a,"b"'), '"a,""b"""')
})

test('zero matches require a digest-verified empty array from the requested URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'empty-page-'))
  try {
    const artifactId = randomUUID().replaceAll('-', '')
    const source = { id: randomUUID(), versionId: randomUUID(), version: 1, name: 'Fixture', assessmentId: 'fixture',
      coverage: 'Synthetic', synthetic: true }
    const req = { runId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), offset: 0, bytes: 1024,
      asOf: "2026-11-21", windowDays: 3, remainingResults: 1, status: "Issued", countyFips: ["53033"], deadline: new Date(Date.now() + 5000), source }
    const result: TaskResult = { protocolVersion: 1, taskId: req.taskId, attemptId: req.attemptId, classification: 'failed',
      retrievedAt: new Date().toISOString(), engineVersion: 'fixture', redirects: [],
      finalUrl: collectionPlan(req).url, httpStatus: 200, responseMediaType: 'application/json',
      contentClassification: 'empty', error: { code: 'EMPTY_CONTENT', message: 'Empty', retryable: false,
        correlationId: req.runId, action: 'Read', outcome: 'Empty', nextAction: 'Review' },
      counters: { bytes: 2, requests: 1, quotaUnits: 1, browserSeconds: 0, costMicros: 0 }, evidence: [], observations: [] }
    assert.equal((await readPageResult(result, req, dir, dir)).kind, 'failed')
    await writeFile(join(dir, artifactId), '[]')
    result.evidence.push({ artifactId, mediaType: 'application/json', bytes: 2, sha256: createHash('sha256').update('[]').digest('hex') })
    const empty = await readPageResult(result, req, dir, dir)
    assert.ok(empty.kind === 'page' && empty.page.records.length === 0 && !empty.partialCode)
    assert.equal(empty.page.artifact.digest, result.evidence[0].sha256)
    const digest = empty.page.artifact.digest
    await assert.rejects(readFile(join(dir, digest)), { code: 'ENOENT' })
    const freshKey = digest + '.' + req.taskId
    await empty.page.artifact.promote(freshKey)
    assert.equal(await readFile(join(dir, freshKey), 'utf8'), '[]')
    await assert.rejects(readFile(join(dir, digest)), { code: 'ENOENT' })
    await writeFile(join(dir, artifactId), '  ')
    assert.equal((await readPageResult(result, req, dir, dir)).kind, 'failed')
    assert.throws(() => collectionPlan({ ...req, countyFips: ['48453'] }))
    assert.match(new URL(collectionPlan(req).url).searchParams.get('$where')!, /issueddate >= '2026-11-19'/)
    assert.match(new URL(collectionPlan(req).url).searchParams.get('$where')!, /lower\(statuscurrent\) = 'issued'/)
    const body = JSON.stringify([
      { permitnum: 'stale', statuscurrent: 'Issued', issueddate: '2026-10-01' },
      { permitnum: 'wrong-status', statuscurrent: 'Pending', issueddate: '2026-11-20' },
      { permitnum: 'match', statuscurrent: 'Issued', issueddate: '2026-11-20' },
      { permitnum: 'over-limit', statuscurrent: 'Issued', issueddate: '2026-11-19' },
    ])
    await writeFile(join(dir, artifactId), body)
    const success: TaskResult = { ...result, classification: 'success', finalUrl: collectionPlan(req).url,
      counters: { ...result.counters, bytes: body.length }, evidence: [{ ...result.evidence[0],
        bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }
    const matched = await readPageResult(success, req, dir, dir)
    assert.ok(matched.kind === 'page')
    assert.deepEqual(matched.page.records.map(row => row.permit.permitNumber), ['match'])
    assert.equal(matched.partialCode, 'RESULT_LIMIT')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

import { evaluateImported } from '../../packages/db/src/template-runs.ts'
import { templateCatalog } from '../../packages/domain/src/templates/index.ts'
import type { DatabasePool } from '../../packages/db/src/index.ts'

test('the run adapter routes every catalog template through a qualified source and evaluator', async () => {
  const samples = [
    { kind: 'transfer', instrumentId: 'A', buyerId: 'buyer', buyerType: 'fund', asset: 'vacant_land', apn: 'parcel' },
    { kind: 'transfer', instrumentId: 'B', buyerId: 'buyer', buyerType: 'fund', asset: 'single_family', apn: 'parcel' },
    { kind: 'permit', permitNumber: 'permit', jurisdiction: 'fixture', status: 'issued', participantRole: 'builder', participantId: 'builder' },
    { kind: 'listing', listingId: 'listing', asset: 'vacant_land', status: 'active' },
    { kind: 'contact', organizationId: 'buyer', role: 'acquisitions', channel: 'website', checkedOn: '2026-11-15',
      verifiedPublicBusiness: true, suppressed: false },
  ]
  const fixtures = samples.map((facts, index) => ({
    sourceId: facts.kind, sourceVersionId: facts.kind + '-v1', sourceRecordId: 'record' + index, evidenceIds: [randomUUID()], observedAt: '2026-11-15T12:00:00Z',
    eventDate: '2026-11-15', countyFips: '00000', synthetic: true, acceptance: 'verified', facts,
    grant: { sourceId: facts.kind, publisher: 'Fixture', sourceUrl: 'https://example.invalid', license: 'Synthetic',
      termsUrl: 'https://example.invalid/terms', attribution: 'Fixture', assessmentId: 'fixture',
      kind: facts.kind, allowedFields: Object.keys(facts), eligible: true, freeOnly: true },
  }))
  const db = { query: async (_sql: string, [, kinds]: [string[], string[]]) =>
    ({ rows: fixtures.filter(row => kinds.includes(row.facts.kind)) }) } as unknown as DatabasePool
  assert.equal(templateCatalog.length, 10)
  for (const template of templateCatalog) {
    const result = await evaluateImported(db, { title: 'Synthetic', template: template.id, geography: { countyFips: ['00000'] },
      assetTypes: template.id === 'land_buyer_discovery' ? ['vacant_land'] : [], requestedFields: ['countyFips'], sourcePolicy: { freeOnly: true, allowHostedFreeTiers: false },
      limits: { maxPages: 1, maxMinutes: 1, maxLlmCalls: 0 } }, '2026-11-21')
    assert.ok(result.rows.some(row => row.evidenceIds.length > 0), template.id)
    assert.equal(result.synthetic, true)
    if (template.id === 'land_buyer_discovery') {
      assert.equal(result.rows[0].values.contactability, 'verified_public_business')
      assert.ok(result.rows[0].evidenceIds.includes(fixtures[4].evidenceIds[0]))
    }
  }
})

test('coalescing a two-day outage keeps today’s occurrence within grace', () => {
  const due = latestDue({ mode: 'recurring', frequency: 'daily', timezone: 'UTC', localTime: '09:00' },
    new Date('2026-11-19T09:00Z'), new Date('2026-11-21T09:05Z'), 10)
  assert.equal(due.toISOString(), '2026-11-21T09:00:00.000Z')
})

test('Seattle citations identify one publisher row and select only cited columns', () => {
  const location = evidenceLocation('https://data.seattle.gov/resource/76t5-zqzr.json',
    'seattle-building-permits:record:TEST-1', ['rawStatus', 'issuedOn'], false)
  const url = new URL(location.sourceUrl!)
  assert.equal(url.searchParams.get('permitnum'), 'TEST-1')
  assert.equal(url.searchParams.get('$select'), 'permitnum,statuscurrent,issueddate')
  assert.deepEqual(location.fieldLocators, { rawStatus: 'statuscurrent', issuedOn: 'issueddate' })
  assert.equal(evidenceLocation('https://example.invalid/unassessed', 'row', ['apn'], false).sourceUrl, null)
})
