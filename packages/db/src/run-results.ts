import { SEATTLE_PERMITS_SOURCE, SEATTLE_PERMITS_URL } from '../../connectors/src/municipal/index.ts'
import { createHash } from 'node:crypto'
import { can } from '../../security/src/index.ts'
import type { Principal, Scope } from '../../security/src/index.ts'
import { CampaignError, getRun } from './campaigns.ts'
import type { Tx } from './campaigns.ts'
import { transaction } from './index.ts'
import type { DatabasePool } from './index.ts'

type Reader = Pick<DatabasePool, 'query'>
type ResultRow = { resultId: string; evidenceId: string | null; evidenceIds: string[]; recordId: string
  classification: string; date: string | null; fields: Record<string, string | number | boolean | null> }

// Every cited input must still qualify, including its current contact suppression state.
const visibleMatch = (contactAccessParameter: string) => `NOT EXISTS (SELECT 1 FROM unnest(m.evidence_ids) AS refs(ref)
  WHERE NOT EXISTS (SELECT 1 FROM eligible_campaign_citations input WHERE input.id=refs.ref
    AND (${contactAccessParameter}::boolean OR input.facts->>'kind'<>'contact')))`

function requireScopes(principal: Principal, scopes: Scope[]) {
  if (!scopes.every(scope => can(principal, scope))) throw new CampaignError(403, 'FORBIDDEN', 'Access denied')
}

async function resultRows(db: Reader, id: string, limit: number, contacts: boolean, after?: string, resultIds?: string[]) {
  const { rows } = await db.query<ResultRow>(`
    WITH page AS (SELECT 0 AS ordinal, link.observation_id AS "resultId", link.observation_id AS "evidenceId",
      ARRAY[link.observation_id] AS "evidenceIds", e.permit_id::text AS "recordId",
      'permit_event' AS classification, max(e.value) FILTER (WHERE e.field='issuedOn') AS date,
      coalesce(jsonb_object_agg(e.field,e.value) FILTER (
        WHERE r.config_snapshot->'campaign'->'requestedFields' ? e.field
      ),'{}'::jsonb) AS fields
    FROM run_observations link JOIN runs r ON r.id=link.run_id
    JOIN eligible_observations o ON o.id=link.observation_id
    JOIN permit_evidence e ON e.observation_id=link.observation_id
    JOIN eligible_permits p ON p.id=e.permit_id
    WHERE link.run_id=$1 AND ($5::uuid[] IS NULL OR link.observation_id=ANY($5)) AND ($2::uuid IS NULL OR link.observation_id>$2)
      AND e.relation='supports' AND e.acceptance IN ('verified','corroborated')
    GROUP BY link.observation_id,e.permit_id,r.config_snapshot,o.event_date
    UNION ALL
    SELECT m.ordinal,m.id,m.evidence_ids[1],m.evidence_ids,m.record_key,m.classification,m.event_date::text,m.fields
    FROM campaign_matches m WHERE m.run_id=$1 AND ($5::uuid[] IS NULL OR m.id=ANY($5)) AND ($2::uuid IS NULL OR m.ordinal>(
      SELECT prior.ordinal FROM campaign_matches prior WHERE prior.id=$2 AND prior.run_id=$1
    )) AND ${visibleMatch('$4')})
    SELECT "resultId","evidenceId","evidenceIds","recordId",classification,date,fields FROM page
    ORDER BY ordinal,"resultId" LIMIT $3
  `, [id, after ?? null, limit, contacts, resultIds ?? null])
  return rows
}

export async function readRunResults(db: Reader, principal: Principal, id: string, limit: number, after?: string) {
  requireScopes(principal, ['runs:read','records:read','evidence:read'])
  await getRun(db, principal, id)
  return resultRows(db, id, limit, can(principal, 'contacts:read'), after)
}

// Construct links from reviewed dataset identities and approved columns. Never forward a stored URL query.
const publishers: Record<string, { identity: string; fields: Record<string,string> }> = {
  [SEATTLE_PERMITS_URL]: { identity: 'permitnum', fields: { permitNumber: 'permitnum', status: 'statuscurrent',
    rawStatus: 'statuscurrent', rawType: 'permittypemapped', permitType: 'permittypemapped', issuedOn: 'issueddate', appliedOn: 'applieddate' } },
  'https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json': {
    identity: 'row_id', fields: { instrumentId: 'doc_no', apn: 'pin', eventDate: 'sale_date' } },
  'https://data.cityofnewyork.us/resource/ipu4-2q9a.json': {
    identity: 'permit_si_no', fields: { permitNumber: 'permit_si_no', status: 'permit_status',
      rawStatus: 'permit_status', rawType: 'permit_type', eventDate: 'issuance_date' } },
}

export function evidenceLocation(dataset: string | null, record: string, fields: string[], synthetic: boolean) {
  const publisher = dataset && Object.hasOwn(publishers, dataset) ? publishers[dataset] : undefined
  const fieldLocators = Object.fromEntries(fields.filter(key => /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key))
    .map(key => [key, publisher?.fields[key] ?? 'facts.' + key]))
  if (!publisher || !dataset || synthetic) return { sourceUrl: null, fieldLocators }
  const identity = dataset === SEATTLE_PERMITS_URL ? record.replace(SEATTLE_PERMITS_SOURCE.id + ':record:', '') : record
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(identity)) return { sourceUrl: null, fieldLocators }
  const url = new URL(dataset)
  url.searchParams.set(publisher.identity, identity)
  url.searchParams.set('$select', [...new Set([publisher.identity, ...fields.flatMap(key => publisher.fields[key] ?? [])])].join(','))
  url.searchParams.set('$limit', '1')
  return { sourceUrl: url.href, fieldLocators }
}

export async function importedRunEvidence(db: Reader, principal: Principal, id: string, evidenceId: string) {
  requireScopes(principal, ['runs:read','records:read','evidence:read'])
  await getRun(db, principal, id)
  const { rows: [entry] } = await db.query(`
    SELECT i.id, i.source_name AS "sourceName", i.event_date::text AS "eventDate", i.fetched_at AS "fetchedAt",
      i.source_record_id AS "sourceRecordId", i.extractor_version AS "extractorVersion", i.acceptance,
      i.manifest->'campaignImport'->>'sourceUrl' AS dataset, coalesce(i.manifest->>'synthetic','false')='true' AS synthetic,
      ARRAY(SELECT key FROM jsonb_object_keys(i.facts) key WHERE i.manifest->'campaignImport'->'allowedFields' ? key AND key<>'kind') AS fields
    FROM eligible_campaign_citations i WHERE i.id=$2 AND EXISTS (
      SELECT 1 FROM campaign_matches m WHERE m.run_id=$1 AND $2=ANY(m.evidence_ids) AND ${visibleMatch('$3')})
    UNION ALL
    SELECT o.id,s.name,(SELECT max(e.value) FROM permit_evidence e WHERE e.observation_id=o.id
      AND e.field='issuedOn' AND e.relation='supports' AND e.acceptance IN ('verified','corroborated')),o.fetched_at,o.source_record_id,o.extractor_version,'verified',
      o.source_url,r.config_snapshot->'source'->>'synthetic'='true',
      ARRAY(SELECT e.field FROM permit_evidence e WHERE e.observation_id=o.id
        AND e.relation='supports' AND e.acceptance IN ('verified','corroborated') AND e.field<>'jurisdiction')
    FROM run_observations link JOIN eligible_observations o ON o.id=link.observation_id
    JOIN runs r ON r.id=link.run_id JOIN sources s ON s.id=o.source_id WHERE link.run_id=$1 AND o.id=$2
      AND EXISTS (SELECT 1 FROM permit_evidence e JOIN eligible_permits p ON p.id=e.permit_id
        WHERE e.observation_id=o.id AND e.acceptance='verified' AND e.relation='supports')
  `, [id,evidenceId,can(principal,'contacts:read')])
  if (!entry) throw new CampaignError(404, 'NOT_FOUND', 'Evidence not found')
  const { dataset, fields, synthetic, ...metadata } = entry
  return { ...metadata, ...evidenceLocation(dataset, metadata.sourceRecordId, fields, synthetic) }
}

export function csvCell(value: string) {
  const safe = /^[\t\r\n]|^\s*[=+@-]/u.test(value) ? "'" + value : value
  return '"' + safe.replaceAll('"', '""') + '"'
}

async function renderCsv(client: Tx, principal: Principal, id: string, snapshot?: string[]) {
  requireScopes(principal, ['records:read','evidence:read','runs:read'])
  const run = await getRun(client, principal, id)
  if (!snapshot && !['completed','partial'].includes(run.state)) throw new CampaignError(409, 'RUN_NOT_READY', 'Run must be complete or partial')
  const { rows: [config] } = await client.query<{ fields: string[] }>(
    "SELECT config_snapshot->'campaign'->'requestedFields' AS fields FROM runs WHERE id=$1", [id])
  const columns = ['evidenceIds','recordId','classification','date']
  const fields = [...new Set(config.fields)].filter(field => !columns.includes(field))
  const line = (values: string[]) => values.map(csvCell).join(',') + '\r\n'
  const chunks = [line([...columns,...fields])]
  let bytes = Buffer.byteLength(chunks[0])
  const resultIds: string[] = []
  let after: string | undefined
  for (;;) {
    const pinned = snapshot?.slice(resultIds.length, resultIds.length + 100)
    const page = await resultRows(client, id, 100, can(principal, 'contacts:read'), after, pinned)
    for (const row of page) {
      const chunk = line([row.evidenceIds.join(' '),row.recordId,row.classification,row.date ?? '',...fields.map(field =>
        Object.hasOwn(row.fields, field) ? String(row.fields[field] ?? '') : '')])
      bytes += Buffer.byteLength(chunk)
      if (bytes > 16 * 1024 * 1024) throw new CampaignError(413, 'EXPORT_LIMIT', 'Narrow the run to a 16 MiB CSV')
      chunks.push(chunk)
      resultIds.push(row.resultId)
    }
    if (page.length < 100) break
    after = page.at(-1)!.resultId
  }
  const csv = chunks.join('')
  return { csv, resultIds, sha256: createHash('sha256').update(csv).digest('hex') }
}

export async function createRunExport(pool: DatabasePool, principal: Principal, runId: string) {
  requireScopes(principal, ['exports:create'])
  return transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const { resultIds, sha256 } = await renderCsv(client, principal, runId)
    const { rows: [entry] } = await client.query<{ id: string; expires_at: Date }>(`
      INSERT INTO exports(requester_id,scope,run_id,filters,expires_at)
      VALUES($1,ARRAY['exports:read'],$2,$3,now()+interval '24 hours') RETURNING id,expires_at
    `, [principal.id, runId, JSON.stringify({ sha256, resultIds })])
    return { id: entry.id, expiresAt: entry.expires_at.toISOString(), rowCount: resultIds.length, sha256 }
  })
}

export async function downloadRunExport(pool: DatabasePool, principal: Principal, id: string) {
  requireScopes(principal, ['exports:read'])
  return transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const { rows: [entry] } = await client.query<{ run_id: string; sha256: string; result_ids: string[] | null }>(`
      SELECT run_id,filters->>'sha256' AS sha256,filters->'resultIds' AS result_ids FROM exports WHERE id=$1 AND requester_id=$2 AND expires_at>now()
    `, [id, principal.id])
    if (!entry) throw new CampaignError(404, 'NOT_FOUND', 'Export not found')
    const { csv, sha256 } = await renderCsv(client, principal, entry.run_id, entry.result_ids ?? undefined)
    if (sha256 !== entry.sha256) throw new CampaignError(409, 'EXPORT_CHANGED', 'Eligible results changed. Create a new export.')
    await client.query('SELECT skyscrape_access.audit_export_download($1,$2)', [principal.id, id])
    return csv
  })
}
