import { collectionError } from '../../contracts/src/collection/schema.ts'
import type { CampaignConfig } from '../../contracts/src/campaign-config.ts'
import { can } from '../../security/src/index.ts'
import type { Principal, Scope } from '../../security/src/index.ts'
import { authorizeTemplate, CampaignError, getRun } from './campaigns.ts'
import type { DatabasePool } from './index.ts'
import type { SourceEntry, IssueRegister, ExportRegister } from './operational-types.ts'

type Reader = Pick<DatabasePool, 'query'>
function requireScopes(principal: Principal, ...scopes: Scope[]) {
  if (!scopes.every(scope => can(principal, scope))) throw new CampaignError(403, 'FORBIDDEN', 'Access denied')
}

const currentSources = `WITH latest AS (
  SELECT DISTINCT ON (source_id) * FROM source_versions ORDER BY source_id, version DESC
), visible AS (
  SELECT v.*, s.name FROM latest v JOIN sources s ON s.id=v.source_id
  WHERE v.eligibility='qualified' AND ($1::boolean OR
    (v.manifest->'campaignImport'->>'kind') IS DISTINCT FROM 'contact')
)`

export async function operationalSources(db: Reader, principal: Principal) {
  requireScopes(principal, 'sources:read')
  return (await db.query<SourceEntry>(currentSources + `
    SELECT source_id AS id,name,version,eligibility,method,coverage,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "assessedAt",
      coalesce(manifest->>'assessmentId',manifest->'campaignImport'->>'assessmentId') AS assessment,
      coalesce(manifest->'allowedFields',manifest->'campaignImport'->'allowedFields','[]') AS fields,
      coalesce(manifest->'countyFips','[]') AS counties,manifest @> '{"synthetic":true}' AS synthetic
    FROM visible ORDER BY name`, [can(principal, 'contacts:read')])).rows
}

const knownCodes = new Set<string>([...collectionError.shape.code.options, 'RESULT_LIMIT', 'UNQUERIED_COUNTIES',
  'UNSUPPORTED_FIELDS', 'WAITING_USER_EXPIRED', 'DELIVERY_EXHAUSTED', 'SOURCE_POLICY_CHANGED', 'BUDGET_EXHAUSTED',
  'COLLECTION_UNAVAILABLE'])
function safeCode(code: string | null) {
  return code && knownCodes.has(code) ? code : null
}

function readable(principal: Principal, campaign: CampaignConfig | null) {
  if (!campaign) return false
  try { authorizeTemplate(principal, campaign); return true } catch (error) {
    if (error instanceof CampaignError && error.status === 403) return false
    throw error
  }
}

async function recentRuns(db: Reader, principal: Principal, exportsOnly: boolean) {
  const { rows } = await db.query<{
    id: string; state: string; campaign: CampaignConfig | null; createdAt: string; code: string | null; synthetic: boolean
  }>(`SELECT r.id,r.state,r.config_snapshot->'campaign' AS campaign,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
      (SELECT t.error_code FROM run_tasks t WHERE t.run_id=r.id AND t.error_code IS NOT NULL
        ORDER BY t.available_at DESC,t.id DESC LIMIT 1) AS code,
      (r.config_snapshot @> '{"synthetic":true}' OR r.config_snapshot @> '{"source":{"synthetic":true}}') AS synthetic
    FROM runs r JOIN campaigns c ON c.id=r.campaign_id
    WHERE (c.owner_id=$1 OR $2::boolean) AND
      CASE WHEN $3::boolean THEN r.state IN ('partial','completed') ELSE r.state NOT IN ('completed','cancelled') END
    ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
  [principal.id, principal.role === 'admin' && principal.kind === 'session', exportsOnly])
  return rows.filter(row => readable(principal, row.campaign)).map(({ campaign, code, ...row }) =>
    ({ ...row, title: campaign!.title, code: safeCode(code) }))
}

async function currentIncidents(db: Reader, principal: Principal, id?: string) {
  return (await db.query<IssueRegister['incidents'][number]>(
    currentSources + ` SELECT i.id,v.name AS source,v.version,v.manifest @> '{"synthetic":true}' AS synthetic,
      (SELECT count(*)::int FROM repair_briefs b WHERE b.incident_id=i.id) AS "briefCount",
      CASE WHEN i.state IN ('detected','triaged','brief_ready','assigned','candidate_tested','canary','resolved','rolled_back')
        THEN i.state ELSE 'unknown' END AS state
      FROM incidents i JOIN visible v ON v.id=i.source_version_id WHERE ($2::uuid IS NULL OR i.id=$2)
      ORDER BY v.name,i.id LIMIT 100`, [can(principal, 'contacts:read'), id ?? null])).rows
}

export async function operationalIssues(db: Reader, principal: Principal): Promise<IssueRegister> {
  requireScopes(principal, 'issues:read')
  return { incidents: await currentIncidents(db, principal),
    runs: can(principal, 'runs:read') ? await recentRuns(db, principal, false) : [] }
}

export async function incidentRepairBrief(db: Reader, principal: Principal, id: string) {
  requireScopes(principal, 'issues:read', 'issues:triage')
  const [incident] = await currentIncidents(db, principal, id)
  if (!incident) throw new CampaignError(404, 'NOT_FOUND', 'Incident not found')
  return [
    '# Source incident repair brief', '', '## Objective', 'Investigate the current source incident using a local, sanitized reproduction.',
    '', '## Observed outcome', 'Incident ' + id, 'Source registry version ' + incident.version, 'Lifecycle ' + incident.state,
    'Evidence mode ' + (incident.synthetic ? 'synthetic' : 'workspace incident'),
    '', '## Reproduction', 'Review the incident and current approved fields in Sources. Reproduce the issue with a permitted minimal fixture.',
    '', '## Expected outcome', 'The connector returns validated fields within the current access policy or reports an explicit coverage gap.',
    '', '## Regression and rollback', 'Add a regression check for the reproduced failure. Keep repair work local and independently reviewed.',
    'Canary the reviewed candidate and restore the previous version if field accuracy or eligibility regresses.',
    '', '## Unknowns', 'Confirm the failure signature, affected fields, last good version and suspected files during triage.', '',
  ].join('\n')
}

export async function operationalExports(db: Reader, principal: Principal): Promise<ExportRegister> {
  requireScopes(principal, 'exports:read', 'runs:read', 'records:read', 'evidence:read')
  const { rows } = await db.query<{
    id: string; runId: string; campaign: CampaignConfig | null; expiresAt: string; expired: boolean; rowCount: number | null; sha256: string | null
  }>(`SELECT e.id,r.id AS "runId",r.config_snapshot->'campaign' AS campaign,
    to_char(e.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAt",e.expires_at<=now() AS expired,
    jsonb_array_length(e.filters->'resultIds') AS "rowCount",e.filters->>'sha256' AS sha256
    FROM exports e JOIN runs r ON r.id=e.run_id JOIN campaigns c ON c.id=r.campaign_id
    WHERE e.requester_id=$1 AND c.owner_id=$1 ORDER BY e.expires_at DESC,e.id DESC LIMIT 100`, [principal.id])
  return { history: rows.filter(row => readable(principal, row.campaign)).map(({ campaign, ...entry }) =>
    ({ ...entry, title: campaign!.title })), runs: can(principal, 'exports:create') ? await recentRuns(db, principal, true) : [] }
}

export async function runRepairBrief(db: Reader, principal: Principal, id: string) {
  requireScopes(principal, 'runs:read', 'issues:read', 'issues:triage')
  const run = await getRun(db, principal, id)
  if (!['partial','failed','waiting_user','retry_wait'].includes(run.state))
    throw new CampaignError(409, 'RUN_NOT_ACTIONABLE', 'Run has no actionable failure')
  const code = safeCode(run.errorCode)
  return [
    '# Campaign run repair brief', '', '## Objective', 'Restore the affected collection within the assessed source policy.',
    '', '## Observed outcome', 'Run ' + id, 'Campaign version ' + run.campaignVersion, 'State ' + run.state,
    'Failure code ' + (code ?? 'unclassified'), 'Evidence mode ' + (run.synthetic ? 'synthetic' : 'workspace run'),
    '', '## Reproduction', 'Inspect the run’s task history locally. Reproduce the failure with a minimal, sanitized fixture.',
    'Use the run ID to inspect accepted results and evidence with an authorized account.',
    '', '## Expected outcome', 'Return eligible evidence within the configured budget, or report the remaining coverage gap.',
    '', '## Change boundary', 'Check the source assessment and retrieval limits before retrying. Keep credentials and raw evidence private.',
    '', '## Regression and rollback', 'Exercise the failing case locally and verify eligibility and field provenance.',
    'Review the candidate independently and canary it before promotion. Restore the prior approved connector if the check fails.',
    '', '## Unknowns', 'Root cause, affected field count, last good connector and candidate version require investigation.', '',
  ].join('\n')
}
