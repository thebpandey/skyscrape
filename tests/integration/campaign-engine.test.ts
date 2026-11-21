import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { buildApp } from '../../apps/server/src/app.ts'
import { createUser } from '../../apps/server/src/auth/index.ts'
import { nextOccurrences } from '../../apps/worker/src/calendar.ts'
import { recoverDeliveries } from '../../apps/worker/src/tasks.ts'
import { startWorker } from '../../apps/worker/src/main.ts'
import { createMunicipalAction } from '../../apps/worker/src/municipal.ts'
import { scheduleDue } from '../../apps/worker/src/scheduler.ts'
import { taskRequest } from '../../packages/contracts/src/collection/index.ts'
import type { TaskRequest } from '../../packages/contracts/src/collection/index.ts'
import { evaluateImported } from '../../packages/db/src/template-runs.ts'
import { migrate, openDatabase, transaction } from '../../packages/db/src/index.ts'

function localUrl(name: string) {
  const value = process.env[name]
  if (!value || new URL(value).hostname !== '127.0.0.1') throw Error('Use disposable loopback database URLs')
  return value
}
const pool = openDatabase(localUrl('DATABASE_URL'))
const authPool = openDatabase(localUrl('AUTH_DATABASE_URL'))
const adminPool = openDatabase(localUrl('ADMIN_DATABASE_URL'))
const migrator = openDatabase(localUrl('MIGRATOR_DATABASE_URL'))
const workerUrl = localUrl('WORKER_DATABASE_URL')
const workerDb = openDatabase(workerUrl)
const makeSecret = () => randomBytes(32).toString('hex')
const token = makeSecret()
const password = makeSecret()
const origin = 'https://synthetic-campaign.example.invalid'
const app = buildApp({ pool, authPool, adminPool, origin, authSecret: makeSecret(),
  keyPepper: makeSecret(), masterKey: randomBytes(32) })
const scratch = await mkdtemp(join(tmpdir(), 'campaign-'))
const socketPath = join(scratch, 'fixture.sock')
const stagingDir = join(scratch, 'staging')
const artifactDir = join(scratch, 'artifacts')
await mkdir(stagingDir)

const sourceId = randomUUID()
let clock = new Date()
type FixtureBehavior = 'page' | 'retry_once' | 'hold' | 'full' | 'empty'
let behavior: FixtureBehavior = 'page'
let submissions = 0
let cancellations = 0
let cancelFailuresLeft = 0
const attempts = new Map<string, { task: TaskRequest; fail: boolean; cancelled: boolean; behavior: FixtureBehavior }>()
const counters = (bytes: number) => ({ requests: 1, bytes, browserSeconds: 0, quotaUnits: 1, costMicros: 0 })
const fixtureRow = {
  permitnum: 'SYNTHETIC-PERMIT', issueddate: clock.toISOString().slice(0,10) + "T00:00:00.000",
  statuscurrent: 'Issued', permittypemapped: 'Building Permit', applieddate: '2026-01-01T00:00:00.000',
}

function respond(reply: ServerResponse, status: number, payload: object) {
  reply.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload))
}

async function fixture(req: IncomingMessage, reply: ServerResponse) {
  assert.equal(req.headers.authorization === `Bearer ${token}`, true)
  const path = new URL(req.url ?? '', 'http://synthetic.test')
  if (req.method === 'POST' && path.pathname === '/internal/v1/tasks') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const task = taskRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    assert.equal(task.mode, 'structured')
    assert.equal(task.limits.requests, 1)
    assert.equal(task.limits.costMicros, 0)
    assert.equal(task.permissions.assessmentId, 'synthetic-seattle-fixture')
    submissions++
    attempts.set(task.attemptId, { task, fail: behavior === 'retry_once', cancelled: false, behavior })
    if (behavior === 'retry_once') behavior = 'page'
    respond(reply, 202, { protocolVersion: 1, taskId: task.taskId, attemptId: task.attemptId, state: 'accepted' })
    return
  }
  const attempt = attempts.get(path.searchParams.get('attemptId') ?? '')
  if (!attempt) {
    respond(reply, 404, { code: 'UNKNOWN_TASK', message: 'Unknown synthetic attempt', retryable: true,
      correlationId: 'synthetic', action: 'Fixture lookup', outcome: 'No attempt', nextAction: 'Submit again' })
    return
  }
  const { task } = attempt
  const identity = { protocolVersion: 1, taskId: task.taskId, attemptId: task.attemptId }
  assert.equal(path.pathname.split('/')[4], task.taskId)
  if (path.pathname.endsWith('/cancel')) {
    if (cancelFailuresLeft > 0) {
      cancelFailuresLeft--
      respond(reply, 503, { code: 'COLLECTION_UNAVAILABLE', message: 'Synthetic interruption' })
      return
    }
    attempt.cancelled = true
    cancellations++
    respond(reply, 200, { ...identity, cancellation: 'requested' })
    return
  }
  if (attempt.behavior === 'hold') {
    respond(reply, 200, { ...identity, state: attempt.cancelled ? 'cancelled' : 'running', counters: counters(0) })
    return
  }
  const normal = { ...identity, finalUrl: task.url, retrievedAt: new Date().toISOString(), redirects: [],
    engineVersion: 'synthetic-fixture-v1' }
  if (attempt.fail) {
    respond(reply, 200, { protocolVersion: 1, state: 'finished', result: {
      ...normal, classification: 'failed', counters: counters(0), evidence: [], observations: [],
      error: { code: 'RATE_LIMITED', message: 'Synthetic retry', retryable: true, correlationId: task.correlationId,
        action: 'Synthetic collection', outcome: 'Retry scheduled', nextAction: 'Wait for retry' },
    } })
    return
  }

  const rows = attempt.behavior === 'full'
    ? Array.from({ length: 6 }, (_, index) => ({ ...fixtureRow, permitnum: `SYNTHETIC-FULL-${index}` }))
    : attempt.behavior === 'empty' ? [] : [fixtureRow]
  const body = Buffer.from(JSON.stringify(rows))
  const id = randomBytes(16).toString('hex')
  await writeFile(join(stagingDir, id), body, { mode: 0o600 })
  respond(reply, 200, { protocolVersion: 1, state: 'finished', result: {
    ...normal, ...(rows.length ? { classification: 'success' } : { classification: 'failed',
      error: { code: 'EMPTY_CONTENT', message: 'Empty', retryable: false, correlationId: task.correlationId,
        action: 'Read', outcome: 'Empty page', nextAction: 'Finish' } }), counters: counters(body.length), httpStatus: 200,
    responseMediaType: 'application/json', contentClassification: rows.length ? 'expected' : 'empty',
    evidence: [{ artifactId: id, sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length, mediaType: 'application/json' }],
    observations: rows.length ? [{ field: 'permitnum', original: rows[0].permitnum, locator: '/0/permitnum', artifactId: id }] : [],
  } })
}
const server = createServer((req, reply) => { void fixture(req, reply).catch(() => reply.writeHead(500).end()) })

let worker: Awaited<ReturnType<typeof startWorker>> | undefined
let cookie = ''
let viewerCookie = ''
let exportId: string
const draft = {
  title: 'Synthetic municipal campaign', template: 'permit_monitoring',
  geography: { countyFips: ['00000'] }, assetTypes: [] as string[],
  requestedFields: ['permitNumber', 'rawStatus'],
  sourcePolicy: { freeOnly: true as const, allowHostedFreeTiers: false },
  limits: { maxPages: 3, maxLlmCalls: 0, maxMinutes: 5 },
}

async function createRuntimeWorker() {
  const collector = await createMunicipalAction({ socketPath, token, stagingDir, artifactDir, synthetic: true, pollMs: 20 })
  return startWorker({ databaseUrl: workerUrl, collector, clock: () => clock, tickMs: 100 })
}

async function login(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin },
    payload: { email, password } })
  assert.equal(response.statusCode, 204)
  const session = response.cookies.find(entry => entry.name === '__Secure-better-auth.session_token')
  assert.ok(session?.secure)
  return `${session.name}=${session.value}`
}

before(async () => {
  await migrate(migrator)
  await transaction(migrator, async client => {
    await createUser(client, 'synthetic-campaign-analyst@example.invalid', password, 'analyst')
    await createUser(client, 'synthetic-campaign-viewer@example.invalid', password, 'viewer')
    await client.query("INSERT INTO sources(id,name) VALUES($1,'Synthetic Seattle fixture')", [sourceId])
    await client.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      VALUES($1,1,$2,'qualified','structured','Labeled synthetic only','Synthetic fixture')
    `, [sourceId, JSON.stringify({
      connector: 'seattle-building-permits', allowedFields: ['permitnum','issueddate','statuscurrent','permittypemapped','applieddate'], assessmentId: 'synthetic-seattle-fixture',
      countyFips: ['00000'], synthetic: true,
    })])
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve))
  cookie = await login('synthetic-campaign-analyst@example.invalid')
  viewerCookie = await login('synthetic-campaign-viewer@example.invalid')
})

after(async () => {
  await worker?.close()
  await app.close()
  await Promise.all([pool.end(), authPool.end(), adminPool.end(), migrator.end(), workerDb.end()])
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(scratch, { recursive: true, force: true })
})

function post(url: string, payload?: object, key?: string, who = cookie) {
  return app.inject({ method: 'POST', url: '/api/v1' + url, payload,
    headers: { origin, cookie: who, ...(key ? { 'idempotency-key': key } : {}) } })
}
async function createCampaign(payload = draft) {
  const result = await post('/campaigns', payload)
  assert.equal(result.statusCode, 201, result.body)
  return result.json<{ data: { id: string } }>().data.id
}
async function runCampaign(campaignId: string, key: string, version = 1) {
  const result = await post(`/campaigns/${campaignId}/runs`, { version }, key)
  assert.equal(result.statusCode, 202, result.body)
  return result.json<{ data: { runId: string } }>().data.runId
}
type Status = { state: string; counters: Record<string, number>; errorCode: string | null; synthetic: boolean }
async function runStatus(runId: string) {
  const result = await app.inject({ url: `/api/v1/runs/${runId}`, headers: { cookie } })
  assert.equal(result.statusCode, 200, result.body)
  return result.json<{ data: Status }>().data
}
async function awaitState(runId: string, state: string) {
  let latest: Status | undefined
  for (let attempt = 0; attempt < 200; attempt++) {
    latest = await runStatus(runId)
    if (latest.state === state) return latest
    await setTimeout(50)
  }
  throw Error(`Expected ${state}, observed ${latest?.state} (${latest?.errorCode ?? 'no error'})`)
}

test('authenticated campaign survives a pg-boss worker restart and deduplicates prior actions', async () => {
  assert.equal((await post('/campaigns', draft, undefined, viewerCookie)).statusCode, 403)
  const preview = await post('/campaigns/preview', { ...draft, requestedFields: [...draft.requestedFields, 'participantRole'] })
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal(preview.json().data.sources[0].synthetic, true)
  assert.deepEqual(preview.json().data.unsupportedFields, ['participantRole'])
  const [saved, replay] = await Promise.all([post('/campaigns', draft, 'save'), post('/campaigns', draft, 'save')])
  assert.equal(saved.statusCode, 201, saved.body)
  assert.equal(replay.statusCode, 201, replay.body)
  assert.deepEqual(replay.json().data, saved.json().data)
  assert.equal((await post('/campaigns', { ...draft, title: 'Different' }, 'save')).statusCode, 409)
  const id = saved.json().data.id
  assert.equal((await post(`/campaigns/${id}/runs`)).statusCode, 400)
  const [first, duplicate] = await Promise.all([runCampaign(id, 'synthetic-trigger'), runCampaign(id, 'synthetic-trigger')])
  assert.equal(first, duplicate)
  assert.equal((await post(`/campaigns/${id}/runs`, { version: 2 }, 'synthetic-trigger')).statusCode, 409)
  assert.equal((await app.inject({ url: `/api/v1/runs/${first}`, headers: { cookie: viewerCookie } })).statusCode, 404)

  behavior = 'retry_once'
  worker = await createRuntimeWorker()
  await awaitState(first, 'retry_wait')
  await worker.close()
  worker = undefined
  clock = new Date(clock.getTime() + 3500)
  worker = await createRuntimeWorker()
  const finished = await awaitState(first, 'completed')
  assert.equal(finished.synthetic, true)
  assert.equal(finished.counters.attempts, 2)
  assert.equal(finished.counters.observations, 1)
  assert.equal(submissions, 2)
  const events = await app.inject({ url: `/api/v1/runs/${first}/events`, headers: { cookie } })
  assert.match(String(events.headers['content-type']), /text\/event-stream/)
  assert.match(events.body, /event: run[\s\S]+"state":"completed"/)

  const result = await app.inject({ url: '/api/v1/records?permitNumber=SYNTHETIC-PERMIT', headers: { cookie } })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().data[0].rawStatus, 'Issued')
  assert.equal(result.json().data[0].issuedOn, fixtureRow.issueddate.slice(0,10))
  assert.equal(result.json().data[0].appliedOn, '2026-01-01')
  const proof = result.json().data[0].evidenceIds[0]
  assert.equal((await app.inject({ url: `/api/v1/evidence/${proof}`, headers: { cookie } })).json().data.eventDate, fixtureRow.issueddate.slice(0,10))
  const results = await app.inject({ url: `/api/v1/runs/${first}/results`, headers: { cookie } })
  assert.equal(results.statusCode, 200, results.body)
  assert.deepEqual(results.json().data, [{ resultId: proof, evidenceIds: [proof], classification: 'permit_event', date: fixtureRow.issueddate.slice(0,10), evidenceId: proof, recordId: result.json().data[0].id,
    fields: { permitNumber: 'SYNTHETIC-PERMIT', rawStatus: 'Issued' } }])
  const sampled = await post('/campaigns/preview', { ...draft, criteria: { status: 'Issued', maxResults: 1, windowDays: 1 } })
  assert.equal(sampled.statusCode, 200, sampled.body)
  assert.deepEqual(sampled.json().data.sample, [{ evidenceIds: [proof], fields: results.json().data[0].fields }])
  const created = await post(`/runs/${first}/exports`)
  assert.equal(created.statusCode, 201, created.body)
  const descriptor = created.json().data
  exportId = descriptor.id
  const download = await app.inject({ url: `/api/v1/exports/${exportId}/download`, headers: { cookie } })
  assert.equal(download.statusCode, 200)
  assert.equal(descriptor.rowCount, 1)
  assert.equal(createHash('sha256').update(download.rawPayload).digest('hex'), descriptor.sha256)
  assert.ok(download.body.includes(proof))
  assert.equal((await post(`/runs/${first}/exports`, undefined, undefined, viewerCookie)).statusCode, 403)
  assert.equal((await app.inject({ url: `/api/v1/exports/${exportId}/download`, headers: { cookie: viewerCookie } })).statusCode, 403)
  const { rows: [rights] } = await workerDb.query(`
    SELECT has_table_privilege('public.session','SELECT,INSERT,UPDATE,DELETE') AS session_access,
      has_table_privilege('public.source_versions','INSERT,UPDATE,DELETE') AS qualifies_sources,
      has_table_privilege('public.contacts','SELECT,INSERT,UPDATE,DELETE') AS raw_contact_access
  `)
  assert.deepEqual(rights, { session_access: false, qualifies_sources: false, raw_contact_access: false })
})

test('fresh empty retrieval retains separate proof after retention purges the first copy', async () => {
  const campaign = await createCampaign()
  behavior = 'empty'
  async function retrieve(key: string) {
    const run = await runCampaign(campaign, key)
    assert.equal((await awaitState(run, 'completed')).counters.observations, 0)
    const { rows: [artifact] } = await workerDb.query(`
      SELECT a.* FROM artifacts a JOIN retrieval_attempts r ON r.artifact_id=a.id
      JOIN run_tasks t ON t.id=r.task_id WHERE t.run_id=$1
    `, [run])
    assert.equal(await readFile(join(artifactDir, artifact.store_key), 'utf8'), '[]')
    return artifact
  }
  try {
    const mixed = await createCampaign({ ...draft, geography: { countyFips: ['00000', '48453'] } })
    const partial = await awaitState(await runCampaign(mixed, 'mixed-coverage'), 'partial')
    assert.equal(partial.counters.observations, 0)
    assert.equal(partial.errorCode, 'UNQUERIED_COUNTIES')
    const first = await retrieve('before-purge')
    await pool.query('UPDATE artifacts SET purged_at=now() WHERE id=$1', [first.id])
    await rm(join(artifactDir, first.store_key))
    const fresh = await retrieve('after-purge')
    assert.equal(fresh.sha256, first.sha256)
    assert.notEqual(fresh.id, first.id)
    assert.equal(fresh.purged_at, null)
    assert.ok((await workerDb.query('SELECT purged_at FROM artifacts WHERE id=$1', [first.id])).rows[0].purged_at)
    await assert.rejects(readFile(join(artifactDir, first.store_key)), { code: 'ENOENT' })
  } finally { behavior = 'page' }
})

test('an unclaimed expired delivery is requeued once and finishes with one linked observation', async () => {
  await worker!.close()
  worker = undefined
  const run = await runCampaign(await createCampaign(), 'lost-delivery')
  const { rows: [task] } = await workerDb.query('SELECT id FROM run_tasks WHERE run_id=$1', [run])
  // The job was taken before claim and its broker record expired during downtime.
  await workerDb.query("UPDATE outbox SET dispatched_at=$2 WHERE payload->>'taskId'=$1",
    [task.id, new Date(clock.getTime() - 180_000)])
  await Promise.all([recoverDeliveries(workerDb, clock), recoverDeliveries(workerDb, clock)])
  const { rowCount } = await workerDb.query("SELECT 1 FROM outbox WHERE payload->>'taskId'=$1 AND dispatched_at IS NULL", [task.id])
  assert.equal(rowCount, 1)
  worker = await createRuntimeWorker()
  const completed = await awaitState(run, 'completed')
  assert.equal(completed.counters.attempts, 1)
  assert.equal(completed.counters.observations, 1)
})

test('saved campaigns are owner-visible, newest first and cursor paged', async () => {
  const older = await createCampaign()
  const newer = await createCampaign()
  const page = (query: string, session = cookie) => app.inject({ url: '/api/v1/campaigns' + query, headers: { cookie: session } })
  const first = await page('?limit=1')
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json().data, [{ id: newer, title: draft.title, template: draft.template, version: 1, state: 'draft' }])
  assert.equal(first.json().meta.nextCursor, newer)
  assert.equal((await page('?limit=1&after=' + newer)).json().data[0].id, older)
  assert.deepEqual((await page('', viewerCookie)).json().data, [])
  assert.equal((await page('?limit=201')).statusCode, 400)
})

test('calendar skips DST gaps and repeated time and a scheduled launch is unique across workers', async () => {
  const iso = (dates: Date[]) => dates.map(date => date.toISOString())
  const daily = { mode: 'recurring', frequency: 'daily', timezone: 'America/Chicago', localTime: '02:30' } as const
  assert.deepEqual(iso(nextOccurrences(daily, new Date('2027-03-13T09:00:00Z'), 1)), ['2027-03-15T07:30:00.000Z'])
  assert.deepEqual(iso(nextOccurrences({ ...daily, localTime: '01:30' }, new Date('2027-11-07T06:30:00Z'), 1)), [
    '2027-11-08T07:30:00.000Z',
  ])
  assert.deepEqual(iso(nextOccurrences({ mode: 'recurring', frequency: 'monthly', timezone: daily.timezone,
    dayOfMonth: 31, localTime: '08:00' }, new Date('2027-01-31T16:00:00Z'), 1)), ['2027-03-31T13:00:00.000Z'])

  const id = await createCampaign()
  const due = new Date(clock.getTime() + 1000)
  const timing = { mode: 'once', timezone: 'UTC', scheduledFor: due.toISOString() }
  const activate = (version: number) => post(`/campaigns/${id}/schedule`, { timing, version })
  const schedule = await activate(1)
  assert.equal(schedule.statusCode, 200, schedule.body)
  assert.equal((await activate(1)).json().error.code, 'VERSION_CONFLICT')
  assert.equal((await activate(schedule.json().data.version)).json().error.code, 'ACTIVE_SCHEDULE')
  const scheduleId = schedule.json().data.id
  const patch = () => app.inject({ method: 'PATCH', url: '/api/v1/campaigns/' + id, headers: { origin, cookie },
    payload: { version: schedule.json().data.version, draft } })
  const rejected = await patch()
  assert.equal(rejected.statusCode, 409)
  assert.equal(rejected.json().error.code, 'ACTIVE_SCHEDULE')
  const pause = await post(`/campaigns/${id}/pause`)
  assert.equal(pause.statusCode, 200, pause.body)
  const edited = await patch()
  assert.equal(edited.statusCode, 200)
  assert.equal((await activate(schedule.json().data.version)).json().error.code, 'VERSION_CONFLICT')
  clock = new Date(due.getTime() + 500)
  await scheduleDue(workerDb, clock)
  assert.equal((await workerDb.query('SELECT id FROM occurrences WHERE schedule_id=$1', [scheduleId])).rowCount, 0)
  assert.equal((await post(`/campaigns/${id}/resume`)).statusCode, 200)
  await Promise.all([scheduleDue(workerDb, clock), scheduleDue(workerDb, clock)])
  const { rows } = await workerDb.query<{ run_id: string; disposition: string }>(
    'SELECT run_id,disposition FROM occurrences WHERE schedule_id=$1', [scheduleId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].disposition, 'launched')
  await awaitState(rows[0].run_id, 'completed')
  const detail = await app.inject({ url: '/api/v1/campaigns/' + id, headers: { cookie } })
  assert.equal(detail.json().data.state, 'draft')
  const editedAgain = await app.inject({ method: 'PATCH', url: '/api/v1/campaigns/' + id, headers: { origin, cookie },
    payload: { version: edited.json().data.version, draft } })
  assert.equal(editedAgain.statusCode, 200)
  const history = await app.inject({ url: '/api/v1/campaigns/' + id + '/runs', headers: { cookie } })
  assert.deepEqual(history.json().data.map((row: { id: string }) => row.id), [rows[0].run_id])
  const { rows: [observations] } = await workerDb.query('SELECT count(*)::int AS count FROM observations WHERE source_id=$1', [sourceId])
  assert.equal(observations.count, 1)
})

test('resumed one-shot overlap uses its original occurrence and misfire grace', async () => {
  await worker?.close()
  worker = undefined
  try {
    for (const graceMinutes of [2, 0]) {
      const id = await createCampaign()
      const blocker = await runCampaign(id, 'instant-overlap')
      const due = new Date(+clock + 1_000)
      const activated = await post(`/campaigns/${id}/schedule`, { version: 1, overlap: 'queue_one',
        timing: { mode: 'once', timezone: 'UTC', scheduledFor: due.toISOString() },
        misfire: { policy: 'coalesce', graceMinutes } })
      assert.equal(activated.statusCode, 200, activated.body)
      const occurrence = async () => (await workerDb.query(
        'SELECT id,disposition,run_id FROM occurrences WHERE schedule_id=$1', [activated.json().data.id])).rows
      await scheduleDue(workerDb, due)
      const [waiting] = await occurrence()
      assert.equal(waiting.disposition, 'waiting_overlap')
      assert.equal((await post(`/campaigns/${id}/pause`)).statusCode, 200)
      assert.equal((await post(`/runs/${blocker}/cancel`)).statusCode, 202)
      assert.equal((await post(`/campaigns/${id}/resume`)).statusCode, 200)
      const resumed = new Date(+due + 60_000)
      await Promise.all([scheduleDue(workerDb, resumed), scheduleDue(workerDb, resumed)])
      const rows = await occurrence()
      assert.deepEqual(rows.map(row => [row.id, row.disposition]), [[waiting.id, graceMinutes ? 'launched' : 'missed']])
      assert.equal(Boolean(rows[0].run_id), Boolean(graceMinutes))
      if (rows[0].run_id) await post(`/runs/${rows[0].run_id}/cancel`)
    }
  } finally { worker = await createRuntimeWorker() }
})

test('cancellation reaches the active attempt and exhausted page budget preserves accepted evidence', async () => {
  behavior = 'hold'
  const pending = await runCampaign(await createCampaign(), 'synthetic-cancel')
  await awaitState(pending, 'running')
  for (let attempt = 0; attempt < 100 && ![...attempts.values()].some(entry => entry.task.runId === pending); attempt++) {
    await setTimeout(20)
  }
  // Interrupt the active worker and then its first recovery attempt.
  cancelFailuresLeft = 2
  const cancel = await post(`/runs/${pending}/cancel`)
  assert.equal(cancel.statusCode, 202)
  for (const remaining of [1, 0]) {
    for (let i = 0; i < 200 && cancelFailuresLeft > remaining; i++) await setTimeout(50)
    assert.equal(cancelFailuresLeft, remaining)
    assert.equal((await runStatus(pending)).state, 'cancelling')
    clock = new Date(clock.getTime() + 31_000)
  }
  await awaitState(pending, 'cancelled')
  assert.ok([...attempts.values()].some(entry => entry.task.runId === pending && entry.cancelled))
  assert.ok(cancellations >= 1)
  assert.equal((await workerDb.query('SELECT 1 FROM run_observations WHERE run_id=$1', [pending])).rowCount, 0)

  await worker?.close()
  worker = undefined
  const child = spawn(process.execPath, ['apps/worker/src/main.ts'], {
    stdio: 'ignore',
    env: { ...process.env, COLLECTION_SYNTHETIC: '1', COLLECTION_SOCKET_PATH: socketPath,
      COLLECTION_TOKEN: token, COLLECTION_STAGING_DIR: stagingDir, EVIDENCE_STORE_DIR: artifactDir },
  })
  const exited = once(child, 'exit')
  try {
    behavior = 'full'
    const onlyOne = await createCampaign({ ...draft, limits: { ...draft.limits, maxPages: 1 } })
    const budgeted = await runCampaign(onlyOne, 'synthetic-budget')
    const partial = await awaitState(budgeted, 'partial')
    assert.equal(partial.errorCode, 'BUDGET_EXHAUSTED')
    assert.equal(partial.counters.attempts, 1)
    assert.equal(partial.counters.observations, 6)
    assert.equal((await post(`/runs/${budgeted}/retry`, undefined, 'no-more-budget')).statusCode, 409)

    const priorExport = await post(`/runs/${budgeted}/exports`)
    assert.equal(priorExport.statusCode, 201, priorExport.body)
    const original = priorExport.json().data
    assert.equal(original.rowCount, 6)
    // Persist the additional observation exactly as a successful retried page does.
    await migrator.query(`INSERT INTO run_observations(run_id,observation_id)
      SELECT $1,l.observation_id FROM run_observations l JOIN exports e ON e.run_id=l.run_id WHERE e.id=$2`, [budgeted,exportId])
    const enlarged = await post(`/runs/${budgeted}/exports`)
    assert.equal(enlarged.json().data.rowCount, 7)
    const pinned = await app.inject({ url: `/api/v1/exports/${original.id}/download`, headers: { cookie } })
    assert.equal(pinned.statusCode, 200)
    assert.equal(createHash('sha256').update(pinned.rawPayload).digest('hex'), original.sha256)

    behavior = 'hold'
    const revoked = await runCampaign(await createCampaign(), 'synthetic-revoke')
    await awaitState(revoked, 'running')
    for (let attempt = 0; attempt < 100 && ![...attempts.values()].some(entry => entry.task.runId === revoked); attempt++) {
      await setTimeout(20)
    }
    await migrator.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      VALUES($1,2,'{}','blocked','structured','Labeled synthetic only','Synthetic qualification withdrawn')
    `, [sourceId])
    assert.equal((await app.inject({ url: `/api/v1/exports/${exportId}/download`, headers: { cookie } })).statusCode, 409)
    const denied = await awaitState(revoked, 'failed')
    assert.equal(denied.errorCode, 'SOURCE_POLICY_CHANGED')
    assert.ok([...attempts.values()].some(entry => entry.task.runId === revoked && entry.cancelled))
    await migrator.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      SELECT source_id,3,jsonb_set(manifest,'{allowedFields}',(manifest->'allowedFields')-'statuscurrent'-'issueddate'),
        'qualified',method,coverage,'Synthetic field withdrawal' FROM source_versions WHERE source_id=$1 AND version=1
    `, [sourceId])
    const { rows: [old] } = await pool.query('SELECT run_id FROM exports WHERE id=$1', [exportId])
    const read = (path: string) => app.inject({ url: '/api/v1' + path, headers: { cookie } })
    const [row] = (await read(`/runs/${old.run_id}/results`)).json().data
    assert.deepEqual(row.fields, { permitNumber: fixtureRow.permitnum })
    const proof = (await read(`/runs/${old.run_id}/evidence/${row.evidenceId}`)).json().data
    assert.ok(proof.fieldLocators.permitNumber)
    assert.equal(proof.fieldLocators.rawStatus, undefined)
    assert.equal(proof.fieldLocators.status, undefined)
    const evidence = await read(`/evidence/${row.evidenceId}`)
    assert.equal(evidence.statusCode, 200)
    assert.equal(evidence.json().data.eventDate, null)
    assert.equal((await read(`/exports/${exportId}/download`)).statusCode, 409)
    await migrator.query(`INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      SELECT source_id,4,jsonb_set(manifest,'{countyFips}','["00001"]'),'qualified',method,coverage,'County withdrawn'
      FROM source_versions WHERE source_id=$1 AND version=1`, [sourceId])
    assert.deepEqual((await read(`/runs/${old.run_id}/results`)).json().data, [])
    assert.equal((await read(`/evidence/${row.evidenceId}`)).statusCode, 404)
    assert.equal((await read(`/runs/${old.run_id}/evidence/${row.evidenceId}`)).statusCode, 404)
    assert.equal((await read(`/exports/${exportId}/download`)).statusCode, 409)
  } finally {
    child.kill('SIGTERM')
    const [code] = await exited
    assert.equal(code, 0)
  }
})

test('a vetted local transfer produces a cited run and a qualified private CSV', async () => {
  const source = randomUUID()
  const observation = randomUUID()
  const facts = { kind: 'transfer', buyerId: randomUUID(), instrumentId: 'synthetic-instrument',
    asset: 'vacant_land', apn: 'synthetic-parcel' }
  await transaction(migrator, async client => {
    await client.query("INSERT INTO sources(id,name) VALUES($1,'Synthetic transfer register')", [source])
    const grant = { publisher: 'Synthetic', sourceUrl: 'https://example.invalid/data', termsUrl: 'https://example.invalid/terms',
      attribution: 'Synthetic', license: 'Synthetic only', assessmentId: 'fixture', freeOnly: true, kind: 'transfer',
      allowedFields: [...Object.keys(facts), 'relatedParty', 'nominal'] }
    const { rows: [version] } = await client.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      VALUES($1,1,$2,'qualified','import','Synthetic county','Synthetic fixture') RETURNING id
    `, [source, JSON.stringify({ synthetic: true, countyFips: ['00000'], campaignImport: grant })])
    const { rows: [artifact] } = await client.query(`
      INSERT INTO artifacts(sha256,store_key,mime,size_bytes,access_class) VALUES($1,$1,'application/json',2,'restricted') RETURNING id
    `, [createHash('sha256').update('{}').digest('hex')])
    await client.query(`
      INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,event_date,fetched_at,artifact_id,extractor_version)
      VALUES($1,$2,$3,'synthetic-instrument',repeat('a',64),current_date-1,current_date-interval '1 day',$4,'fixture')
    `, [observation,source,version.id,artifact.id])
    await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,NULL)", [observation,JSON.stringify(facts)])
  })
  const request = { ...draft, template: 'ownership_transfer_lookup', criteria: { apn: facts.apn }, requestedFields: ['apn'] }
  const preview = await post('/campaigns/preview', request)
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal(preview.json().data.sources[0].id, source)
  const campaign = await createCampaign(request)
  const run = await runCampaign(campaign, 'imported')
  assert.equal((await runStatus(run)).state, 'completed')
  const read = (suffix: string) => app.inject({ url: '/api/v1' + suffix, headers: { cookie } })
  const result = await read(`/runs/${run}/results`)
  assert.equal(result.json().data[0].fields.apn, facts.apn)
  assert.deepEqual(result.json().data[0].evidenceIds, [observation])
  assert.equal((await read(`/runs/${run}/evidence/${observation}`)).statusCode, 200)
  const created = await post(`/runs/${run}/exports`)
  assert.equal(created.statusCode, 201, created.body)
  const download = await read(`/exports/${created.json().data.id}/download`)
  assert.equal(download.statusCode, 200)
  assert.ok(download.body.includes(facts.apn) && download.body.includes(observation))
  const dateRun = await runCampaign(await createCampaign({ ...request, requestedFields: ['date','apn'] }), 'export-date')
  const dateExport = (await post(`/runs/${dateRun}/exports`)).json().data.id
  const dateDownload = await read(`/exports/${dateExport}/download`)
  assert.equal(dateDownload.statusCode, 200, dateDownload.body)
  const [header, data] = dateDownload.body.trimEnd().split('\r\n').map(line => line.slice(1,-1).split('","'))
  assert.deepEqual(header, ['evidenceIds','recordId','classification','date','apn'])
  assert.equal(data[3], result.json().data[0].date)
  await migrator.query("UPDATE exports SET filters=jsonb_set(filters,'{sha256}','\"mismatch\"') WHERE id=$1", [dateExport])
  assert.equal((await read(`/exports/${dateExport}/download`)).statusCode, 409)
  const audit = await migrator.query(`
    SELECT actor_id=requester_id AS requester_matches FROM audit_events JOIN exports ON subject_id=exports.id
    WHERE subject_id=$1 AND action='export.downloaded'`, [dateExport])
  assert.deepEqual(audit.rows, [{ requester_matches: true }])
  const revision = randomUUID()
  await transaction(migrator, async client => {
    await client.query(`
      INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,event_date,fetched_at,artifact_id,extractor_version)
      SELECT $1,source_id,source_version_id,source_record_id,repeat('b',64),event_date,clock_timestamp(),artifact_id,extractor_version
      FROM observations WHERE id=$2
    `, [revision, observation])
    await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,NULL)", [revision,JSON.stringify(facts)])
  })
  const priorDay = new Date(Date.now() - 86400000).toISOString().slice(0,10)
  const asOf = await evaluateImported(pool, request, priorDay)
  assert.deepEqual(asOf.rows.map(row => row.evidenceIds), [[observation]])
  const newer = await runCampaign(campaign, 'new-revision')
  assert.deepEqual((await read(`/runs/${newer}/results`)).json().data[0].evidenceIds, [revision])
  assert.equal((await read(`/runs/${run}/evidence/${observation}`)).statusCode, 200)
  const history = await read(`/campaigns/${campaign}/runs`)
  assert.deepEqual(history.json().data.map((row: { id: string }) => row.id), [newer, run])
  assert.equal(history.json().data[0].state, 'completed')
  assert.ok(Number.isFinite(Date.parse(history.json().data[0].createdAt)))
  assert.equal((await app.inject({ url: `/api/v1/campaigns/${campaign}/runs`, headers: { cookie: viewerCookie } })).statusCode, 404)
  const historical = await read(`/exports/${created.json().data.id}/download`)
  assert.equal(historical.statusCode, 200)
  assert.deepEqual(historical.rawPayload, download.rawPayload)
  const contactProof = randomUUID()
  await transaction(migrator, async client => {
    const contactFacts = { kind: 'contact', organizationId: facts.buyerId, role: 'acquisitions', channel: 'website',
      checkedOn: new Date().toISOString().slice(0,10), verifiedPublicBusiness: true, suppressed: false }
    const { rows: [contactSource] } = await client.query("INSERT INTO sources(name) VALUES('Synthetic business registry') RETURNING id")
    const { rows: [grant] } = await client.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      SELECT $1,1,jsonb_set(manifest,'{campaignImport}',manifest->'campaignImport' || $2::jsonb),
        eligibility,method,coverage,policy_evidence FROM source_versions WHERE source_id=$3 RETURNING id
    `, [contactSource.id, JSON.stringify({ kind: 'contact', allowedFields: Object.keys(contactFacts) }), source])
    await client.query(`
      INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,fetched_at,artifact_id,extractor_version)
      SELECT $1,$2,$3,'fixture-contact',repeat('c',64),now(),artifact_id,'fixture' FROM observations WHERE id=$4
    `, [contactProof,contactSource.id,grant.id,observation])
    await client.query("INSERT INTO organizations(id,raw_name,normalized_name) VALUES($1,'Fixture','fixture')", [facts.buyerId])
    const { rows: [contact] } = await client.query(`
      INSERT INTO contacts(organization_id,channel,value,public_business,verified,checked_on,observation_id)
      VALUES($1,'website','example.invalid',true,true,$2,$3) RETURNING id
    `, [facts.buyerId,contactFacts.checkedOn,contactProof])
    await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,$3)", [contactProof,JSON.stringify(contactFacts),contact.id])
  })
  const buyers = await createCampaign({ ...draft, template: 'land_buyer_discovery', assetTypes: ['vacant_land'], requestedFields: ['contactability'] })
  const buyerRun = await runCampaign(buyers, 'asset-filtered-buyers')
  const buyer = (await read(`/runs/${buyerRun}/results`)).json().data[0]
  assert.equal(buyer.fields.contactability, 'verified_public_business')
  assert.ok(buyer.evidenceIds.includes(contactProof))
  const buyerExport = (await post(`/runs/${buyerRun}/exports`)).json().data.id
  await transaction(migrator, async client => {
    const { rows: [flag] } = await client.query(`
      INSERT INTO observations(source_id,source_version_id,source_record_id,revision_hash,event_date,fetched_at,artifact_id,extractor_version)
      SELECT source_id,source_version_id,'deed-flag',repeat('e',64),event_date,now(),artifact_id,extractor_version
      FROM observations WHERE id=$1 RETURNING id`, [revision])
    await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,NULL)",
      [flag.id, JSON.stringify({ kind: 'transfer', instrumentId: facts.instrumentId, relatedParty: true })])
  })
  const flagged = await runCampaign(buyers, 'instrument-disqualified')
  assert.deepEqual((await read(`/runs/${flagged}/results`)).json().data, [])
  await migrator.query('UPDATE contacts SET suppressed=true WHERE observation_id=$1', [contactProof])
  assert.deepEqual((await read(`/runs/${buyerRun}/results`)).json().data, [])
  assert.equal((await read(`/runs/${buyerRun}/evidence/${contactProof}`)).statusCode, 404)
  await transaction(migrator, async client => {
    await client.query('UPDATE contacts SET suppressed=false WHERE observation_id=$1', [contactProof])
    const { rows: [updated] } = await client.query(`
      INSERT INTO observations(source_id,source_version_id,source_record_id,revision_hash,fetched_at,artifact_id,extractor_version)
      SELECT source_id,source_version_id,source_record_id,repeat('d',64),clock_timestamp(),artifact_id,extractor_version
      FROM observations WHERE id=$1 RETURNING id
    `, [contactProof])
    const { rows: [contact] } = await client.query(`
      INSERT INTO contacts(organization_id,channel,value,public_business,verified,checked_on,observation_id)
      SELECT organization_id,channel,value,public_business,verified,checked_on,$2 FROM contacts WHERE observation_id=$1 RETURNING id
    `, [contactProof, updated.id])
    await client.query(`INSERT INTO campaign_import_facts
      SELECT $2,county_fips,acceptance,jsonb_set(facts,'{role}','"general_business"'),$3
      FROM campaign_import_facts WHERE observation_id=$1`, [contactProof, updated.id, contact.id])
  })
  assert.deepEqual((await read(`/runs/${buyerRun}/results`)).json().data, [])
  assert.equal((await read(`/runs/${buyerRun}/evidence/${contactProof}`)).statusCode, 404)
  assert.equal((await read(`/exports/${buyerExport}/download`)).statusCode, 409)
  const permitProof = randomUUID()
  await transaction(migrator, async client => {
    const permit = { kind: 'permit', jurisdiction: 'Fixture', permitNumber: 'P1', participantRole: 'builder',
      participantId: 'qualified-builder', projectId: 'project', asset: 'single_family' }
    const { rows: [publisher] } = await client.query("INSERT INTO sources(name) VALUES('Synthetic permit register') RETURNING id")
    const { rows: [grant] } = await client.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      SELECT $1,1,jsonb_set(manifest,'{campaignImport}',manifest->'campaignImport' || $2::jsonb),
        eligibility,method,coverage,policy_evidence FROM source_versions WHERE source_id=$3 RETURNING id
    `, [publisher.id, JSON.stringify({ kind: 'permit', allowedFields: Object.keys(permit) }), source])
    for (const [proof, asset] of [[permitProof,'single_family'],[randomUUID(),null]]) {
      await client.query(`
        INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,event_date,fetched_at,artifact_id,extractor_version)
        SELECT $1::uuid,$2,$3,($1::uuid)::text,repeat('a',64),current_date,now(),artifact_id,'fixture' FROM observations WHERE id=$4
      `, [proof,publisher.id,grant.id,observation])
      await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,NULL)",
        [proof, JSON.stringify({ ...permit, asset })])
    }
  })
  const builders = await createCampaign({ ...draft, template: 'builder_activity', assetTypes: ['vacant_land','single_family'],
    requestedFields: ['participantId'] })
  const builderRun = await runCampaign(builders, 'attributed-builders')
  const builderRows = (await read(`/runs/${builderRun}/results`)).json().data
  assert.deepEqual(builderRows.map((row: { evidenceIds: string[] }) => row.evidenceIds), [[permitProof]])
  const listingProofs: string[] = []
  await transaction(migrator, async client => {
    const { rows: [listingSource] } = await client.query("INSERT INTO sources(name) VALUES('Synthetic listing history') RETURNING id")
    const { rows: [version] } = await client.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      SELECT $1,1,jsonb_set(manifest,'{campaignImport}',manifest->'campaignImport' ||
        '{"kind":"listing","allowedFields":["listingId","asset","status","price"]}'::jsonb),
        eligibility,method,coverage,policy_evidence FROM source_versions WHERE source_id=$2 RETURNING id
    `, [listingSource.id, source])
    const events = [[2,'vacant_land',102], [1,'single_family',101], [0,'vacant_land',999], [0,'vacant_land',100]] as const
    for (const [index, [days, asset, amount]] of events.entries()) {
      const proof = randomUUID()
      await client.query(`INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,event_date,fetched_at,artifact_id,extractor_version)
        SELECT $1::uuid,$2,$3,'persistent-listing',repeat(md5(($1::uuid)::text),2),current_date-$4::int,
          current_date + $6::int * interval '1 millisecond',artifact_id,'fixture'
        FROM observations WHERE id=$5`, [proof, listingSource.id, version.id, days, observation, index])
      listingProofs.push(proof)
      await client.query("INSERT INTO campaign_import_facts VALUES($1,'00000','verified',$2,NULL)",
        [proof, JSON.stringify({ kind: 'listing', listingId: 'episode', status: 'active', asset,
          price: { type: 'asking_cash', currency: 'USD', amount } })])
    }
  })
  for (const asset of ['single_family', 'vacant_land']) {
    const market = await post('/campaigns/preview', { ...draft, template: 'market_snapshot',
      criteria: { asset }, assetTypes: [asset], requestedFields: ['active'] })
    assert.equal(market.statusCode, 200, market.body)
    assert.deepEqual(market.json().data.sample.map((r: { fields: object }) => r.fields),
      asset === 'vacant_land' ? [{ active: 1 }] : [])
  }
  for (const criteria of [{ asset: 'vacant_land' }, { asset: 'any' }]) {
    const watch = await post('/campaigns/preview', { ...draft, template: 'land_sfr_listing_watch',
      criteria, assetTypes: ['vacant_land'], requestedFields: ['amount', 'priceChange', 'asset'] })
    assert.equal(watch.statusCode, 200, watch.body)
    assert.deepEqual(watch.json().data.sample.map((row: { fields: object }) => row.fields), [
      { amount: 100, priceChange: null, asset: 'vacant_land' },
      { amount: 102, priceChange: null, asset: 'vacant_land' },
    ])
  }
  const listingRun = await runCampaign(await createCampaign({ ...draft, template: 'land_sfr_listing_watch',
    requestedFields: ['amount'] }), 'dated-listings')
  for (const [index, proof] of listingProofs.entries()) {
    const citation = await read(`/runs/${listingRun}/evidence/${proof}`)
    assert.equal(citation.statusCode, index === 2 ? 404 : 200)
    if (index !== 2) assert.equal(citation.json().data.sourceRecordId, 'persistent-listing')
  }
  const republish = (version: number, withdrawApn: boolean) => migrator.query(`
    INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
    SELECT source_id,$2,CASE WHEN $3 THEN jsonb_set(manifest,'{campaignImport,allowedFields}',
      (manifest#>'{campaignImport,allowedFields}')-'apn') ELSE manifest END, eligibility,method,coverage,policy_evidence
    FROM source_versions WHERE source_id=$1 AND version=1
  `, [source,version,withdrawApn])
  await republish(2, false)
  assert.equal((await read(`/runs/${run}/evidence/${observation}`)).statusCode, 200)
  const renewed = await read(`/exports/${created.json().data.id}/download`)
  assert.equal(renewed.statusCode, 200)
  assert.deepEqual(renewed.rawPayload, download.rawPayload)
  await republish(3, true)
  assert.equal((await read(`/runs/${run}/evidence/${observation}`)).statusCode, 404)
  assert.equal((await read(`/exports/${created.json().data.id}/download`)).statusCode, 409)
  const gapDraft = { ...request, geography: { countyFips: ['00001'] } }
  const gapPreview = await post('/campaigns/preview', gapDraft)
  assert.equal(gapPreview.statusCode, 200, gapPreview.body)
  assert.deepEqual(gapPreview.json().data.sources, [])
  assert.equal(gapPreview.json().data.activationEligible, true)
  const uncovered = await createCampaign(gapDraft)
  const gap = await runCampaign(uncovered, 'gap')
  assert.equal((await runStatus(gap)).state, 'partial')
  assert.deepEqual((await read(`/runs/${gap}/results`)).json().data, [])
})
