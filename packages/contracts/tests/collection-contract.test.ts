import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectionError, collectionSchema, taskRequest, taskResult } from "../src/collection/index.ts";
import { collectionSchema as generated } from "../src/collection/schema.ts";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/fixtures/contracts/collection/${name}.json`, import.meta.url), "utf8",
));

test("published schema matches the TypeScript data shapes", () => {
  assert.deepEqual(collectionSchema, generated);
});

test("shared examples validate as a request and an evidence-bearing result", () => {
  const request = taskRequest.parse(fixture("request"));
  const result = taskResult.parse(fixture("result"));
  assert.equal(result.attemptId, request.attemptId);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.observations[0].artifactId, result.evidence[0].artifactId);
});

test("a failed challenge retains response metadata and screenshot evidence", () => {
  const result = taskResult.parse(fixture("challenge-result"));
  const { classification, httpStatus, responseMediaType, contentClassification, evidence } = result;
  assert.deepEqual(
    [classification, httpStatus, responseMediaType, contentClassification, evidence[0].mediaType],
    ["failed", 200, "text/html", "challenge", "image/png"],
  );
  assert.equal(taskResult.safeParse({ ...result, responseMediaType: "x".repeat(256) }).success, false);
  assert.equal(taskResult.safeParse({ ...result, contentClassification: "custom" }).success, false);
});

test("HTTP status is optional before a response and bounded when present", () => {
  const result = fixture("challenge-result");
  for (const field of ["httpStatus", "responseMediaType", "contentClassification", "finalUrl"]) {
    delete result[field];
  }
  const failure = {
    ...result,
    counters: { ...result.counters, requests: 0, bytes: 0, browserSeconds: 0, quotaUnits: 0 },
    evidence: [],
    error: { ...result.error, code: "BUDGET_EXCEEDED", message: "Request budget exhausted",
      outcome: "No request attempted", nextAction: "Review task limits" },
  };
  assert.deepEqual(taskResult.parse(failure), failure);
  const success = fixture("result");
  for (const status of [99, 600, 200.5]) {
    assert.equal(taskResult.safeParse({ ...success, httpStatus: status }).success, false, `status ${status}`);
  }
});

test("adaptive recovery preserves an exposed match score and accepts its omission", () => {
  const result = fixture("result");
  const recovery = { originalSelector: ".parcel-id", recoveredSelector: "#parcel-id", method: "adaptive", validation: "unverified" };
  const observation = { ...result.observations[0], locator: "#parcel-id", recovery };
  assert.deepEqual(taskResult.parse({ ...result, observations: [observation] }).observations[0].recovery, recovery);
  const withScore = { ...observation, recovery: { ...recovery, matchScore: 87.5 } };
  assert.equal(taskResult.parse({ ...result, observations: [withScore] }).observations[0].recovery?.matchScore, 87.5);
  const outOfRange = { ...observation, recovery: { ...recovery, matchScore: 100.5 } };
  assert.equal(taskResult.safeParse({ ...result, observations: [outOfRange] }).success, false);
});

test("SHA-256 evidence rejects a trailing line feed", () => {
  const result = fixture("result");
  result.evidence[0].sha256 += "\n";
  assert.equal(taskResult.safeParse(result).success, false);
});

test("a recipe rejects an unrecognized operation", () => {
  const request = fixture("request");
  request.recipe.evaluate = "untrusted";
  assert.equal(taskRequest.safeParse(request).success, false);
});

test("a successful result requires a final URL", () => {
  const result = fixture("result");
  delete result.finalUrl;
  assert.equal(taskResult.safeParse(result).success, false);
});

for (const field of ["evidence", "observations"]) {
  test(`a successful result rejects empty ${field}`, () => {
    assert.equal(taskResult.safeParse({ ...fixture("result"), [field]: [] }).success, false);
  });
}

test("a collection error carries the provenance that is known", () => {
  const { sourceId, runId, taskId, correlationId } = fixture("request");
  const error = {
    code: "SOURCE_CHANGED", message: "Field is missing", retryable: false, correlationId,
    action: "Extract field", outcome: "Field absent", nextAction: "Review connector",
  };
  const contextual = { ...error, provenance: { sourceId, runId, taskId, connectorVersion: "2026.1" } };
  assert.deepEqual(collectionError.parse(contextual), contextual);
  const unknownTask = { ...error, code: "UNKNOWN_TASK" };
  const partialContext = { ...unknownTask, provenance: { runId } };
  assert.deepEqual(collectionError.parse(partialContext), partialContext);
  assert.deepEqual(collectionError.parse(unknownTask), unknownTask);
});
