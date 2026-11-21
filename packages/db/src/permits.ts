import type { Evidence, PermitRecord } from '../../contracts/src/index.ts'
import { can } from '../../security/src/index.ts'
import type { Authenticated, Principal } from '../../security/src/index.ts'
import type { DatabasePool } from './index.ts'

type PermitFilter = {
  id?: string
  after?: string
  jurisdiction?: string
  permitNumber?: string
  limit: number
}

type PermitRow = Omit<PermitRecord, 'contacts'>
type ContactRow = PermitRecord['contacts'][number] & { permit_id: string }

const permitFields = [
  ['raw_status', 'rawStatus'], ['status', 'status'],
  ['raw_type', 'rawType'], ['permit_type', 'permitType'],
  ['issued_on', 'issuedOn'], ['applied_on', 'appliedOn'],
]

const eligibleFields = permitFields.map(([column, field]) => `
  CASE WHEN EXISTS (
    SELECT 1 FROM permit_evidence evidence
    WHERE evidence.permit_id = permit.id AND evidence.field = '${field}'
      AND evidence.value = permit.${column}::text AND evidence.relation = 'supports'
      AND evidence.acceptance IN ('verified', 'corroborated')
  ) THEN permit.${column}::text END AS "${field}"`).join(',')

export async function readPermitContacts(pool: DatabasePool, { principal, proof }: Authenticated, permitIds: readonly string[]) {
  const contacts = new Map<string, PermitRecord['contacts']>()
  if (!can(principal, 'contacts:read') || !permitIds.length) return contacts
  const sessionId = proof.kind === 'session' ? proof.id : null
  const keyDigest = proof.kind === 'key' ? proof.digest : null
  const { rows } = await pool.query<ContactRow>(`
    SELECT permit_id, channel, value FROM skyscrape_access.read_permit_contacts($1,$2,$3,$4)
  `, [permitIds, principal.id, sessionId, keyDigest])
  for (const { permit_id, channel, value } of rows) {
    const channels = contacts.get(permit_id)
    if (channels) channels.push({ channel, value })
    else contacts.set(permit_id, [{ channel, value }])
  }
  return contacts
}

export async function readPermits(pool: DatabasePool, authenticated: Authenticated, filter: PermitFilter) {
  if (!can(authenticated.principal, 'records:read')) return []
  const { rows } = await pool.query<PermitRow>(`
    WITH page AS (
      SELECT permit.*
      FROM eligible_permits permit
      WHERE ($1::uuid IS NULL OR permit.id = $1)
        AND ($2::uuid IS NULL OR permit.id > $2)
        AND ($3::text IS NULL OR permit.jurisdiction = $3)
        AND ($4::text IS NULL OR permit.permit_number = $4)
      ORDER BY permit.id LIMIT $5
    )
    SELECT permit.id, permit.jurisdiction, permit.permit_number AS "permitNumber", ${eligibleFields},
      ARRAY(SELECT DISTINCT evidence.observation_id FROM permit_evidence evidence
            WHERE evidence.permit_id = permit.id ORDER BY evidence.observation_id) AS "evidenceIds"
    FROM page permit ORDER BY permit.id
  `, [filter.id, filter.after, filter.jurisdiction, filter.permitNumber, filter.limit])
  const contacts = await readPermitContacts(pool, authenticated, rows.map(record => record.id))
  return rows.map(record => ({ ...record, contacts: contacts.get(record.id) ?? [] }))
}

export async function readEvidence(pool: DatabasePool, principal: Principal, id: string) {
  if (!can(principal, 'evidence:read')) return undefined
  const { rows } = await pool.query<Evidence>(`
    SELECT observation.id, source.name AS "sourceName", version.version AS "sourceVersion",
      CASE WHEN version.manifest->>'connector'='seattle-building-permits'
        THEN max(evidence.value) FILTER (WHERE evidence.field='issuedOn' AND evidence.relation='supports'
          AND evidence.acceptance IN ('verified','corroborated'))
        ELSE observation.event_date::text END AS "eventDate",
      to_jsonb(observation.source_modified_at) AS "sourceModifiedAt",
      to_jsonb(observation.fetched_at) AS "fetchedAt",
      observation.extractor_version AS "extractorVersion",
      jsonb_agg(DISTINCT jsonb_build_object(
        'recordId', evidence.permit_id, 'field', evidence.field,
        'acceptance', evidence.acceptance, 'relation', evidence.relation
      )) AS fields
    FROM eligible_observations observation
    JOIN sources source ON source.id = observation.source_id
    JOIN source_versions version ON version.id = observation.source_version_id
    JOIN permit_evidence evidence ON evidence.observation_id = observation.id
    JOIN eligible_permits permit ON permit.id = evidence.permit_id
    WHERE observation.id = $1
    GROUP BY observation.id, source.id, version.id, observation.event_date,
      observation.source_modified_at, observation.fetched_at, observation.extractor_version
  `, [id])
  return rows[0]
}
