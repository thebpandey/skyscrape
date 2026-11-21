import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AUSTIN_PERMITS_SOURCE,
  AUSTIN_PERMITS_URL,
  SEATTLE_PERMITS_SOURCE,
  SEATTLE_PERMITS_URL,
  buildAustinPermitsUrl,
  buildSeattlePermitsUrl,
  normalizeAustinPermit,
  normalizeSeattlePermit,
  type MunicipalPermitObservation,
} from "../src/municipal/index.ts";

const fixture = JSON.parse(readFileSync(
  new URL("../../../tests/fixtures/municipal/permits.json", import.meta.url), "utf8",
));
const evidence = {
  fetchedAt: "2026-11-21T12:00:00.000Z",
  evidenceRef: "synthetic-permit-page",
  evidenceDigest: "ab".repeat(32),
};

function assertion(observation: MunicipalPermitObservation, field: string) {
  const found = observation.assertions.find((candidate) => candidate.field === field);
  assert.ok(found, field);
  return found;
}

test("builds only the assessed, bounded issued-permit queries", () => {
  assert.equal(AUSTIN_PERMITS_URL, "https://data.austintexas.gov/resource/3syk-w9eu.json");
  assert.equal(SEATTLE_PERMITS_URL, "https://data.seattle.gov/resource/76t5-zqzr.json");
  for (const [source, url, endpoint, columns, order] of [
    [AUSTIN_PERMITS_SOURCE, new URL(buildAustinPermitsUrl({ limit: 25, offset: 50 })),
      AUSTIN_PERMITS_URL, "project_id,permit_number,issue_date,permittype",
      "issue_date DESC,project_id ASC,:id ASC"],
    [SEATTLE_PERMITS_SOURCE, new URL(buildSeattlePermitsUrl({ limit: 25, offset: 50 })),
      SEATTLE_PERMITS_URL, "permitnum,issueddate,permittypemapped",
      "issueddate DESC,permitnum ASC,:id ASC"],
  ] as const) {
    assert.equal(url.origin + url.pathname, endpoint);
    assert.equal(url.host, source.allowedHost);
    assert.ok(source.allowedPaths.includes(url.pathname));
    const projection = url.searchParams.get("$select");
    assert.ok(projection?.startsWith(columns));
    assert.ok(!/contact|contractor|applicant|description(?=,|$)/.test(projection ?? ""));
    assert.equal(url.searchParams.get("$order"), order);
    assert.equal(url.searchParams.get("$limit"), "25");
    assert.equal(url.searchParams.get("$offset"), "50");
    assert.equal(source.costMode, "free-only");
    assert.equal(source.quota, null);
    assert.equal(source.crawlDelaySeconds, 1);
  }
  assert.equal(new URL(buildAustinPermitsUrl()).searchParams.get("$where"), null);
  const seattle = new URL(buildSeattlePermitsUrl());
  assert.equal(seattle.searchParams.get("$where"), "issueddate IS NOT NULL");
  assert.equal(seattle.searchParams.get("$limit"), "100");
  assert.throws(() => buildAustinPermitsUrl({ limit: 101 }), RangeError);
  assert.throws(() => buildSeattlePermitsUrl({ offset: -1 }), RangeError);
});

test("Austin supplies source-qualified natural IDs and publisher-scoped trade evidence", () => {
  assert.equal(fixture.synthetic, true);
  const permit = normalizeAustinPermit(fixture.austin, evidence);
  assert.ok(permit);
  assert.equal(permit.sourceRecordId, "austin-issued-construction-permits:record:9007199254740993");
  assert.equal(permit.permitId, "austin-issued-construction-permits:permit:1901 000007 EP");
  assert.equal(permit.eventId, "austin-issued-construction-permits:issuance:1901 000007 EP");
  const provenance = {
    ...evidence,
    sourceId: "austin-issued-construction-permits",
    sourceRecordId: "austin-issued-construction-permits:record:9007199254740993",
    sourceUrl: AUSTIN_PERMITS_URL,
    extractorVersion: "1",
    eventDate: "2024-02-29T08:00:00.000",
    sourceModifiedAt: null,
  };
  assert.deepEqual(assertion(permit, "jurisdiction"), {
    ...provenance, field: "jurisdiction", sourceField: null, rawValue: null,
    value: "Austin, TX", acceptance: "verified",
  });
  assert.deepEqual(assertion(permit, "permitNumber"), {
    ...provenance, field: "permitNumber", sourceField: "permit_number", rawValue: " 1901 000007 EP ",
    value: "1901 000007 EP", acceptance: "verified",
  });
  assert.equal(assertion(permit, "permitType").value, "EP");
  assert.deepEqual(assertion(permit, "permitStatus"), {
    ...provenance, field: "permitStatus", sourceField: "status_current", rawValue: " Final ",
    value: "Final", acceptance: "verified",
  });
  assert.equal(assertion(permit, "statusAt").value, "2024-03-15T08:00:00.000");
  assert.equal(assertion(permit, "localAppraisalId").value, "000123");
  assert.equal(assertion(permit, "postalCode").value, "00501");
  assert.equal(assertion(permit, "reportedPermitValuationUsd").value, "0.00");
  assert.equal(assertion(permit, "reportedPermitHousingUnits").value, 2);
  assert.ok(!permit.assertions.some(({ field }) => ["completedAt", "housingUnits", "projectStatus"].includes(field)));
});

test("Seattle preserves permit tracking numbers, net changes and unknown cost", () => {
  const permit = normalizeSeattlePermit(fixture.seattle, evidence);
  assert.ok(permit);
  assert.equal(permit.sourceRecordId, "seattle-building-permits:record:000123");
  assert.equal(permit.eventId, "seattle-building-permits:issuance:000123");
  const expected = [
    ["jurisdiction", null, null, "Seattle, WA"],
    ["permitNumber", "permitnum", " 000123 ", "000123"],
    ["reportedNetHousingUnits", "housingunits", "-2", -2],
    ["estimatedProjectCostUsd", "estprojectcost", null, null],
  ] as const;
  for (const [field, sourceField, rawValue, value] of expected) {
    assert.deepEqual(assertion(permit, field), {
      ...evidence,
      field, sourceField, rawValue, value,
      sourceId: "seattle-building-permits",
      sourceRecordId: "seattle-building-permits:record:000123",
      sourceUrl: SEATTLE_PERMITS_URL,
      extractorVersion: "1",
      eventDate: "2024-04-01T00:00:00.000",
      sourceModifiedAt: null,
      acceptance: value === null ? "unknown" : "verified",
    });
  }
  assert.equal(assertion(permit, "reportedHousingUnitsAdded").value, 0);
  assert.equal(assertion(permit, "postalCode").value, "98101-0001");
});

test("accepts Austin numeric keys but keeps unavailable dates and measures unknown", () => {
  const row = { project_id: 123, permit_number: "LEGACY 01", original_zip: 78701, housing_units: " " };
  const permit = normalizeAustinPermit(row, evidence);
  assert.ok(permit);
  assert.equal(permit.sourceRecordKey, "123");
  assert.equal(permit.rawSourceRecordKey, 123);
  assert.equal(assertion(permit, "postalCode").value, "78701");
  assert.equal(assertion(permit, "reportedPermitHousingUnits").acceptance, "unknown");
  assert.equal(permit.eventDate, null);
  assert.equal(normalizeAustinPermit({ ...row, project_id: "123" }, evidence)?.sourceRecordId, permit.sourceRecordId);
});

test("rejects rows without usable identity or issuance and requires evidence for accepted rows", () => {
  assert.equal(normalizeAustinPermit({ ...fixture.austin, project_id: 9007199254740992 }, evidence), null);
  assert.equal(normalizeAustinPermit({ ...fixture.austin, permit_number: 123 }, evidence), null);
  assert.equal(normalizeSeattlePermit({ ...fixture.seattle, issueddate: undefined }, evidence), null);
  assert.equal(normalizeSeattlePermit({ ...fixture.seattle, issueddate: "2024-02-30T00:00:00.000" }, evidence), null);
  assert.throws(() => normalizeSeattlePermit(fixture.seattle, { ...evidence, evidenceDigest: "" }), TypeError);
});
