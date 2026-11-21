import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { taskRequest } from "../../packages/contracts/src/collection/index.ts";

const token = "synthetic-only-secret-for-uds-check";
const fixtureDirectory = new URL("../fixtures/contracts/collection/", import.meta.url);
const clientEntry = new URL("../../packages/connectors/src/collection-client/index.ts", import.meta.url);
const runNode = promisify(execFile);

test("the native Node client exchanges and validates attempt identities over a Unix socket", async () => {
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
    await runNode(process.execPath, [
      "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        const [clientEntry, socketPath, token, input] = process.argv.slice(1);
        const { createCollectionClient } = await import(clientEntry);
        const request = JSON.parse(input);
        const collector = createCollectionClient({ socketPath, token });
        assert.equal((await collector.submit(request)).state, "accepted");
        assert.equal((await collector.status(request.taskId, request.attemptId)).state, "finished");
        await assert.rejects(collector.status(request.taskId, "wrong-attempt"), /different attempt/);
      `,
      clientEntry.href, socketPath, token, JSON.stringify(request),
    ], { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 4_000 });
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
