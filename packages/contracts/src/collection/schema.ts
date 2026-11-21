import { z } from "zod";

const version = z.literal(1);
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).meta({ id: "Identifier" });
const revision = z.string().min(1).max(80);
const time = z.iso.datetime().max(40).meta({ id: "UtcTimestamp" });
const method = z.enum(["structured", "html", "browser"]);
const hostPattern = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?/;
const url = z.string().max(2048).regex(new RegExp(String.raw`^https?://${hostPattern.source}(?:[/?][^\s\\#]*)?$`)).meta({ id: "SourceUrl" });
const count = (max: number) => z.int().min(0).max(max);
const counters = z.strictObject({
  requests: count(256), bytes: count(100_000_000), browserSeconds: count(600),
  quotaUnits: count(256), costMicros: z.literal(0),
}).meta({ id: "Counters" });
const identity = { protocolVersion: version, taskId: id, attemptId: id };
const field = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const selector = z.string().max(80).regex(/^[.#]?[a-zA-Z][a-zA-Z0-9_-]*$/).meta({ id: "SimpleSelector" });
const markup = z.strictObject({ field, selector });
const htmlRecipe = z.strictObject({ fields: z.array(markup).min(1).max(32) });
const task = {
  ...identity, runId: id, correlationId: id, sourceId: id, sourceVersion: revision, recipeVersion: revision,
  url, deadline: time, limits: counters,
  permissions: z.strictObject({
    assessmentId: id, allowedDomains: z.array(z.string().max(253).regex(new RegExp(`^${hostPattern.source}$`))).min(1).max(16),
  }),
};

// One approved method per attempt. A fallback gets its own budget and attempt ID.
export const taskRequest = z.discriminatedUnion("mode", [
  z.strictObject({ ...task, mode: z.literal("structured"), allowedMethods: z.tuple([z.literal("structured")]),
    recipe: z.strictObject({ format: z.enum(["json", "csv"]), fields: z.array(z.strictObject({
      field, key: z.string().min(1).max(80),
    })).min(1).max(32) }) }),
  z.strictObject({ ...task, mode: z.literal("html"), allowedMethods: z.tuple([z.literal("html")]), recipe: htmlRecipe }),
  z.strictObject({ ...task, mode: z.literal("browser"), allowedMethods: z.tuple([z.literal("browser")]),
    sessionRef: id.optional(), recipe: htmlRecipe.extend({ waitFor: selector.optional() }) }),
]).meta({ id: "TaskRequest" });

const evidence = z.strictObject({
  artifactId: id, sha256: z.string().length(64).regex(/^[0-9a-f]{64}$/), bytes: count(100_000_000),
  mediaType: z.enum(["text/html", "text/csv", "application/json", "application/pdf", "text/plain", "image/png"]),
}).meta({ id: "Evidence" });
const observation = z.strictObject({
  field, original: z.string().min(1).max(2048), normalized: z.union([z.string().max(2048), z.number(), z.boolean()]).optional(),
  artifactId: id, locator: z.string().min(1).max(200),
  recovery: z.strictObject({ originalSelector: selector, recoveredSelector: selector,
    method: z.literal("adaptive"), validation: z.enum(["unverified", "passed", "failed"]),
    matchScore: z.number().min(0).max(100).optional() }).optional(),
});
const message = z.string().min(1).max(400);
export const collectionError = z.strictObject({
  code: z.enum(["SOURCE_ACCESS_DENIED", "AUTH_REQUIRED", "CHALLENGE_REQUIRED", "RATE_LIMITED", "SOURCE_CHANGED",
    "PAGINATION_INCOMPLETE", "EMPTY_CONTENT", "PARTIAL_CONTENT", "PARSE_FAILED", "SCHEMA_MISMATCH",
    "FREE_QUOTA_EXHAUSTED", "POLICY_BLOCKED", "BUDGET_EXCEEDED", "STORAGE_FAILED", "INTERNAL_ERROR",
    "UNKNOWN_TASK", "UNSUPPORTED_PROTOCOL_VERSION"]),
  message, retryable: z.boolean(), correlationId: id, action: message, outcome: message,
  hypothesis: message.optional(), nextAction: message,
  provenance: z.strictObject({
    sourceId: id.optional(), runId: id.optional(), taskId: id.optional(), connectorVersion: revision.optional(),
  }).optional(),
}).meta({ id: "CollectionError" });
const manifest = {
  ...identity, finalUrl: url.optional(), redirects: z.array(url).max(10), retrievedAt: time,
  httpStatus: z.int().min(100).max(599).optional(), responseMediaType: z.string().min(1).max(255).optional(),
  contentClassification: z.enum(["expected", "challenge", "auth_required", "access_denied", "empty", "unexpected"]).optional(),
  sourceTimestamp: time.optional(), engineVersion: revision, browserVersion: revision.optional(), counters,
  evidence: z.array(evidence).max(32), observations: z.array(observation).max(128),
};
export const taskResult = z.discriminatedUnion("classification", [
  z.strictObject({ ...manifest, classification: z.literal("success"), finalUrl: url,
    evidence: z.array(evidence).min(1).max(32).meta({ id: "SuccessEvidence" }),
    observations: z.array(observation).min(1).max(128).meta({ id: "SuccessObservations" }) }),
  z.strictObject({ ...manifest, classification: z.enum(["partial", "failed"]), error: collectionError }),
]).meta({ id: "TaskResult" });

export const taskAccepted = z.strictObject({ ...identity, state: z.literal("accepted") }).meta({ id: "TaskAccepted" });
export const taskStatus = z.discriminatedUnion("state", [
  z.strictObject({ ...identity, state: z.enum(["queued", "running", "cancelled"]), counters }),
  z.strictObject({ protocolVersion: version, state: z.literal("finished"), result: taskResult }),
]).meta({ id: "TaskStatus" });
export const cancelAcknowledgement = z.strictObject({
  ...identity, cancellation: z.enum(["requested", "cancelled", "already_finished"]),
}).meta({ id: "CancelAcknowledgement" });
export const health = z.strictObject({
  protocolVersion: version, engineVersion: revision, modes: z.array(method).max(3),
}).meta({ id: "Health" });

export const collectionSchema = z.toJSONSchema(z.union([
  taskRequest, taskAccepted, taskStatus, taskResult, cancelAcknowledgement, health, collectionError,
]), { reused: "ref" });
