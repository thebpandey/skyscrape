import type { Asset, EvaluationScope, RecordKind, TemplateId, TemplateRecord } from '../../../domain/src/templates/types.ts'

export interface CampaignQuery extends EvaluationScope {
  templateId?: TemplateId
  kinds: readonly RecordKind[]
  windowDays: number
  limit: number
  asset?: Asset
  permitClass?: string
  permitType?: string
}

export interface SourceProvenance {
  sourceId: string
  publisher: string
  sourceUrl: string
  license: string
  termsUrl: string
  attribution: string
  assessmentId: string
}

export interface SourceBatch {
  records: TemplateRecord[]
  provenance: SourceProvenance
  coverageGaps: string[]
}

export function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function windowStart(query: CampaignQuery) {
  if (!day(query.asOf) || !Number.isInteger(query.windowDays) || query.windowDays < 1 || query.windowDays > 3650
    || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000
    || !query.countyFips.every(code => /^\d{5}$/.test(code))) throw new RangeError('Invalid campaign bounds')
  return new Date(Date.parse(query.asOf) - (query.windowDays - 1) * 86400000).toISOString().slice(0, 10)
}

export function observedBy(value: unknown, asOf: string): value is string {
  return typeof value === 'string' && day(value.slice(0, 10))
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Date.parse(value) < Date.parse(asOf) + 86400000
}

export function empty(provenance: SourceProvenance, ...coverageGaps: string[]): SourceBatch {
  return { records: [], provenance, coverageGaps }
}
