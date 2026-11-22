import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createCampaign } from '../../packages/db/src/campaigns.ts'
import { openDatabase } from '../../packages/db/src/index.ts'
import { incidentRepairBrief, operationalExports, operationalIssues, operationalSources, runRepairBrief } from '../../packages/db/src/operational-pages.ts'
import { createRunExport, downloadRunExport } from '../../packages/db/src/run-results.ts'
import { roleScopes } from '../../packages/security/src/index.ts'
import type { Principal, Role } from '../../packages/security/src/index.ts'

function disposable(name: string) {
  const url = process.env[name]
  if (process.env.OPS_TEST_DISPOSABLE !== '1' || !url || new URL(url).hostname !== '127.0.0.1') {
    throw Error('Use a migrated disposable loopback database and set OPS_TEST_DISPOSABLE=1')
  }
  return openDatabase(url)
}

test('synthetic operational registry projects authorized sources, run incidents and expiring private snapshots', async () => {
  const runtime = disposable('DATABASE_URL')
  const fixture = disposable('MIGRATOR_DATABASE_URL')
  try {
    async function account(role: Role): Promise<Principal> {
      const id = randomUUID()
      await fixture.query('INSERT INTO "user"(id,name,email,role) VALUES($1,$2,$2,$3)', [id, id + '@example.invalid', role])
      return { id, role, kind: 'session', scopes: roleScopes(role) }
    }
    const owner = await account('analyst')
    const other = await account('analyst')
    const viewer = { ...owner, role: 'viewer' as const, scopes: roleScopes('viewer') }
    const draft = { title: 'Synthetic operating register', template: 'permit_monitoring',
      geography: { countyFips: ['00000'] }, assetTypes: [], requestedFields: ['permitNumber'],
      sourcePolicy: { freeOnly: true as const, allowHostedFreeTiers: false }, limits: { maxPages: 1, maxLlmCalls: 0, maxMinutes: 1 } }
    const campaign = await createCampaign(runtime, owner, draft)
    async function run(template: string, state: string) {
      const id = randomUUID()
      await fixture.query(`INSERT INTO runs(id,campaign_id,version,trigger,state,config_snapshot)
        VALUES($1,$2,1,'instant',$3,$4)`, [id,campaign.id,state,JSON.stringify({ campaign: { ...draft, template }, synthetic: true })])
      return id
    }
    const partial = await run('permit_monitoring', 'partial')
    await run('permit_monitoring', 'running')
    const contact = await run('contact_enrichment', 'failed')
    await fixture.query(`INSERT INTO run_tasks(run_id,logical_key,state,error_code)
      VALUES($1,'synthetic','failed','BUDGET_EXHAUSTED')`, [partial])
    const source = randomUUID()
    const version = randomUUID()
    const incident = randomUUID()
    await fixture.query('INSERT INTO sources(id,name) VALUES($1,$2)', [source, 'Synthetic contact ' + source])
    await fixture.query(`INSERT INTO source_versions(id,source_id,version,eligibility,method,policy_evidence,manifest)
      VALUES($1,$2,1,'qualified','import','private test policy','{"synthetic":true,"campaignImport":{"kind":"contact"}}')`, [version,source])
    await fixture.query(`INSERT INTO incidents(id,source_version_id,fingerprint,impact,state)
      VALUES($1,$2,'secret-fingerprint','private incident detail','detected')`, [incident,version])
    const sources = await operationalSources(runtime, owner)
    assert(sources.some(item => item.id === source && item.synthetic))
    assert(!(await operationalSources(runtime, viewer)).some(item => item.id === source))
    const registry = await operationalIssues(runtime, owner)
    assert(registry.runs.some(item => item.id === partial && item.code === 'BUDGET_EXHAUSTED'))
    assert(registry.runs.some(item => item.state === 'running'))
    assert(registry.incidents.some(item => item.id === incident))
    assert(!JSON.stringify(registry).includes('private incident detail'))
    assert(!(await operationalIssues(runtime, viewer)).runs.some(item => item.id === contact))
    assert(!(await operationalIssues(runtime, other)).runs.some(item => item.id === partial))
    assert.match(await runRepairBrief(runtime, owner, partial), /BUDGET_EXHAUSTED/)
    await assert.rejects(runRepairBrief(runtime, other, partial), { status: 404 })
    assert(!(await incidentRepairBrief(runtime, owner, incident)).includes('secret-fingerprint'))
    await assert.rejects(incidentRepairBrief(runtime, viewer, incident), { status: 403 })
    await fixture.query(`INSERT INTO source_versions(source_id,version,eligibility,method,policy_evidence,manifest)
      VALUES($1,2,'qualified','import','renewed','{}')`, [source])
    const renewed = (await operationalIssues(runtime, owner)).incidents.find(item => item.id === incident)
    assert(renewed?.synthetic && renewed.version === 1 && renewed.state === 'detected')
    const brief = await incidentRepairBrief(runtime, owner, incident)
    assert.match(brief, /Source registry version 1\n/)
    assert.match(brief, /Evidence mode synthetic/)
    const noContacts = { ...owner, scopes: owner.scopes.filter(scope => scope !== 'contacts:read') }
    assert(!(await operationalIssues(runtime, noContacts)).incidents.some(item => item.id === incident))
    await assert.rejects(incidentRepairBrief(runtime, noContacts, incident), { status: 404 })
    await fixture.query(`INSERT INTO source_versions(source_id,version,eligibility,method,policy_evidence,manifest)
      VALUES($1,3,'blocked','import','withdrawn','{}')`, [source])
    assert(!(await operationalIssues(runtime, owner)).incidents.some(item => item.id === incident))
    assert(!(await operationalSources(runtime, owner)).some(item => item.id === source))
    await assert.rejects(incidentRepairBrief(runtime, owner, incident), { status: 404 })
    const snapshot = await createRunExport(runtime, owner, partial)
    assert.match(await downloadRunExport(runtime, owner, snapshot.id), /evidenceIds/)
    const entries = await operationalExports(runtime, owner)
    assert(entries.history.some(item => item.id === snapshot.id && item.rowCount === 0 && item.sha256 === snapshot.sha256 && !item.expired))
    assert(!JSON.stringify(entries).includes('resultIds'))
    assert(!(await operationalExports(runtime, other)).history.some(item => item.id === snapshot.id))
    await assert.rejects(operationalExports(runtime, viewer), { status: 403 })
    await assert.rejects(downloadRunExport(runtime, viewer, snapshot.id), { status: 403 })
    await fixture.query("UPDATE exports SET expires_at=now()-interval '1 minute' WHERE id=$1", [snapshot.id])
    assert((await operationalExports(runtime, owner)).history.some(item => item.id === snapshot.id && item.expired))
    await assert.rejects(downloadRunExport(runtime, owner, snapshot.id), { status: 404 })
  } finally { await Promise.all([runtime.end(), fixture.end()]) }
})
