export type Asset = 'vacant_land' | 'single_family'
export type OrganizationType = 'builder' | 'developer' | 'fund' | 'reit' | 'operator' | 'manager' | 'other'
export type PermitRole = 'builder' | 'developer' | 'contractor' | 'applicant'
export type ListingStatus = 'active' | 'pending' | 'sold' | 'removed'
export type ContactRole = 'acquisitions' | 'general_business'

export type Facts =
  | { kind: 'transfer'; instrumentId: string; buyerId?: string; buyerType?: OrganizationType;
      asset?: Asset; apn?: string; relatedParty?: boolean; nominal?: boolean }
  | { kind: 'permit'; jurisdiction: string; permitNumber: string; rawStatus?: string; status?: string;
      rawType?: string; projectId?: string; participantId?: string; participantRole?: PermitRole }
  | { kind: 'ownership'; apn: string; ownerId: string; basis: 'assessor' | 'deed' }
  | { kind: 'listing'; listingId: string; asset: Asset; status?: ListingStatus;
      price?: { amount: number; currency: string; type: 'asking_cash' | 'closing' | 'down_payment' | 'monthly_payment' | 'valuation' | 'model_estimate' } }
  | { kind: 'market'; seriesId: string; asset: Asset; trailingMonths: number; completeCoverage: boolean;
      activeInventory: number | null; closedTransactions: number | null }
  | { kind: 'contact'; organizationId: string; role: ContactRole; channel: 'website' | 'email' | 'phone';
      verifiedPublicBusiness: boolean; suppressed: boolean; checkedOn: string }
export type RecordKind = Facts['kind']

/** Each row describes one accepted observation. All populated facts must be supported by the cited evidence. */
export interface TemplateRecord {
  sourceId: string
  sourceRecordId: string
  evidenceIds: readonly string[]
  acceptance: 'verified' | 'corroborated' | 'inferred' | 'conflicted' | 'unknown' | 'stale'
  observedAt: string
  eventDate?: string | null
  countyFips: string
  facts: Facts
}

export interface EvaluationScope {
  asOf: string // inclusive UTC calendar date
  countyFips: readonly string[]
  eligibleSourceIds: readonly string[] // currently eligible for these counties, fields and use
}

export interface TemplateRow {
  key: string
  classification: string
  date: string | null
  values: Record<string, string | number | boolean | null>
  evidenceIds: string[]
}

export interface TemplateEvaluation {
  templateId: TemplateId
  rows: TemplateRow[]
  coverageGaps: string[]
  matchedRows: number // before result limit
}

export interface SettingsByTemplate {
  land_buyer_discovery: { minAcquisitions: number }
  builder_activity: { participantRole: 'any' | PermitRole }
  institutional_sfr_acquisition_research: { institutionType: 'any' | 'fund' | 'reit' | 'operator' }
  permit_monitoring: { status: string }
  ownership_transfer_lookup: { apn: string }
  land_sfr_listing_watch: { asset: 'any' | Asset }
  market_snapshot: { asset: Asset; supplyMonths: number }
  contact_enrichment: { role: ContactRole }
  source_gap_investigation: { requiredKind: RecordKind }
  custom_research: { recordKind: RecordKind; subjectId: string }
}

export type TemplateId = keyof SettingsByTemplate
export type TemplateCriteria<K extends TemplateId = TemplateId> =
  SettingsByTemplate[K] & { windowDays: number; maxResults: number }

export type Setting =
  | { kind: 'integer'; min: number; max: number; default: number }
  | { kind: 'choice'; options: readonly string[]; default: string }
  | { kind: 'text'; maxLength: number; default: string }

export interface TemplateDefinition {
  id: TemplateId
  title: string
  aliases: readonly string[]
  settings: Readonly<Record<string, Setting>>
}
