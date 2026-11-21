import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { buildApp } from '../../apps/server/src/app.ts'
import { createUser } from '../../apps/server/src/auth/index.ts'
import { campaignDraft, campaignSchemaV1, errorEnvelope, recordProjection } from '../../packages/contracts/src/index.ts'
import { migrate, openDatabase, transaction } from '../../packages/db/src/index.ts'
import { unseal } from '../../packages/security/src/index.ts'

const runtimeUrl = process.env.DATABASE_URL
const migratorUrl = process.env.MIGRATOR_DATABASE_URL
if (!runtimeUrl || !migratorUrl) throw Error('Set disposable test database URLs')
for (const value of [runtimeUrl, migratorUrl]) {
  assert.equal(new URL(value).hostname, '127.0.0.1', 'Run against the disposable loopback test database')
}

const pool = openDatabase(runtimeUrl)
const migrator = openDatabase(migratorUrl)
const origin = 'https://skyscrape.example.invalid'
const secret = () => randomBytes(32).toString('hex')
const keyPepper = secret()
const masterKey = randomBytes(32)
const bootstrapToken = secret()
const password = secret()
const adminEmail = 'synthetic-admin@example.invalid'
const analystEmail = 'synthetic-analyst@example.invalid'
const viewerEmail = 'synthetic-viewer@example.invalid'
const channel = 'synthetic-business@example.invalid'
const suppressed = 'synthetic-suppressed@example.invalid'
const nonpublic = 'synthetic-unverified@example.invalid'
const personSuppressed = 'synthetic-optout@example.invalid'
const privateMarker = 'synthetic-private-evidence'
const sourceId = randomUUID()
const sourceVersionId = randomUUID()
const unqualifiedSourceId = randomUUID()
const unqualifiedVersionId = randomUUID()
const observationId = randomUUID()
const unlinkedId = randomUUID()
const unqualifiedId = randomUUID()
const permitId = randomUUID()
const secondPermitId = randomUUID()
const unqualifiedPermitId = randomUUID()
let viewerId: string
let analystId: string
let loginAddress = 0

const app = buildApp({ pool, origin, authSecret: secret(), keyPepper, masterKey, masterKeyVersion: 7 })
app.get('/api/v1/test-safe-error', () => { throw Error(privateMarker) })

function runBootstrap(mode: string, adminPassword = password) {
  const outcome = spawnSync(process.execPath, ['scripts/admin-bootstrap.ts', mode], {
    encoding: 'utf8',
    env: {
      ...process.env, API_KEY_PEPPER: keyPepper, BOOTSTRAP_TOKEN: bootstrapToken,
      ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword,
    },
  })
  assert.ok(!outcome.stdout.includes(adminPassword) && !outcome.stderr.includes(bootstrapToken))
  return outcome.status
}

async function signIn(email: string, value = password) {
  return app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    remoteAddress: `192.0.2.${++loginAddress}`, headers: { origin }, payload: { email, password: value },
  })
}

async function sessionCookie(email: string, value = password) {
  const login = await signIn(email, value)
  assert.equal(login.statusCode, 204, login.body)
  assert.equal(login.body, '')
  const cookie = login.cookies.find(entry => entry.name === '__Secure-better-auth.session_token')
  assert.ok(cookie?.httpOnly && cookie.secure)
  assert.equal(cookie.sameSite, 'Lax')
  return `${cookie.name}=${cookie.value}`
}

async function seedPermits() {
  const orgId = randomUUID()
  const personId = randomUUID()
  const artifactId = randomUUID()
  await transaction(pool, async client => {
    await client.query("INSERT INTO sources(id,name) VALUES($1,'Synthetic permits'),($2,'Synthetic unqualified')", [
      sourceId, unqualifiedSourceId,
    ])
    await client.query(`
      INSERT INTO source_versions(id,source_id,version,manifest,eligibility,method,policy_evidence)
      VALUES($1,$2,1,'{}','qualified','structured','synthetic'),($3,$4,1,'{}','unknown','structured','synthetic')
    `, [sourceVersionId, sourceId, unqualifiedVersionId, unqualifiedSourceId])
    await client.query(`
      INSERT INTO artifacts(id,sha256,store_key,mime,size_bytes,access_class)
      VALUES($1,$2,$3,'application/json',1,'restricted')
    `, [artifactId, 'a'.repeat(64), privateMarker])
    for (const [id, source, version] of [
      [observationId, sourceId, sourceVersionId],
      [unlinkedId, sourceId, sourceVersionId],
      [unqualifiedId, unqualifiedSourceId, unqualifiedVersionId],
    ]) {
      await client.query(`
        INSERT INTO observations(id,source_id,source_version_id,source_record_id,revision_hash,source_url,
          event_date,fetched_at,artifact_id,extractor_version)
        VALUES($1,$2,$3,$4,$5,$6,'2026-01-01',now(),$7,'fixtures-v1')
      `, [id, source, version, id, 'b'.repeat(64), `https://example.invalid/${privateMarker}`, artifactId])
    }
    await client.query(`
      INSERT INTO campaigns(id,owner_id,version,title,objective,state,geo_filter,criteria,
        requested_fields,source_policy,budget_config)
      VALUES($1,$2,1,'Synthetic permit campaign','permit_monitoring','draft','{}','{}',
        ARRAY['rawStatus'],'{"freeOnly":true}','{}')
    `, [permitId, analystId])
    await client.query(`
      INSERT INTO campaign_versions(campaign_id,version,config_snapshot,schema_version,created_by)
      VALUES($1,1,'{}',1,$2)
    `, [permitId, analystId])
    const { rows: [run] } = await client.query<{ id: string }>(`
      INSERT INTO runs(campaign_id,version,trigger,state,config_snapshot)
      VALUES($1,1,'instant','completed','{}') RETURNING id
    `, [permitId])
    await client.query('INSERT INTO run_observations(run_id,observation_id) VALUES($1,$2)', [run.id, observationId])
    for (const [id, proof, number] of [
      [permitId, observationId, 'SYNTHETIC-001'],
      [secondPermitId, observationId, 'SYNTHETIC-002'],
      [unqualifiedPermitId, unqualifiedId, 'SYNTHETIC-003'],
    ]) {
      await client.query(`
        INSERT INTO permits(id,jurisdiction,permit_number,raw_status,status,issued_on)
        VALUES($1,'Synthetic County',$2,'ISSUED','issued','2026-01-01')
      `, [id, number])
      await client.query(`
        WITH assertion AS (
          INSERT INTO field_assertions(subject_type,subject_id,field,value,acceptance,extractor_version)
          VALUES('permit',$1,'rawStatus','ISSUED','verified','fixtures-v1') RETURNING id
        )
        INSERT INTO evidence_links(assertion_id,observation_id,relation)
        SELECT id,$2,'supports' FROM assertion
      `, [id, proof])
    }
    await client.query(`
      WITH assertion AS (
        INSERT INTO field_assertions(subject_type,subject_id,field,value,acceptance,extractor_version)
        VALUES('permit',$1,'contact',$2,'verified','fixtures-v1') RETURNING id
      )
      INSERT INTO evidence_links(assertion_id,observation_id,relation)
      SELECT id,$3,'supports' FROM assertion
    `, [permitId, privateMarker, unlinkedId])
    await client.query("INSERT INTO organizations(id,raw_name,normalized_name) VALUES($1,'Synthetic Org','synthetic org')", [orgId])
    await client.query("INSERT INTO people(id,name,organization_id,suppressed) VALUES($1,'Synthetic Person',$2,true)", [personId, orgId])
    await client.query(`
      INSERT INTO permit_participants(permit_id,role,organization_id,person_id,observation_id)
      VALUES($1,'contractor',$2,$3,$4)
    `, [permitId, orgId, personId, observationId])
    await client.query(`
      INSERT INTO contacts(organization_id,person_id,channel,value,public_business,verified,suppressed,checked_on,observation_id)
      VALUES($1,NULL,'email',$2,true,true,false,current_date,$3),
        ($1,NULL,'email',$4,true,true,true,current_date,$3),
        ($1,NULL,'email',$5,false,false,false,NULL,$3),
        ($1,$6,'email',$7,true,true,false,current_date,$3),
        ($1,NULL,'email',$8,true,true,false,current_date,$9)
    `, [orgId, channel, observationId, suppressed, nonpublic, personId, personSuppressed, privateMarker, unqualifiedId])
  })
}

before(async () => {
  await Promise.all([migrate(migrator), migrate(migrator)])
  assert.equal(runBootstrap('issue'), 0)
  assert.equal(runBootstrap('create'), 0)
  assert.equal(runBootstrap('create'), 1)
  await transaction(pool, async client => {
    analystId = await createUser(client, analystEmail, password, 'analyst')
    viewerId = await createUser(client, viewerEmail, password, 'viewer')
  })
  await seedPermits()
})

after(async () => {
  await app.close()
  await Promise.all([pool.end(), migrator.end()])
})

test('migrates an empty PostGIS DB once and keeps privileged objects private', async () => {
  assert.match((await pool.query<{ version: string }>('SELECT postgis_version() AS version')).rows[0].version, /^3\.7/)
  assert.equal((await migrator.query('SELECT 1 FROM drizzle.__drizzle_migrations')).rowCount, 1)
  for (const sql of [
    'SELECT digest FROM bootstrap_token',
    'SELECT * FROM drizzle.__drizzle_migrations',
    'UPDATE observations SET fetched_at=now()',
    'TRUNCATE audit_events',
    'CREATE TABLE runtime_must_not_create(id integer)',
    'CREATE EXTENSION postgis_topology',
  ]) {
    await assert.rejects(pool.query(sql), { code: '42501' })
  }
  await assert.rejects(pool.query(`
    INSERT INTO observations(source_id,source_version_id,source_record_id,revision_hash,fetched_at,artifact_id,extractor_version)
    SELECT source_id,source_version_id,source_record_id,revision_hash,fetched_at,artifact_id,extractor_version
    FROM observations WHERE id=$1
  `, [observationId]), { code: '23505' })
})

test('validates the shared campaign contract and generates protected OpenAPI', async () => {
  const draft = {
    title: 'Synthetic campaign', template: 'permit_monitoring',
    geography: { countyFips: ['00001'] }, assetTypes: ['single_family'], requestedFields: ['rawStatus'],
    sourcePolicy: { freeOnly: true, allowHostedFreeTiers: false },
    limits: { maxPages: 3, maxLlmCalls: 0, maxMinutes: 5 },
  }
  assert.ok(campaignDraft.safeParse(draft).success)
  assert.equal(campaignSchemaV1.additionalProperties, false)
  assert.ok(!campaignDraft.safeParse({ ...draft, sourcePolicy: { freeOnly: false } }).success)
  assert.ok(!campaignDraft.safeParse({ ...draft, protocolVersion: 2 }).success)
  const cookie = await sessionCookie(viewerEmail)
  const spec = await app.inject({ url: '/api/v1/openapi.json', headers: { cookie } })
  assert.equal(spec.statusCode, 200)
  assert.ok(spec.json().paths['/api/v1/records/{id}'].get.responses['200'])
  assert.equal((await app.inject('/api/v1/openapi.json')).statusCode, 401)
})

test('uses secure cookie sessions, rejects foreign origins, and audits local reset', async () => {
  const cookie = await sessionCookie(adminEmail)
  const me = await app.inject({ url: '/api/v1/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().data.role, 'admin')
  assert.equal(me.json().data.kind, 'session')
  assert.equal(me.headers['cache-control'], 'no-store')
  assert.equal((await app.inject('/api/v1/me')).statusCode, 401)
  const invalidOrigin = await app.inject({
    method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: 'https://other.example.invalid' },
    payload: { email: adminEmail, password },
  })
  assert.equal(invalidOrigin.statusCode, 403)
  const noOrigin = await app.inject({
    method: 'POST', url: '/api/auth/sign-out', headers: { authorization: 'Bearer invalid', cookie },
  })
  assert.equal(noOrigin.statusCode, 403)
  const signup = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin } })
  assert.equal(signup.statusCode, 404)
  const resetPassword = secret()
  assert.equal(runBootstrap('issue'), 0)
  assert.equal(runBootstrap('reset', resetPassword), 0)
  assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode, 401)
  assert.equal((await signIn(adminEmail)).statusCode, 401)
  const freshCookie = await sessionCookie(adminEmail, resetPassword)
  const signedOut = await app.inject({
    method: 'POST', url: '/api/auth/sign-out', headers: { origin, cookie: freshCookie },
  })
  assert.equal(signedOut.statusCode, 204)
  assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie: freshCookie } })).statusCode, 401)
  const audit = await pool.query<{ action: string }>('SELECT action FROM audit_events')
  for (const event of ['bootstrap.issued', 'bootstrap.create', 'bootstrap.reset', 'session.login', 'session.logout']) {
    assert.ok(audit.rows.some(row => row.action === event), event)
  }
  assert.equal(runBootstrap('issue'), 0)
  assert.equal(runBootstrap('reset'), 0)
})

test('projects only eligible permit fields and analyst business channels', async () => {
  const analyst = await sessionCookie(analystEmail)
  const viewer = await sessionCookie(viewerEmail)
  const url = `/api/v1/records/${permitId}`
  const detail = await app.inject({ url, headers: { cookie: analyst } })
  assert.equal(detail.statusCode, 200, detail.body)
  const record = recordProjection.parse(detail.json().data)
  assert.equal(record.rawStatus, 'ISSUED')
  assert.equal(record.status, null)
  assert.deepEqual(record.evidenceIds, [observationId])
  assert.deepEqual(record.contacts, [{ channel: 'email', value: channel }])
  assert.deepEqual((await app.inject({ url, headers: { cookie: viewer } })).json().data.contacts, [])
  const evidence = await app.inject({ url: `/api/v1/evidence/${observationId}`, headers: { cookie: viewer } })
  assert.equal(evidence.statusCode, 200, evidence.body)
  assert.deepEqual(evidence.json().data.fields.find((field: { recordId: string }) => field.recordId === permitId), {
    recordId: permitId, field: 'rawStatus', acceptance: 'verified', relation: 'supports',
  })
  assert.ok(!evidence.body.includes(privateMarker) && !evidence.body.includes(channel))
  for (const denied of [
    `/api/v1/evidence/${unlinkedId}`,
    `/api/v1/evidence/${unqualifiedId}`,
    `/api/v1/records/${unqualifiedPermitId}`,
  ]) {
    assert.equal((await app.inject({ url: denied, headers: { cookie: analyst } })).statusCode, 404)
  }
  const page = (await app.inject({ url: '/api/v1/records?limit=1', headers: { cookie: viewer } })).json()
  assert.equal(page.data.length, 1)
  const next = (await app.inject({
    url: `/api/v1/records?limit=1&cursor=${page.meta.nextCursor}`, headers: { cookie: viewer },
  })).json()
  assert.equal(next.data.length, 1)
  assert.deepEqual(new Set([page.data[0].id, next.data[0].id]), new Set([permitId, secondPermitId]))
  assert.equal(next.meta.nextCursor, undefined)
  assert.equal((await app.inject({ url: '/api/v1/records?unknown=true', headers: { cookie: viewer } })).statusCode, 400)
})

test('audits key writes and applies scopes, live role changes, expiry and revocation', async () => {
  const admin = await sessionCookie(adminEmail)
  const analyst = await sessionCookie(analystEmail)
  const issueUrl = '/api/v1/admin/keys'
  const body = {
    ownerId: analystId, scopes: ['records:read'], expiresAt: new Date(Date.now() + 60_000).toISOString(), dailyQuota: 3,
  }
  const issue = (cookie: string, payload = body) => app.inject({
    method: 'POST', url: issueUrl, headers: { origin, cookie }, payload,
  })
  assert.equal((await issue(analyst)).statusCode, 403)
  assert.equal((await issue(admin, { ...body, ownerId: viewerId, scopes: ['contacts:read'] })).statusCode, 400)
  const issued = await issue(admin)
  assert.equal(issued.statusCode, 201, issued.body)
  const { id, key, prefix } = issued.json().data
  const { rows: [stored] } = await pool.query('SELECT prefix,digest FROM api_keys WHERE id=$1', [id])
  assert.equal(stored.prefix, prefix)
  assert.equal(stored.digest.length, 32)
  assert.ok(!JSON.stringify(stored).includes(key))
  const headers = { authorization: `Bearer ${key}` }
  const record = await app.inject({ url: `/api/v1/records/${permitId}`, headers })
  assert.equal(record.statusCode, 200)
  assert.deepEqual(record.json().data.contacts, [])
  assert.equal((await app.inject({ url: `/api/v1/evidence/${observationId}`, headers })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: issueUrl, headers, payload: body })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/v1/me', headers })).statusCode, 429)
  const revoke = () => app.inject({ method: 'DELETE', url: `${issueUrl}/${id}`, headers: { origin, cookie: admin } })
  assert.equal((await revoke()).statusCode, 204)
  assert.equal((await revoke()).statusCode, 204)
  assert.equal((await app.inject({ url: '/api/v1/me', headers })).statusCode, 401)

  const contactKey = (await issue(admin, { ...body, scopes: ['records:read', 'contacts:read'] })).json().data
  const contactHeaders = { authorization: `Bearer ${contactKey.key}` }
  const getRecord = () => app.inject({ url: `/api/v1/records/${permitId}`, headers: contactHeaders })
  assert.equal((await getRecord()).json().data.contacts.length, 1)
  await pool.query(`UPDATE "user" SET role='viewer' WHERE id=$1`, [analystId])
  assert.deepEqual((await getRecord()).json().data.contacts, [])
  await pool.query('UPDATE api_keys SET expires_at=now() WHERE id=$1', [contactKey.id])
  assert.equal((await getRecord()).statusCode, 401)
  const audit = await pool.query('SELECT action FROM audit_events WHERE subject_id=$1 ORDER BY action', [id])
  assert.deepEqual(audit.rows, [{ action: 'api_key.created' }, { action: 'api_key.revoked' }])
})

test('keeps encrypted credentials out of responses and hides evidence after policy revocation', async () => {
  const credential = secret()
  const admin = await sessionCookie(adminEmail)
  const viewer = await sessionCookie(viewerEmail)
  const target = '/api/v1/admin/provider-accounts/synthetic/key'
  const save = (cookie: string) => app.inject({
    method: 'PUT', url: target, headers: { origin, cookie }, payload: { secret: credential },
  })
  assert.equal((await save(viewer)).statusCode, 403)
  const saved = await save(admin)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.ok(!saved.body.includes(credential))
  assert.equal((await app.inject({ url: target, headers: { cookie: admin } })).statusCode, 404)
  const { rows: [row] } = await pool.query('SELECT encrypted_key,key_version FROM provider_accounts WHERE name=$1', ['synthetic'])
  assert.ok(!row.encrypted_key.includes(Buffer.from(credential)))
  assert.equal(unseal(row.encrypted_key, masterKey, row.key_version, 'provider:synthetic'), credential)
  assert.throws(() => unseal(row.encrypted_key, masterKey, row.key_version, 'provider:other'))
  assert.equal((await pool.query("SELECT 1 FROM audit_events WHERE action='provider_key.saved'")).rowCount, 1)

  const failed = await app.inject({ url: '/api/v1/test-safe-error', headers: { cookie: viewer } })
  assert.equal(failed.statusCode, 500)
  assert.ok(!failed.body.includes(privateMarker))
  const failure = errorEnvelope.parse(failed.json()).error
  assert.equal(failure.code, 'INTERNAL_ERROR')
  assert.equal(failure.requestId, failed.headers['x-request-id'])

  await pool.query(`
    INSERT INTO source_versions(source_id,version,manifest,eligibility,method,policy_evidence)
    VALUES($1,2,'{}','blocked','structured','synthetic scope revoked')
  `, [sourceId])
  assert.equal((await app.inject({ url: `/api/v1/evidence/${observationId}`, headers: { cookie: viewer } })).statusCode, 404)
  assert.equal((await app.inject({ url: `/api/v1/records/${permitId}`, headers: { cookie: viewer } })).statusCode, 404)
})

test('rejects a login that races an admin password reset', async () => {
  const resetPassword = secret()
  assert.equal(runBootstrap('issue'), 0)
  await migrator.query(`
    CREATE FUNCTION synthetic_pause_sign_in() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(4305022);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER synthetic_pause_sign_in BEFORE INSERT ON session
    FOR EACH ROW EXECUTE FUNCTION synthetic_pause_sign_in();
  `)
  const lockHolder = await migrator.connect()
  await lockHolder.query('SELECT pg_advisory_lock(4305022)')
  const login = signIn(adminEmail)
  try {
    let waiting = false
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const { rowCount } = await migrator.query(`
        SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=4305022 AND NOT granted
      `)
      waiting = Boolean(rowCount)
      if (!waiting) await setTimeout(20)
    }
    assert.ok(waiting, 'Login reached the session insert before reset')
    assert.equal(runBootstrap('reset', resetPassword), 0)
  } finally {
    lockHolder.release(true)
  }
  const outcome = await login
  assert.equal(outcome.statusCode, 401)
  assert.equal(outcome.headers['set-cookie'], undefined)
  assert.ok(await sessionCookie(adminEmail, resetPassword))
})

test('throttles login through the trusted connection address', async () => {
  for (let attempt = 1; attempt <= 7; attempt++) {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: '192.0.2.200',
      headers: { origin, 'x-skyscrape-client-ip': `192.0.2.${attempt}` },
      payload: { email: adminEmail, password: 'synthetic-incorrect-password' },
    })
    assert.equal(response.statusCode, attempt <= 6 ? 401 : 429)
  }
})
