import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCollectionClient } from "../../packages/connectors/src/collection-client/index.js";
import { taskRequest } from "../../packages/contracts/src/collection/index.js";

const token = "synthetic-only-secret-for-uds-check";
const fixtureDirectory = new URL("../fixtures/contracts/collection/", import.meta.url);

test("the client exchanges and validates attempt identities over a local Unix socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c-"));
  const socketPath = join(directory, "c.sock");
  const request = taskRequest.parse(JSON.parse(await readFile(new URL("request.json", fixtureDirectory), "utf8")));
  const result: unknown = JSON.parse(await readFile(new URL("result.json", fixtureDirectory), "utf8"));
  const seen: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((incoming, response) => {
    seen.push({ url: incoming.url, authorization: incoming.headers.authorization });
    incoming.resume();
    response.setHeader("Content-Type", "application/json");
    if (incoming.method === "POST") {
      response.statusCode = 202;
      response.end(JSON.stringify({ protocolVersion: 1, state: "accepted", taskId: request.taskId, attemptId: request.attemptId }));
    } else {
      response.end(JSON.stringify({ protocolVersion: 1, state: "finished", result }));
    }
  });

  try {
    server.listen(socketPath);
    await once(server, "listening");
    const collector = createCollectionClient({ socketPath, token });
    await expect(collector.submit(request)).resolves.toMatchObject({ state: "accepted" });
    await expect(collector.status(request.taskId, request.attemptId)).resolves.toMatchObject({ state: "finished" });
    await expect(collector.status(request.taskId, "wrong-attempt")).rejects.toThrow("different attempt");
    expect(seen).toEqual([
      { url: "/internal/v1/tasks", authorization: `Bearer ${token}` },
      { url: `/internal/v1/tasks/${request.taskId}?attemptId=${request.attemptId}`, authorization: `Bearer ${token}` },
      { url: `/internal/v1/tasks/${request.taskId}?attemptId=wrong-attempt`, authorization: `Bearer ${token}` },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
