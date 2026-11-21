import assert from 'node:assert/strict'
import { intake } from './intake.mjs'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { profiles, project, digest } from './profiles.mjs'

// Synthetic publisher-shaped values only. Never use this file with a real registry.
const sale = { row_id: '00001', pin: '00000000000001', doc_no: '00017', sale_date: '2025-01-01T00:00:00.000' }
const permit = { permit_si_no: '00002', borough: 'QUEENS', issuance_date: '2025-01-02', permit_type: 'EW', permit_status: 'ISSUED' }
const bytes = row => Buffer.from(JSON.stringify([row]))
const cli = (...args) => intake(args)

test('projects the published identifier, event and geography for each supported domain', () => {
  const [s] = project(profiles['cook-sales'], bytes(sale))
  assert.deepEqual([s.id, s.date, s.county, s.facts], ['00001', '2025-01-01', '17031',
    { kind: 'transfer', instrumentId: '00017', apn: '00000000000001' }])
  const [p] = project(profiles['nyc-permits'], bytes(permit))
  assert.deepEqual([p.county, p.facts.rawType, p.facts.permitNumber, p.facts.status], ['36081', 'EW', '00002', 'issued'])
})

test('rejects extra and shadowed contact fields, unknown geography and duplicate identity', () => {
  const p = profiles['nyc-permits']
  for (const b of [bytes({ ...permit, phone: 'SYNTHETIC' }), bytes({ ...permit, borough: 'UNKNOWN' }),
    Buffer.from(JSON.stringify([permit, permit])), Buffer.from(bytes(permit).toString().replace('{', '{"borough":"SYNTHETIC",'))])
    assert.throws(() => project(p, b))
})

test('inspect gives a reproducible receipt and import rejects a changed file before connecting', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'synthetic-intake-')), 'sale.json')
  writeFileSync(path, bytes(sale))
  const { sha256 } = await cli('inspect', 'cook-sales', path)
  assert.equal(sha256, digest(bytes(sale)))
  writeFileSync(path, bytes({ ...sale, doc_no: '00018' }))
  await assert.rejects(cli('import', 'cook-sales', path, '2025-01-02T00:00:00Z', sha256), /SHA-256/)
})

// The shell harness supplies the fresh container, migration and scratch directory.
if (process.env.INTAKE_TEST_CONTAINER) test('disposable DB: replay, revision history, proof, audit and withdrawal', async t => {
  const c = process.env.INTAKE_TEST_CONTAINER
  assert.match(c, /^template-intake-db-[0-9]+$/)
  const { openDatabase } = await import('../../packages/db/src/index.ts')
  const pool = openDatabase(process.env.MIGRATOR_DATABASE_URL)
  t.after(() => pool.end())
  const query = async sql => (await pool.query({ text: sql, rowMode: 'array' })).rows[0][0]
  const source = 'cook-sales'
  const path = join(process.env.TMPDIR, 'synthetic-db-sale.json')
  const save = (row, time) => {
    const b = bytes(row)
    writeFileSync(path, b)
    return cli('import', source, path, time, digest(b))
  }
  await cli('register', source)
  await cli('register', source)
  const fetched = '2025-01-02T00:00:00Z'
  const first = await save(sale, fetched)
  assert.equal(first.inserted, 1)
  assert.deepEqual(readFileSync(join(process.env.EVIDENCE_STORE_DIR, first.sha256)), bytes(sale))
  assert.equal((await save(sale, fetched)).unchanged, 1)
  const revised = { ...sale, doc_no: '00018' }
  writeFileSync(path, bytes(revised))
  await assert.rejects(cli('import', source, path, fetched, digest(bytes(revised))), /Conflicting revision/)
  assert.equal((await save(revised, '2025-01-03T00:00:00Z')).inserted, 1)
  assert.equal((await save(sale, fetched)).unchanged, 1)
  assert.equal(await query("SELECT facts->>'instrumentId' FROM eligible_campaign_inputs"), revised.doc_no)
  assert.equal(await query("SELECT count(*) FROM observations"), '2')
  assert.equal(await query("SELECT count(*) FROM audit_events WHERE action LIKE 'intake.%'"), '3')
  await cli('suppress', source)
  await cli('suppress', source)
  assert.equal(await query('SELECT count(*) FROM eligible_campaign_inputs'), '0')
  await assert.rejects(cli('register', source), /blocked/)
  await assert.rejects(cli('import', source, path, fetched, first.sha256), /blocked/)
  assert.equal(await query("SELECT count(*) FROM audit_events WHERE action='intake.blocked'"), '1')
})
