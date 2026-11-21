import { request } from "node:http";
import {
  cancelAcknowledgement,
  collectionAuth,
  collectionError,
  collectionOperations,
  health,
  taskAccepted,
  taskRequest,
  taskStatus,
} from "../../../contracts/src/collection/index.ts";
import type { CollectionError, TaskRequest } from "../../../contracts/src/collection/index.ts";

const maxResponseBytes = 2 * 1024 * 1024;

export class CollectionServiceError extends Error {
  readonly status: number;
  readonly detail: CollectionError;

  constructor(status: number, detail: CollectionError) {
    super(detail.message);
    this.name = "CollectionServiceError";
    this.status = status;
    this.detail = detail;
  }
}

function validated<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new Error("Invalid collection protocol payload");
  return result.data;
}

function checkIdentity(task: { taskId: string; attemptId: string }, taskId: string, attemptId?: string) {
  if (task.taskId !== taskId || (attemptId !== undefined && task.attemptId !== attemptId)) {
    throw new Error("Collection response identifies a different attempt");
  }
}

export function createCollectionClient({
  socketPath,
  token,
  timeoutMs = 5_000,
}: {
  socketPath: string;
  token: string;
  timeoutMs?: number;
}) {
  function operation(
    method: "GET" | "POST",
    path: string,
    body?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const message = request({
        socketPath, method, path,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          [collectionAuth.header]: `Bearer ${token}`,
          ...(body === undefined ? {} : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }),
        },
      }, (response) => {
        let length = 0;
        const chunks: Buffer[] = [];
        response.on("error", () => reject(new Error("Collection response interrupted")));
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxResponseBytes) {
            reject(new Error("Collection response exceeds the supported size"));
            response.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          try {
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              const error = collectionError.safeParse(payload);
              if (error.success) throw new CollectionServiceError(status, error.data);
              throw new Error("Invalid collection error response");
            }
            resolve(payload);
          } catch (error) {
            reject(error instanceof CollectionServiceError ? error : new Error("Invalid collection response"));
          }
        });
      });
      message.on("error", () => reject(new Error("Collection service unavailable")));
      message.end(body);
    });
  }

  function taskPath(template: string, taskId: string, attemptId?: string) {
    const path = template.replace(":id", encodeURIComponent(taskId));
    return attemptId === undefined ? path : `${path}?attemptId=${encodeURIComponent(attemptId)}`;
  }

  return {
    async health() {
      const route = collectionOperations.health;
      return validated(health.safeParse(await operation(route.method, route.path)));
    },
    async submit(input: TaskRequest) {
      const route = collectionOperations.submit;
      const body = validated(taskRequest.safeParse(input));
      const accepted = validated(taskAccepted.safeParse(await operation(route.method, route.path, JSON.stringify(body))));
      checkIdentity(accepted, body.taskId, body.attemptId);
      return accepted;
    },
    async status(taskId: string, attemptId?: string) {
      const route = collectionOperations.status;
      const status = validated(taskStatus.safeParse(await operation(route.method, taskPath(route.path, taskId, attemptId))));
      checkIdentity(status.state === "finished" ? status.result : status, taskId, attemptId);
      return status;
    },
    async cancel(taskId: string, attemptId?: string) {
      const route = collectionOperations.cancel;
      const acknowledgement = validated(
        cancelAcknowledgement.safeParse(await operation(route.method, taskPath(route.path, taskId, attemptId))),
      );
      checkIdentity(acknowledgement, taskId, attemptId);
      return acknowledgement;
    },
  };
}
