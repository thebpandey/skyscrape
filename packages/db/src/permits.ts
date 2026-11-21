import type { Evidence, PermitRecord } from '../../contracts/src/index.ts'
import { can, projectContacts } from '../../security/src/index.ts'
import type { Principal } from '../../security/src/index.ts'
import type { DatabasePool } from './index.ts'

type PermitFilter = {
  id?: string
  after?: string
  jurisdiction?: string
  permitNumber?: string
  limit: number
}

type PermitRow = Omit<PermitRecord, 'contacts'> & { contacts: Parameters<typeof projectContacts>[1] }

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

export async function readPermits(pool: DatabasePool, principal: Principal, filter: PermitFilter) {
  if (!can(principal, 'records:read')) return []
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
            WHERE evidence.permit_id = permit.id ORDER BY evidence.observation_id) AS "evidenceIds",
      CASE WHEN $6::boolean THEN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'channel', contact.channel, 'value', contact.value, 'checked_on', contact.checked_on,
          'verified', contact.verified, 'public_business', contact.public_business,
          'suppressed', contact.suppressed, 'person_suppressed', COALESCE(person.suppressed, false)
        ) ORDER BY contact.id), '[]'::jsonb)
        FROM contacts contact
        JOIN eligible_observations observation ON observation.id = contact.observation_id
        LEFT JOIN people person ON person.id = contact.person_id
        WHERE contact.checked_on <= CURRENT_DATE AND EXISTS (
          SELECT 1 FROM permit_participants participant
          JOIN eligible_observations participant_observation ON participant_observation.id = participant.observation_id
          WHERE participant.permit_id = permit.id AND participant.organization_id = contact.organization_id
            AND (contact.person_id IS NULL OR contact.person_id = participant.person_id)
        )
      ) ELSE '[]'::jsonb END AS contacts
    FROM page permit ORDER BY permit.id
  `, [filter.id, filter.after, filter.jurisdiction, filter.permitNumber, filter.limit, can(principal, 'contacts:read')])
  return rows.map(({ contacts, ...record }) => ({ ...record, contacts: projectContacts(principal, contacts) }))
}

export async function readEvidence(pool: DatabasePool, principal: Principal, id: string) {
  if (!can(principal, 'evidence:read')) return undefined
  const { rows } = await pool.query<Evidence>(`
    SELECT observation.id, source.name AS "sourceName", version.version AS "sourceVersion",
      observation.event_date::text AS "eventDate",
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
