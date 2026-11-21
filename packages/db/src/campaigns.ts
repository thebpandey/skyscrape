import { randomUUID } from 'node:crypto'
import { schemaVersion } from '../../contracts/src/index.ts'
import { campaignConfig } from '../../contracts/src/campaign-config.ts'
import type { CampaignConfig } from '../../contracts/src/campaign-config.ts'
import { resolveTemplateId, validateCriteria } from '../../domain/src/templates/index.ts'
import type { SchedulePolicy } from '../../domain/src/campaigns/schedule.ts'
import type { Principal } from '../../security/src/index.ts'
import { can } from '../../security/src/index.ts'
import { launchImported, recordKinds } from './template-runs.ts'
import { transaction } from './index.ts'
import type { DatabasePool } from './index.ts'

export type Tx = Parameters<Parameters<typeof transaction>[1]>[0]
type Reader = Pick<DatabasePool, 'query'>
export type SourcePlan = {
  id: string
  versionId: string
  version: number
  name: string
  assessmentId: string
  coverage: string
  synthetic: boolean
}
export type RunSnapshot = {
  campaign: CampaignConfig
  source: SourcePlan
  scheduledFor: string | null
  unsupportedFields: string[]
  coverageGaps?: string[]
  kind?: string
  synthetic?: boolean
  model: null
}
type CampaignRow = { id: string; version: number; state: string; snapshot: unknown }
export type RunRow = {
  id: string; campaign_id: string; version: number; trigger: string; state: string
  counters: Record<string, number>; config_snapshot: RunSnapshot
  created_at: Date; started_at: Date | null; finished_at: Date | null
}
export type ScheduleRow = {
  id: string; campaign_id: string; recurrence: SchedulePolicy['timing']; zone: string
  next_due_at: Date | null; overlap: SchedulePolicy['overlap']; misfire: SchedulePolicy['misfire']['policy']
  grace_minutes: number; state: string
}

export class CampaignError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function templateVisible(principal: Principal, draft: CampaignConfig) {
  return can(principal, 'contacts:read') || !resolveTemplateId(draft.template) || !recordKinds(draft).includes('contact')
}

export function authorizeTemplate(principal: Principal, draft: CampaignConfig) {
  if (!templateVisible(principal, draft)) {
    throw new CampaignError(403, 'FORBIDDEN', 'Contact research requires contact access')
  }
}

export async function lockCampaign(client: Tx, id: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 22002))', [id])
}

function visibility(principal: Principal): [string, boolean] {
  return [principal.id, principal.kind === 'session' && principal.role === 'admin']
}

async function campaignRow(db: Reader, id: string, principal?: Principal) {
  const [actor, admin] = principal ? visibility(principal) : [null, true]
  const { rows: [row] } = await db.query<CampaignRow>(`
    SELECT c.id,c.version,c.state,v.config_snapshot AS snapshot
    FROM campaigns c JOIN campaign_versions v ON v.campaign_id=c.id AND v.version=c.version
    WHERE c.id=$1 AND ($3::boolean OR c.owner_id=$2)
  `, [id, actor, admin])
  if (!row) throw new CampaignError(404, 'NOT_FOUND', 'Campaign not found')
  if (principal) authorizeTemplate(principal, campaignConfig.parse(row.snapshot))
  return row
}

export async function qualifiedSources(db: Reader, draft: CampaignConfig): Promise<SourcePlan[]> {
  if (resolveTemplateId(draft.template) !== 'permit_monitoring' || draft.assetTypes.length > 0) return []
  const { rows } = await db.query<SourcePlan>(`
    WITH latest AS (
      SELECT DISTINCT ON (source_id) * FROM source_versions ORDER BY source_id,version DESC
    )
    SELECT s.id, v.id AS "versionId", v.version, s.name, v.coverage,
      v.manifest->>'assessmentId' AS "assessmentId", v.manifest->'synthetic' = 'true'::jsonb AS synthetic
    FROM latest v JOIN sources s ON s.id=v.source_id
    WHERE v.eligibility='qualified' AND v.method='structured'
      AND v.manifest->>'connector'='seattle-building-permits'
      AND ((v.manifest->>'synthetic'='true' AND '00000'=ANY($1))
        OR (v.manifest->>'synthetic'='false' AND '53033'=ANY($1)))
      AND v.manifest->'allowedFields' @> '["permitnum","issueddate","statuscurrent","permittypemapped","applieddate"]'::jsonb
      AND v.manifest->>'assessmentId' ~ '^[a-zA-Z0-9_-]{1,100}$'
      AND v.manifest->'countyFips' ? CASE WHEN v.manifest->>'synthetic'='true' THEN '00000' ELSE '53033' END
    ORDER BY synthetic,s.id LIMIT 1
  `, [draft.geography.countyFips])
  return rows.map(row => ({ ...row, synthetic: row.synthetic === true }))
}

export async function sourceStillQualified(db: Reader, source: SourcePlan) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM (SELECT * FROM source_versions WHERE source_id=$1 ORDER BY version DESC LIMIT 1) latest
    WHERE id=$2 AND eligibility='qualified' AND method='structured' AND version=$3
      AND manifest->>'connector'='seattle-building-permits'
      AND manifest->'allowedFields' @> '["permitnum","issueddate","statuscurrent","permittypemapped","applieddate"]'::jsonb
      AND manifest->>'assessmentId'=$4
      AND COALESCE(manifest->'synthetic'='true'::jsonb,false)=$5
  `, [source.id, source.versionId, source.version, source.assessmentId, source.synthetic])
  return rowCount === 1
}

export function unqueriedCounties(draft: CampaignConfig, source: SourcePlan) {
  return draft.geography.countyFips.filter(county => county !== (source.synthetic ? '00000' : '53033'))
}

export function municipalGaps(draft: CampaignConfig, source: SourcePlan) {
  return [source.coverage, ...unqueriedCounties(draft, source)
    .map(county => `No municipal coverage for county ${county}.`)]
}

export async function previewMunicipal(db: Reader, source: SourcePlan, draft: CampaignConfig, asOf: string) {
  const { windowDays, status, maxResults } = validateCriteria('permit_monitoring', draft.criteria)
  const { rows } = await db.query<{ evidenceIds: string[]; fields: Record<string,string> }>(`
    WITH candidates AS (
      SELECT o.id,o.event_date FROM eligible_observations o
      WHERE o.source_version_id=$1 AND o.event_date BETWEEN $2::date-($3::int-1) AND $2::date
      ORDER BY o.event_date DESC,o.id LIMIT 50
    )
    SELECT ARRAY[c.id] AS "evidenceIds",coalesce(jsonb_object_agg(e.field,e.value)
      FILTER (WHERE e.field=ANY($4::text[])), '{}'::jsonb) AS fields
    FROM candidates c JOIN permit_evidence e ON e.observation_id=c.id JOIN eligible_permits p ON p.id=e.permit_id
    WHERE e.relation='supports' AND e.acceptance IN ('verified','corroborated')
    GROUP BY c.id,c.event_date HAVING $5='' OR bool_or(e.field='status' AND lower(e.value)=lower($5))
    ORDER BY c.event_date DESC,c.id LIMIT $6
  `, [source.versionId,asOf,windowDays,draft.requestedFields,status,Math.min(5,maxResults)])
  return rows
}

export function supportsCampaignField(field: string) {
  return ['jurisdiction', 'permitNumber', 'rawStatus', 'status', 'rawType', 'permitType', 'issuedOn', 'appliedOn'].includes(field)
}

async function writeVersion(client: Tx, id: string, version: number, owner: string, draft: CampaignConfig) {
  await client.query(`
    INSERT INTO campaign_versions(campaign_id,version,config_snapshot,schema_version,created_by)
    VALUES($1,$2,$3,$4,$5)
  `, [id, version, JSON.stringify(draft), schemaVersion, owner])
}

function draftValues(draft: CampaignConfig) {
  return [draft.title, draft.objective ?? draft.template, JSON.stringify(draft.geography),
    JSON.stringify({ assetTypes: draft.assetTypes, template: draft.template }),
    draft.requestedFields, JSON.stringify(draft.sourcePolicy), JSON.stringify(draft.limits)]
}

export async function createCampaign(pool: DatabasePool, principal: Principal, draft: CampaignConfig, key?: string) {
  authorizeTemplate(principal, draft)
  return transaction(pool, async client => {
    const id = randomUUID()
    const inserted = await client.query(`
      INSERT INTO campaigns(id,owner_id,version,title,objective,state,geo_filter,criteria,requested_fields,source_policy,budget_config,create_key)
      VALUES($1,$2,1,$3,$4,'draft',$5,$6,$7,$8,$9,$10)
      ON CONFLICT(owner_id,create_key) WHERE create_key IS NOT NULL DO NOTHING
    `, [id, principal.id, ...draftValues(draft), key ?? null])
    if (!inserted.rowCount) {
      const { rows: [prior] } = await client.query<{ id: string }>(`
        SELECT c.id FROM campaigns c JOIN campaign_versions v ON v.campaign_id=c.id AND v.version=1
        WHERE c.owner_id=$1 AND c.create_key=$2 AND v.config_snapshot=$3::jsonb
      `, [principal.id, key, JSON.stringify(draft)])
      if (!prior) throw new CampaignError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different draft')
      return { id: prior.id, version: 1, state: 'draft' }
    }
    await writeVersion(client, id, 1, principal.id, draft)
    return { id, version: 1, state: 'draft' }
  })
}

export async function getCampaign(db: Reader, principal: Principal, id: string) {
  const { version, state, snapshot } = await campaignRow(db, id, principal)
  return { id, version, state, draft: campaignConfig.parse(snapshot) }
}

export async function listCampaigns(db: Reader, principal: Principal, limit: number, after?: string) {
  if (after) await campaignRow(db, after, principal)
  const result: { id: string; title: string; template: string; state: string; version: number }[] = []
  let cursor = after
  // A page of owner-visible rows may contain restricted contact campaigns.
  while (result.length <= limit) {
    const { rows } = await db.query<CampaignRow>(`
      SELECT c.id,c.version,c.state,v.config_snapshot AS snapshot
      FROM campaigns c JOIN campaign_versions v ON v.campaign_id=c.id AND v.version=c.version
      WHERE ($2::boolean OR c.owner_id=$1)
        AND ($3::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM campaigns WHERE id=$3))
      ORDER BY c.created_at DESC,c.id DESC LIMIT $4
    `, [...visibility(principal), cursor ?? null, limit + 1])
    for (const row of rows) {
      const draft = campaignConfig.parse(row.snapshot)
      if (templateVisible(principal, draft)) {
        result.push({ id: row.id, version: row.version, state: row.state, title: draft.title, template: draft.template })
        if (result.length > limit) return { rows: result.slice(0, limit), next: result[limit - 1].id }
      }
    }
    if (rows.length <= limit) break
    cursor = rows[rows.length - 1].id
  }
  return { rows: result }
}

export async function changeCampaign(pool: DatabasePool, principal: Principal, id: string, expected: number, draft: CampaignConfig) {
  authorizeTemplate(principal, draft)
  return transaction(pool, async client => {
    await lockCampaign(client, id)
    const current = await campaignRow(client, id, principal)
    if (current.version !== expected) throw new CampaignError(409, 'VERSION_CONFLICT', 'Campaign version changed')
    const active = await client.query("SELECT 1 FROM schedules WHERE campaign_id=$1 AND state='active'", [id])
    if (active.rowCount) throw new CampaignError(409, 'ACTIVE_SCHEDULE', 'Pause the schedule before editing the campaign')
    const version = expected + 1
    await client.query(`
      UPDATE campaigns SET version=$2,title=$3,objective=$4,geo_filter=$5,criteria=$6,requested_fields=$7,
        source_policy=$8,budget_config=$9 WHERE id=$1
    `, [id, version, ...draftValues(draft)])
    await writeVersion(client, id, version, principal.id, draft)
    return { id, version, state: current.state }
  })
}

export async function configureSchedule(pool: DatabasePool, principal: Principal, id: string,
  expected: number, policy: SchedulePolicy, first: Date) {
  return transaction(pool, async client => {
    await lockCampaign(client, id)
    const current = await campaignRow(client, id, principal)
    if (current.version !== expected) throw new CampaignError(409, 'VERSION_CONFLICT', 'Campaign version changed')
    if (current.state === 'active') throw new CampaignError(409, 'ACTIVE_SCHEDULE', 'Pause the schedule before replacing it')
    const draft = { ...campaignConfig.parse(current.snapshot), timing: policy.timing }
    const version = current.version + 1
    await writeVersion(client, id, version, principal.id, draft)
    await client.query("UPDATE campaigns SET version=$2,state='active' WHERE id=$1", [id, version])
    await client.query("UPDATE schedules SET state='replaced' WHERE campaign_id=$1 AND state='paused'", [id])
    const { rows: [schedule] } = await client.query<{ id: string }>(`
      INSERT INTO schedules(campaign_id,mode,zone,recurrence,next_due_at,overlap,misfire,state,grace_minutes)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING id
    `, [id, policy.timing.mode, policy.timing.timezone, JSON.stringify(policy.timing), first,
      policy.overlap, policy.misfire.policy, policy.misfire.graceMinutes])
    return { id: schedule.id, version, nextDueAt: first.toISOString(), state: 'active' }
  })
}

export async function changeScheduleState(pool: DatabasePool, principal: Principal, id: string,
  action: 'pause' | 'resume', advance: (timing: SchedulePolicy['timing']) => Date | null) {
  return transaction(pool, async client => {
    await lockCampaign(client, id)
    await campaignRow(client, id, principal)
    const { rows: [schedule] } = await client.query<ScheduleRow>(`
      SELECT * FROM schedules WHERE campaign_id=$1 AND state IN ('active','paused')
    `, [id])
    if (!schedule) throw new CampaignError(409, 'NO_SCHEDULE', 'Campaign has no active or paused schedule')
    const state = action === 'pause' ? 'paused' : 'active'
    if (schedule.state !== state) {
      const due = state === 'paused' ? schedule.next_due_at : advance(schedule.recurrence)
      await client.query('UPDATE schedules SET state=$2,next_due_at=$3 WHERE id=$1', [schedule.id, state, due])
      await client.query('UPDATE campaigns SET state=$2 WHERE id=$1', [id, state])
      if (action === 'pause') await client.query(`
        UPDATE occurrences SET disposition='paused' WHERE schedule_id=$1 AND disposition='waiting_overlap'
      `, [schedule.id])
    }
    return { id: schedule.id, state }
  })
}

export async function enqueueTask(client: Tx, taskId: string) {
  await client.query("INSERT INTO outbox(event_type,payload) VALUES('campaign.task.ready',$1)", [JSON.stringify({ taskId })])
}

export async function addPage(client: Tx, runId: string, offset: number) {
  const { rows: [task] } = await client.query<{ id: string }>(`
    INSERT INTO run_tasks(run_id,logical_key,state,checkpoint) VALUES($1,$2,'queued',$3)
    ON CONFLICT(run_id,logical_key) DO NOTHING RETURNING id
  `, [runId, `page:${offset}`, JSON.stringify({ offset })])
  if (task) await enqueueTask(client, task.id)
}

export async function plannedRun(client: Tx, id: string, trigger: 'instant' | 'scheduled', due: Date | null,
  timing?: SchedulePolicy['timing']) {
  const current = await campaignRow(client, id)
  const campaign = campaignConfig.parse(current.snapshot)
  if (timing) campaign.timing = timing
  const [source] = await qualifiedSources(client, campaign)
  if (!source) {
    if (!resolveTemplateId(campaign.template)) throw new CampaignError(409, 'UNKNOWN_TEMPLATE', 'Choose a supported template')
    return launchImported(client, id, current.version, campaign, trigger, due)
  }
  const snapshot: RunSnapshot = {
    coverageGaps: municipalGaps(campaign, source),
    campaign, source, scheduledFor: due?.toISOString() ?? null, model: null,
    unsupportedFields: campaign.requestedFields.filter(field => !supportsCampaignField(field)),
  }
  const runId = randomUUID()
  await client.query(`
    INSERT INTO runs(id,campaign_id,version,trigger,state,config_snapshot)
    VALUES($1,$2,$3,$4,'queued',$5)
  `, [runId, id, current.version, trigger, JSON.stringify(snapshot)])
  await addPage(client, runId, 0)
  return runId
}

async function repeatRequest(client: Tx, principal: Principal, action: 'run' | 'retry',
  id: string, key: string, fingerprint: string) {
  const { rows: [prior] } = await client.query<{ run_id: string; fingerprint: string }>(`
    SELECT run_id,fingerprint FROM campaign_run_requests
    WHERE actor_id=$1 AND action=$2 AND resource_id=$3 AND request_key=$4 AND expires_at>now()
  `, [principal.id, action, id, key])
  if (prior && prior.fingerprint !== fingerprint) {
    throw new CampaignError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request')
  }
  return prior?.run_id
}

async function rememberRequest(client: Tx, principal: Principal, action: 'run' | 'retry',
  id: string, key: string, fingerprint: string, runId: string) {
  await client.query(`
    INSERT INTO campaign_run_requests(actor_id,action,resource_id,request_key,fingerprint,run_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')
    ON CONFLICT(actor_id,action,resource_id,request_key) DO UPDATE
    SET fingerprint=excluded.fingerprint,run_id=excluded.run_id,expires_at=excluded.expires_at
  `, [principal.id, action, id, key, fingerprint, runId])
}

export async function startRun(pool: DatabasePool, principal: Principal, id: string, key: string, version?: number) {
  return transaction(pool, async client => {
    await lockCampaign(client, id)
    const current = await campaignRow(client, id, principal)
    const fingerprint = String(version ?? '')
    const repeated = await repeatRequest(client, principal, 'run', id, key, fingerprint)
    if (repeated) return repeated
    if (version !== undefined && current.version !== version) {
      throw new CampaignError(409, 'VERSION_CONFLICT', 'Campaign version changed')
    }
    const runId = await plannedRun(client, id, 'instant', null)
    if (!runId) throw new CampaignError(409, 'NO_QUALIFIED_SOURCE', 'No qualified source covers this campaign')
    await rememberRequest(client, principal, 'run', id, key, fingerprint, runId)
    return runId
  })
}

async function runRow(db: Reader, principal: Principal, id: string) {
  const { rows: [run] } = await db.query<RunRow>(`
    SELECT r.* FROM runs r JOIN campaigns c ON r.campaign_id=c.id
    WHERE r.id=$1 AND ($3::boolean OR c.owner_id=$2)
  `, [id, ...visibility(principal)])
  if (!run) throw new CampaignError(404, 'NOT_FOUND', 'Run not found')
  if (run.config_snapshot?.campaign) authorizeTemplate(principal, run.config_snapshot.campaign)
  return run
}

export async function campaignRuns(db: Reader, principal: Principal, id: string) {
  await campaignRow(db, id, principal)
  const { rows } = await db.query<Pick<RunRow, 'id' | 'state' | 'created_at' | 'config_snapshot'>>(`
    SELECT id,state,created_at,config_snapshot FROM runs WHERE campaign_id=$1 ORDER BY created_at DESC,id DESC
  `, [id])
  return rows.filter(row => can(principal, 'contacts:read') || !recordKinds(row.config_snapshot.campaign).includes('contact'))
    .map(row => ({ id: row.id, state: row.state, createdAt: row.created_at.toISOString() }))
}

export async function getRun(db: Reader, principal: Principal, id: string) {
  const run = await runRow(db, principal, id)
  const { rows: tasks } = await db.query<{ state: string; count: number }>(`
    SELECT state,count(*)::integer AS count FROM run_tasks WHERE run_id=$1 GROUP BY state ORDER BY state
  `, [id])
  const counts = Object.fromEntries(tasks.map(({ state, count }) => [state, count]))
  return {
    id, campaignId: run.campaign_id, campaignVersion: run.version, state: run.state, trigger: run.trigger,
    createdAt: run.created_at.toISOString(), startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null, counters: run.counters, tasks: counts,
    errorCode: (await db.query<{ error_code: string }>(`
      SELECT error_code FROM run_tasks WHERE run_id=$1 AND error_code IS NOT NULL
      ORDER BY available_at DESC,id DESC LIMIT 1
    `, [id])).rows[0]?.error_code ?? null,
    synthetic: run.config_snapshot?.source?.synthetic === true || run.config_snapshot?.synthetic === true,
    coverageGaps: run.config_snapshot?.coverageGaps ?? [],
    unsupportedFields: run.config_snapshot?.unsupportedFields ?? [],
  }
}

const terminalStates = new Set(['completed', 'partial', 'failed', 'cancelled'])
export function terminalRun(state: string) {
  return terminalStates.has(state)
}

export async function cancelRun(pool: DatabasePool, principal: Principal, id: string) {
  return transaction(pool, async client => {
    await runRow(client, principal, id)
    const { rows: [run] } = await client.query<{ state: string }>('SELECT state FROM runs WHERE id=$1 FOR UPDATE', [id])
    if (terminalRun(run.state)) return run.state
    await client.query(`
      UPDATE run_tasks SET state='cancelled',error_code=NULL
      WHERE run_id=$1 AND state IN ('queued','retry_wait','waiting_user') AND attempt_id IS NULL
    `, [id])
    const { rows: attempted } = await client.query<{ id: string }>(`
      UPDATE run_tasks SET state='queued',available_at=now()
      WHERE run_id=$1 AND state IN ('queued','retry_wait','waiting_user') AND attempt_id IS NOT NULL RETURNING id
    `, [id])
    for (const task of attempted) await enqueueTask(client, task.id)
    const { rowCount } = await client.query(`
      SELECT 1 FROM run_tasks WHERE run_id=$1 AND state IN ('running','queued') LIMIT 1
    `, [id])
    const state = rowCount ? 'cancelling' : 'cancelled'
    await client.query("UPDATE runs SET state=$2,finished_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END WHERE id=$1", [id, state])
    return state
  })
}

export async function retryRun(pool: DatabasePool, principal: Principal, id: string, key: string) {
  return transaction(pool, async client => {
    const current = await runRow(client, principal, id)
    await lockCampaign(client, current.campaign_id)
    const repeated = await repeatRequest(client, principal, 'retry', id, key, '')
    if (repeated) return repeated
    const { rows: [run] } = await client.query<RunRow>('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [id])
    if (!['partial','failed','waiting_user'].includes(run.state)) {
      throw new CampaignError(409, 'RUN_NOT_RETRYABLE', 'Run has no failed tasks to retry')
    }
    const deadline = (run.started_at?.getTime() ?? Date.now()) + run.config_snapshot.campaign.limits.maxMinutes * 60_000
    if ((run.counters.attempts ?? 0) >= run.config_snapshot.campaign.limits.maxPages || Date.now() >= deadline) {
      throw new CampaignError(409, 'BUDGET_EXHAUSTED', 'Run has no remaining collection budget')
    }
    const { rows } = await client.query<{ id: string }>(`
      UPDATE run_tasks SET state='queued',error_code=NULL,retryable=false,available_at=now()
      WHERE run_id=$1 AND state IN ('failed','waiting_user') AND retryable RETURNING id
    `, [id])
    if (!rows.length) throw new CampaignError(409, 'RUN_NOT_RETRYABLE', 'Run has no retryable tasks')
    for (const { id: taskId } of rows) await enqueueTask(client, taskId)
    await client.query("UPDATE runs SET state='queued',finished_at=NULL WHERE id=$1", [id])
    await rememberRequest(client, principal, 'retry', id, key, '', id)
    return id
  })
}
