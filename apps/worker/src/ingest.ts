import { createHash } from 'node:crypto'
import type { MunicipalPermitObservation } from '../../../packages/connectors/src/municipal/index.ts'
import type { Tx, SourcePlan } from '../../../packages/db/src/campaigns.ts'

export class ArtifactStorageError extends Error {}

export type PermitPage = {
  records: { permit: MunicipalPermitObservation; revision: string }[]
  resultSize: number
  bytes: number
  artifact: { digest: string; bytes: number; promote(storeKey: string): Promise<void> }
  fetchedAt: string
  finalUrl: string
  httpStatus: number | undefined
}

function sha256(data: string | Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

export function rowRevision(row: object) {
  return sha256(JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
}

function acceptedFields(permit: MunicipalPermitObservation) {
  const fields = new Map<string, string>()
  for (const assertion of permit.assertions) {
    if (assertion.acceptance !== 'verified' || typeof assertion.value !== 'string') continue
    switch (assertion.field) {
      case 'jurisdiction':
      case 'permitNumber':
        fields.set(assertion.field, assertion.value)
        break
      case 'permitStatus':
        if (typeof assertion.rawValue === 'string') fields.set('rawStatus', assertion.rawValue)
        fields.set('status', assertion.value.trim().toLowerCase())
        break
      case 'permitType':
        if (typeof assertion.rawValue === 'string') fields.set('rawType', assertion.rawValue)
        fields.set('permitType', assertion.value)
        break
      case 'issuedAt':
        fields.set('issuedOn', assertion.value.slice(0, 10))
        break
      case 'appliedAt':
        fields.set('appliedOn', assertion.value.slice(0, 10))
    }
  }
  return fields
}

export async function commitPage(client: Tx, input: {
  runId: string; taskId: string; source: SourcePlan; page: PermitPage
}) {
  const { runId, taskId, source, page } = input
  const { rows: [artifact] } = await client.query<{ id: string; store_key: string }>(
    'SELECT * FROM reserve_campaign_artifact($1,$2,$3)', [page.artifact.digest, page.artifact.bytes, taskId])
  if (!artifact) throw Error('Incompatible artifact identity')
  await client.query(`
    INSERT INTO retrieval_attempts(task_id,source_version_id,method,final_url,status,bytes,artifact_id)
    VALUES($1,$2,'structured',$3,$4,$5,$6)
  `, [taskId, source.versionId, page.finalUrl, page.httpStatus, page.bytes, artifact.id])

  let linked = 0
  for (const { permit, revision } of page.records) {
    const { rows: [created] } = await client.query<{ id: string }>(`
      INSERT INTO observations(source_id,source_version_id,source_record_id,revision_hash,source_url,
        event_date,source_modified_at,fetched_at,artifact_id,extractor_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(source_id,source_record_id,revision_hash) DO NOTHING RETURNING id
    `, [source.id, source.versionId, permit.sourceRecordId, revision, permit.sourceUrl, permit.eventDate,
      permit.sourceModifiedAt, permit.fetchedAt, artifact.id, permit.extractorVersion])
    const observation = created ?? (await client.query<{ id: string }>(`
      SELECT id FROM observations WHERE source_id=$1 AND source_record_id=$2 AND revision_hash=$3
    `, [source.id, permit.sourceRecordId, revision])).rows[0]
    const link = await client.query(`
      INSERT INTO run_observations(run_id,observation_id) VALUES($1,$2) ON CONFLICT DO NOTHING
    `, [runId, observation.id])
    linked += link.rowCount ?? 0
    if (!created) continue

    const fields = acceptedFields(permit)
    const { rows: [record] } = await client.query<{ id: string }>(`
      INSERT INTO permits(jurisdiction,permit_number,raw_status,status,raw_type,permit_type,
        issued_on,applied_on,last_observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(jurisdiction,permit_number) DO UPDATE
        SET raw_status=excluded.raw_status,status=excluded.status,raw_type=excluded.raw_type,
          permit_type=excluded.permit_type,issued_on=excluded.issued_on,applied_on=excluded.applied_on,
          last_observed_at=excluded.last_observed_at
        WHERE permits.last_observed_at IS NULL OR permits.last_observed_at<=excluded.last_observed_at
      RETURNING id
    `, [permit.jurisdiction, permit.permitNumber, fields.get('rawStatus'), fields.get('status'),
      fields.get('rawType'), fields.get('permitType'), fields.get('issuedOn'), fields.get('appliedOn'), permit.fetchedAt])
    const permitId = record?.id ?? (await client.query<{ id: string }>(`
      SELECT id FROM permits WHERE jurisdiction=$1 AND permit_number=$2
    `, [permit.jurisdiction, permit.permitNumber])).rows[0].id

    for (const [field, value] of fields) {
      await client.query(`
        WITH assertion AS (
          INSERT INTO field_assertions(subject_type,subject_id,field,value,acceptance,extractor_version)
          VALUES('permit',$1,$2,$3,'verified',$4) RETURNING id
        )
        INSERT INTO evidence_links(assertion_id,observation_id,relation)
        SELECT id,$5,'supports' FROM assertion
      `, [permitId, field, value, permit.extractorVersion, observation.id])
    }
  }
  try {
    await page.artifact.promote(artifact.store_key)
  } catch (cause) {
    throw new ArtifactStorageError('Artifact promotion failed', { cause })
  }
  return linked
}
