import { randomUUID } from 'node:crypto'
import { readVettedEvidence } from '../../connectors/src/campaign-sources/index.ts'
import type { CampaignQuery, VettedGrant } from '../../connectors/src/campaign-sources/index.ts'
import type { CampaignConfig } from '../../contracts/src/campaign-config.ts'
import { evaluateTemplate, resolveTemplateId, validateCriteria } from '../../domain/src/templates/index.ts'
import type { RecordKind, TemplateRecord } from '../../domain/src/templates/index.ts'
import type { DatabasePool } from './index.ts'
import type { Tx } from './campaigns.ts'

type Reader = Pick<DatabasePool, 'query'>
type Grant = Omit<VettedGrant, 'evidenceAllowed'>
type Imported = TemplateRecord & { sourceVersionId: string; grant: Grant; synthetic: boolean }

export function recordKinds(draft: CampaignConfig): RecordKind[] {
  const settings = validateCriteria(draft.template, draft.criteria)
  if ('recordKind' in settings) return [settings.recordKind]
  if ('requiredKind' in settings) return [settings.requiredKind]
  if ('status' in settings || 'participantRole' in settings) return ['permit']
  if ('supplyMonths' in settings) return ['market','listing']
  if ('asset' in settings) return ['listing']
  if ('apn' in settings) return ['ownership','transfer']
  if ('role' in settings) return ['contact']
  return ['transfer','contact']
}

export async function evaluateImported(db: Reader, campaign: CampaignConfig, asOf: string) {
  const limit = Math.min(1000, campaign.limits.maxPages * 100)
  const kinds = recordKinds(campaign)
  const settings = validateCriteria(campaign.template, campaign.criteria)
  const requestedAssets = campaign.assetTypes
  let assets = 'asset' in settings && settings.asset !== 'any'
    ? (requestedAssets.length && !requestedAssets.includes(settings.asset) ? [] : [settings.asset])
    : requestedAssets.length ? requestedAssets : null
  const buyerContacts = kinds.includes('transfer') && kinds.includes('contact')
  // Listing changes can cite a preceding event outside the display window.
  const listingWatch = resolveTemplateId(campaign.template) === 'land_sfr_listing_watch'
  if (listingWatch && assets) assets = ['vacant_land', 'single_family'].filter(asset => assets?.includes(asset))
  const fetchDays = listingWatch ? 3650 : settings.windowDays
  const byKind: Partial<Record<RecordKind, object>> = {}
  if ('apn' in settings && settings.apn) byKind.transfer = byKind.ownership = { apn: settings.apn }
  if ('role' in settings) byKind.contact = { role: settings.role }
  if ('participantRole' in settings && settings.participantRole !== 'any') byKind.permit = { participantRole: settings.participantRole }
  if ('supplyMonths' in settings) byKind.market = { trailingMonths: settings.supplyMonths }
  if (buyerContacts) {
    byKind.contact = { role: 'acquisitions' }
    byKind.transfer = 'institutionType' in settings
      ? { asset: 'single_family', ...(settings.institutionType === 'any' ? {} : { buyerType: settings.institutionType }) }
      : { asset: 'vacant_land' }
  }
  const status = 'status' in settings ? settings.status.toLowerCase() : ''
  const subject = 'subjectId' in settings ? settings.subjectId : ''
  const { rows } = await db.query<Imported>(`
    SELECT source_id AS "sourceId",source_version_id AS "sourceVersionId",source_record_id AS "sourceRecordId", ARRAY[id] AS "evidenceIds",
      to_jsonb(fetched_at) AS "observedAt",event_date::text AS "eventDate",county_fips AS "countyFips",
      acceptance,facts,manifest->'synthetic'='true'::jsonb AS synthetic,
      (manifest->'campaignImport') || jsonb_build_object('sourceId',source_id,'eligible',true) AS grant
    FROM eligible_campaign_citations WHERE county_fips=ANY($1) AND facts->>'kind'=ANY($2)
      AND ((
        ($5::text[] IS NULL
          OR (manifest->'campaignImport'->'allowedFields' ? 'asset' AND facts->>'asset'=ANY($5))
          OR ($6 AND facts->>'kind'='contact')
          -- Intervening events can establish a listing reclassification.
          OR ($11 AND cardinality($5)>0 AND facts->>'kind'='listing'))
        AND facts @> coalesce($8::jsonb->(facts->>'kind'), '{}'::jsonb)
      ) OR ($6 AND facts->>'kind'='transfer' AND (
        (manifest->'campaignImport'->'allowedFields' ? 'relatedParty' AND facts @> '{"relatedParty":true}')
        OR (manifest->'campaignImport'->'allowedFields' ? 'nominal' AND facts @> '{"nominal":true}')
      )))
      AND (CASE WHEN facts->>'kind'='contact' THEN facts->>'checkedOn' ELSE event_date::text END)
        BETWEEN ($3::date-($7::int-1))::text AND $3::date::text
      AND ($9::text='' OR $9 IN (lower(facts->>'status'), lower(facts->>'rawStatus')))
      AND ($10::text='' OR $10 IN (facts->>'instrumentId',facts->>'buyerId',facts->>'apn',
        facts->>'listingId',facts->>'seriesId',facts->>'ownerId',facts->>'organizationId',
        facts->>'permitNumber',facts->>'projectId',facts->>'participantId'))
      AND fetched_at<(($3::date+1)::timestamp AT TIME ZONE 'UTC')
      AND (superseded_at IS NULL OR superseded_at>=(($3::date+1)::timestamp AT TIME ZONE 'UTC'))
      AND (coalesce(manifest->'synthetic','false'::jsonb)<>'true'::jsonb OR county_fips='00000')
    ORDER BY CASE WHEN $11 THEN event_date END DESC, fetched_at DESC,id LIMIT $4
  `, [campaign.geography.countyFips, kinds, asOf, limit+1, assets, buyerContacts, fetchDays, JSON.stringify(byKind), status, subject, listingWatch || 'supplyMonths' in settings])
  const limited = rows.length > limit
  if (limited) rows.pop()
  const sources = Map.groupBy(rows, row => row.sourceId)
  const query: CampaignQuery = { asOf, windowDays: fetchDays,
    templateId: resolveTemplateId(campaign.template),
    countyFips: campaign.geography.countyFips, kinds, limit, eligibleSourceIds: [...sources.keys()] }
  const accepted: TemplateRecord[] = []
  const gaps = new Set<string>()
  // The vetted reader accepts one revision per publisher record in each batch.
  const batches = Map.groupBy(rows, row => row.facts.kind === 'listing'
    ? row.sourceVersionId + '/' + row.eventDate : row.sourceVersionId)
  for (const batch of batches.values()) {
    const grant = batch[0].grant
    if (!Array.isArray(grant.allowedFields) || !kinds.includes(grant.kind)) {
      gaps.add('The source assessment lacks an approved field mapping.')
      continue
    }
    const refs = new Map(batch.map(row => [row.sourceRecordId,row.evidenceIds[0]]))
    const result = readVettedEvidence(query, { ...grant, evidenceAllowed: (record, ref) => refs.get(record) === ref }, batch)
    accepted.push(...result.records)
    result.coverageGaps.forEach(gap => gaps.add(gap))
  }
  const criteria = listingWatch && assets?.length === 1 ? { ...campaign.criteria, asset: assets[0] } : campaign.criteria
  const result = evaluateTemplate(campaign.template, criteria, accepted, query)
  result.coverageGaps.forEach(gap => gaps.add(gap))
  if (campaign.geography.countyFips.some(county => ['48453','48491','48209'].includes(county)) && kinds.includes('permit'))
    gaps.add('Austin city permits lack verified county attribution. Only county-vetted imports are included.')
  if (limited) gaps.add('The input record budget was reached.')
  if (result.rows.length < result.matchedRows) gaps.add('The result limit was reached.')
  return { ...result, coverageGaps: [...gaps], synthetic: rows.some(row => row.synthetic),
    observations: accepted.length, sources: [...sources.values()].map(([row]) => ({
      id: row.sourceId, name: row.grant.publisher, coverage: 'Qualified imported observations only', synthetic: row.synthetic === true,
    })), coveredCountyFips: [...new Set(accepted.filter(row => row.countyFips !== '00000').map(row => row.countyFips))] }
}

export async function launchImported(client: Tx, campaignId: string, version: number, campaign: CampaignConfig,
  trigger: string, due: Date | null) {
  const asOf = (due ?? new Date()).toISOString().slice(0,10)
  const result = await evaluateImported(client, campaign, asOf)
  const id = randomUUID()
  const unsupportedFields = campaign.requestedFields.filter(field => !result.rows.some(row => Object.hasOwn(row.values,field)))
  const state = result.coverageGaps.length || unsupportedFields.length ? 'partial' : 'completed'
  await client.query(`
    INSERT INTO runs(id,campaign_id,version,trigger,state,config_snapshot,started_at,finished_at,counters)
    VALUES($1,$2,$3,$4,$5,$6,now(),now(),$7)
  `, [id,campaignId,version,trigger,state,JSON.stringify({ campaign, kind: 'evaluated', asOf, synthetic: result.synthetic,
    scheduledFor: due?.toISOString() ?? null, model: null, coverageGaps: result.coverageGaps, unsupportedFields }),
    JSON.stringify({ observations: result.observations, matchedRows: result.matchedRows })])
  if (result.rows.length) await client.query(`
    INSERT INTO campaign_matches(run_id,ordinal,record_key,classification,event_date,fields,evidence_ids)
    SELECT $1,ordinal,key,classification,date,fields,refs FROM jsonb_to_recordset($2)
      AS r(ordinal integer,key text,classification text,date date,fields jsonb,refs uuid[])
  `, [id, JSON.stringify(result.rows.map((row, ordinal) => ({ ordinal, key: row.key, date: row.date, classification: row.classification, fields: Object.fromEntries(Object.entries(row.values)
    .filter(([field]) => campaign.requestedFields.includes(field))), refs: row.evidenceIds })))])
  return id
}
