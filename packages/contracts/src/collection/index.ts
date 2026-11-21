import { readFileSync } from "node:fs";
import { z } from "zod";
import type * as shapes from "./schema.js";

// Credentials belong to the transport. Every operation uses the same private service credential.
export const collectionOperations = {
  health: { method: "GET", path: "/internal/v1/health" },
  submit: { method: "POST", path: "/internal/v1/tasks" },
  status: { method: "GET", path: "/internal/v1/tasks/:id" },
  cancel: { method: "POST", path: "/internal/v1/tasks/:id/cancel" },
} as const;
export const collectionAuth = { scheme: "bearer", header: "Authorization" } as const;

// Each transport boundary selects a named entry from the same published schema as Python.
export const collectionSchema: z.core.JSONSchema.JSONSchema = JSON.parse(
  readFileSync(new URL("./v1.schema.json", import.meta.url), "utf8"),
);
function entry<T extends z.ZodType>(name: string): z.ZodType<z.output<T>> {
  return z.fromJSONSchema({ $schema: collectionSchema.$schema, $defs: collectionSchema.$defs,
    $ref: `#/$defs/${name}` }) as z.ZodType<z.output<T>>;
}

export const taskRequest = entry<typeof shapes.taskRequest>("TaskRequest");
export const taskAccepted = entry<typeof shapes.taskAccepted>("TaskAccepted");
export const taskStatus = entry<typeof shapes.taskStatus>("TaskStatus");
export const taskResult = entry<typeof shapes.taskResult>("TaskResult");
export const cancelAcknowledgement = entry<typeof shapes.cancelAcknowledgement>("CancelAcknowledgement");
export const health = entry<typeof shapes.health>("Health");
export const collectionError = entry<typeof shapes.collectionError>("CollectionError");
export type TaskRequest = z.infer<typeof taskRequest>;
export type TaskResult = z.infer<typeof taskResult>;
export type TaskStatus = z.infer<typeof taskStatus>;
export type CollectionError = z.infer<typeof collectionError>;
