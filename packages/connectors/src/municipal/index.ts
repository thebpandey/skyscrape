export const AUSTIN_PERMITS_SOURCE_ID = "austin-issued-construction-permits";
export const SEATTLE_PERMITS_SOURCE_ID = "seattle-building-permits";
export const AUSTIN_PERMITS_URL = "https://data.austintexas.gov/resource/3syk-w9eu.json";
export const SEATTLE_PERMITS_URL = "https://data.seattle.gov/resource/76t5-zqzr.json";
export const MUNICIPAL_MAX_PAGE_ROWS = 100;

export type MunicipalPermitSourceId =
  | typeof AUSTIN_PERMITS_SOURCE_ID
  | typeof SEATTLE_PERMITS_SOURCE_ID;

export interface MunicipalPermitPage {
  limit?: number;
  offset?: number;
}

export interface MunicipalPermitEvidence {
  fetchedAt: string;
  evidenceRef: string;
  evidenceDigest: string;
}

type PublisherValue = string | number | boolean | null;
type AcceptedValue = string | number;

interface PermitProvenance extends MunicipalPermitEvidence {
  sourceId: MunicipalPermitSourceId;
  sourceRecordId: string;
  sourceUrl: string;
  extractorVersion: string;
  eventDate: string | null;
  sourceModifiedAt: null;
}

type PermitField = "jurisdiction" | "permitNumber" | "issuedAt"
  | (typeof austinFields | typeof seattleFields)[number][0];

export type MunicipalFieldAssertion = PermitProvenance & {
  field: PermitField;
  sourceField: string | null;
  rawValue: PublisherValue;
} & (
  | { acceptance: "verified"; value: AcceptedValue }
  | { acceptance: "unknown"; value: null }
);

export interface MunicipalPermitObservation extends PermitProvenance {
  sourceRecordKey: string;
  rawSourceRecordKey: PublisherValue;
  permitId: string;
  eventId: string;
  jurisdiction: "Austin, TX" | "Seattle, WA";
  permitNumber: string;
  assertions: MunicipalFieldAssertion[];
}

const access = {
  family: "socrata-soda2",
  version: "1",
  assessment: "eligible",
  assessedOn: "2026-11-21",
  license: "Public domain",
  costMode: "free-only",
  authentication: "anonymous",
  quota: null,
  quotaReset: null,
  crawlDelaySeconds: 1,
  updateCadence: "daily",
} as const;

export const AUSTIN_PERMITS_SOURCE = Object.freeze({
  ...access,
  id: AUSTIN_PERMITS_SOURCE_ID,
  datasetId: "3syk-w9eu",
  jurisdiction: "Austin, TX",
  publisher: "City of Austin Development Services",
  attribution: "City of Austin Development Services, Issued Construction Permits",
  datasetUrl: "https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu/about_data",
  termsUrl: "https://data.austintexas.gov/download/2z87-8uh7/application/pdf",
  queryUrl: AUSTIN_PERMITS_URL,
  metadataUrl: "https://data.austintexas.gov/api/views/3syk-w9eu",
  robotsUrl: "https://data.austintexas.gov/robots.txt",
  allowedHost: "data.austintexas.gov",
  allowedPaths: Object.freeze(["/resource/3syk-w9eu.json", "/api/views/3syk-w9eu", "/robots.txt"]),
  coverageStartYear: 1980,
  reuseConditions: "Credit the city and preserve the source URL and retrieval date.",
  limitations: "Informational issued permits, including trade permits. Project ID uniqueness and a row-update watermark remain unconfirmed. Status date covers status or expiry changes.",
});

export const SEATTLE_PERMITS_SOURCE = Object.freeze({
  ...access,
  id: SEATTLE_PERMITS_SOURCE_ID,
  datasetId: "76t5-zqzr",
  jurisdiction: "Seattle, WA",
  publisher: "Seattle Department of Construction and Inspections",
  attribution: "Seattle Department of Construction and Inspections, Building Permits",
  datasetUrl: "https://data.seattle.gov/Built-Environment/Building-Permits/76t5-zqzr/about_data",
  termsUrl: "https://www.seattle.gov/documents/Departments/Tech/OpenData/COS_OpenDataPolicy.pdf",
  queryUrl: SEATTLE_PERMITS_URL,
  metadataUrl: "https://data.seattle.gov/api/views/76t5-zqzr",
  robotsUrl: "https://data.seattle.gov/robots.txt",
  allowedHost: "data.seattle.gov",
  allowedPaths: Object.freeze(["/resource/76t5-zqzr.json", "/api/views/76t5-zqzr", "/robots.txt"]),
  coverageStartYear: null,
  reuseConditions: "Retain source version and disclose changes when required. Respect the city privacy and public-risk conditions.",
  limitations: "Feed includes in-progress records. Earliest complete year and a row-update watermark remain unconfirmed. A development site can span multiple parcels.",
});

type NormalizeValue = (raw: PublisherValue) => AcceptedValue | null;

function permitText(raw: PublisherValue): string | null {
  return typeof raw === "string" ? raw.trim() || null : null;
}

function digits(raw: PublisherValue): string | null {
  const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : permitText(raw);
  return text !== null && /^-?\d+$/.test(text) ? text : null;
}

function decimal(raw: PublisherValue): string | null {
  const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : permitText(raw);
  return text !== null && /^-?\d+(?:\.\d+)?$/.test(text) ? text : null;
}

function integer(raw: PublisherValue): number | null {
  const text = digits(raw);
  const value = text === null ? NaN : Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function calendarDate(raw: PublisherValue): string | null {
  const text = permitText(raw);
  if (text === null || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?)?$/.test(text)) {
    return null;
  }
  const day = text.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(day) ? text : null;
}

type ColumnMapping = readonly [column: string, normalize: NormalizeValue];
const austinFields = [
  ["permitType", "permittype", permitText],
  ["permitTypeDescription", "permit_type_desc", permitText],
  ["permitClass", "permit_class", permitText],
  ["permitClassMapped", "permit_class_mapped", permitText],
  ["workClass", "work_class", permitText],
  ["permitStatus", "status_current", permitText],
  ["appliedAt", "applieddate", calendarDate],
  ["expiresAt", "expiresdate", calendarDate],
  ["statusAt", "statusdate", calendarDate],
  ["siteAddress", "original_address1", permitText],
  ["postalCode", "original_zip", digits],
  ["localAppraisalId", "tcad_id", permitText],
  ["reportedPermitValuationUsd", "total_job_valuation", decimal],
  ["reportedPermitHousingUnits", "housing_units", integer],
] as const satisfies readonly (readonly [field: string, ...ColumnMapping])[];

const seattleFields = [
  ["permitType", "permittypemapped", permitText],
  ["permitTypeDescription", "permittypedesc", permitText],
  ["permitClass", "permitclass", permitText],
  ["permitClassMapped", "permitclassmapped", permitText],
  ["permitStatus", "statuscurrent", permitText],
  ["appliedAt", "applieddate", calendarDate],
  ["expiresAt", "expiresdate", calendarDate],
  ["completedAt", "completeddate", calendarDate],
  ["siteAddress", "originaladdress1", permitText],
  ["postalCode", "originalzip", permitText],
  ["estimatedProjectCostUsd", "estprojectcost", decimal],
  ["reportedNetHousingUnits", "housingunits", integer],
  ["reportedHousingUnitsAdded", "housingunitsadded", integer],
  ["reportedHousingUnitsRemoved", "housingunitsremoved", integer],
] as const satisfies readonly (readonly [field: string, ...ColumnMapping])[];

interface Dataset {
  source: typeof AUSTIN_PERMITS_SOURCE | typeof SEATTLE_PERMITS_SOURCE;
  recordKey: ColumnMapping;
  permitNumber: string;
  issuedAt: string;
  requireIssuedDate: boolean;
  fields: readonly (readonly [field: PermitField, ...ColumnMapping])[];
}

const austin: Dataset = {
  source: AUSTIN_PERMITS_SOURCE,
  recordKey: ["project_id", digits],
  permitNumber: "permit_number",
  issuedAt: "issue_date",
  requireIssuedDate: false,
  fields: austinFields,
};

const seattle: Dataset = {
  source: SEATTLE_PERMITS_SOURCE,
  recordKey: ["permitnum", permitText],
  permitNumber: "permitnum",
  issuedAt: "issueddate",
  requireIssuedDate: true,
  fields: seattleFields,
};

function pageUrl(dataset: Dataset, { limit = MUNICIPAL_MAX_PAGE_ROWS, offset = 0 }: MunicipalPermitPage): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MUNICIPAL_MAX_PAGE_ROWS
    || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Invalid municipal permit page bounds");
  }

  const { source, recordKey: [recordColumn], permitNumber, issuedAt, fields } = dataset;
  const select = new Set([recordColumn, permitNumber, issuedAt]);
  for (const [, column] of fields) select.add(column);

  // Offset pages order a snapshot. A complete live backfill needs a verified update watermark.
  const url = new URL(source.queryUrl);
  url.searchParams.set("$select", [...select].join(","));
  url.searchParams.set("$order", `${issuedAt} DESC,${recordColumn} ASC,:id ASC`);
  if (dataset.requireIssuedDate) url.searchParams.set("$where", `${issuedAt} IS NOT NULL`);
  url.searchParams.set("$limit", String(limit));
  url.searchParams.set("$offset", String(offset));
  return url.href;
}

function publisherValue(row: object, column: string): PublisherValue {
  const value: unknown = Object.getOwnPropertyDescriptor(row, column)?.value;
  return typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

function normalizeRow(dataset: Dataset, row: unknown, evidence: MunicipalPermitEvidence): MunicipalPermitObservation | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;

  const { source, recordKey: [recordColumn, normalizeKey] } = dataset;
  const rawSourceRecordKey = publisherValue(row, recordColumn);
  const sourceRecordKey = normalizeKey(rawSourceRecordKey);
  const rawNumber = publisherValue(row, dataset.permitNumber);
  const permitNumber = permitText(rawNumber);
  const rawIssuedAt = publisherValue(row, dataset.issuedAt);
  const eventDate = calendarDate(rawIssuedAt);
  if (typeof sourceRecordKey !== "string" || permitNumber === null
    || (dataset.requireIssuedDate && eventDate === null)) return null;

  const { fetchedAt, evidenceRef, evidenceDigest } = evidence;
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(fetchedAt)
    || !Number.isFinite(Date.parse(fetchedAt)) || !evidenceRef.trim() || !/^[0-9a-f]{64}$/i.test(evidenceDigest)) {
    throw new TypeError("Invalid municipal permit evidence context");
  }

  const provenance: PermitProvenance = {
    sourceId: source.id,
    sourceRecordId: `${source.id}:record:${sourceRecordKey}`,
    sourceUrl: source.queryUrl,
    extractorVersion: source.version,
    fetchedAt,
    evidenceRef,
    evidenceDigest,
    eventDate,
    sourceModifiedAt: null,
  };

  const assertions: MunicipalFieldAssertion[] = [];
  function assertField(field: PermitField, sourceField: string | null, rawValue: PublisherValue, value: AcceptedValue | null) {
    const assertion = { ...provenance, field, sourceField, rawValue };
    assertions.push(value === null
      ? { ...assertion, acceptance: "unknown", value }
      : { ...assertion, acceptance: "verified", value });
  }

  assertField("jurisdiction", null, null, source.jurisdiction);
  assertField("permitNumber", dataset.permitNumber, rawNumber, permitNumber);
  assertField("issuedAt", dataset.issuedAt, rawIssuedAt, eventDate);
  for (const [field, column, normalize] of dataset.fields) {
    const raw = publisherValue(row, column);
    assertField(field, column, raw, normalize(raw));
  }

  return {
    ...provenance,
    sourceRecordKey,
    rawSourceRecordKey,
    permitId: `${source.id}:permit:${permitNumber}`,
    eventId: `${source.id}:issuance:${permitNumber}`,
    jurisdiction: source.jurisdiction,
    permitNumber,
    assertions,
  };
}

export function buildAustinPermitsUrl(page: MunicipalPermitPage = {}): string {
  return pageUrl(austin, page);
}

export function buildSeattlePermitsUrl(page: MunicipalPermitPage = {}): string {
  return pageUrl(seattle, page);
}

export function normalizeAustinPermit(row: unknown, evidence: MunicipalPermitEvidence): MunicipalPermitObservation | null {
  return normalizeRow(austin, row, evidence);
}

export function normalizeSeattlePermit(row: unknown, evidence: MunicipalPermitEvidence): MunicipalPermitObservation | null {
  return normalizeRow(seattle, row, evidence);
}
