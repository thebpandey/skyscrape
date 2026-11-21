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
  assert.equal(result.observations[0].artifactId, result.evidence[0].artifactId);
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
