import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectionSchema, taskRequest, taskResult } from "../src/collection/index.ts";
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
