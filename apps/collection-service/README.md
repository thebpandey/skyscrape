# Isolated collection service

From the repository root, combine the collection service with the egress proxy. Set `COLLECTION_DNS_IPV4` to your trusted DNS resolver and `COLLECTION_SERVICE_TOKEN_FILE` to the absolute path of a private file containing a randomly generated URL-safe token. Give the collector's group, GID 10001, read access to the file.

```sh
docker compose --project-directory . -f infra/compose/collection-network.yaml \
  -f infra/compose/collector.yaml up --build -d collector
```

For a combined private deployment, pass `-f compose.yaml` first and the caller's Compose fragment last. Mount `collector_socket` at `/run/collection` and `collector_artifacts` at `/var/staging/collection` read-only in the caller. Give the caller supplemental group 10001 and supply the same private service token. Keep the caller, database, and LLM gateway off the collection networks. The collector has no host port and joins only `collection_private`. [Network and DNS requirements](../../infra/egress/README.md)

Use `createCollectionClient({ socketPath, token })` from `packages/connectors/src/collection-client` with `/run/collection/collection.sock`. The client validates each payload against the shared collection protocol. Every operation requires the bearer credential.

| Operation | Method and path |
| --- | --- |
| Health and supported modes | `GET /internal/v1/health` |
| Submit an attempt | `POST /internal/v1/tasks` |
| Poll an attempt | `GET /internal/v1/tasks/:id?attemptId=<attempt-id>` |
| Cancel an attempt | `POST /internal/v1/tasks/:id/cancel?attemptId=<attempt-id>` |

Use the task ID as `:id`. Omit `attemptId` to select the most recently admitted attempt for that task. Send the same complete request when retrying a submission with the same attempt ID. Use a new attempt ID after an unknown attempt or service restart. Keep durable attempt state in the worker and poll promptly. The collector retains up to 128 finished statuses for at most 15 minutes and records up to 65,536 admitted attempt identities per process lifetime for deduplication.

Resolve an artifact ID relative to the staging directory. Before promotion, verify that it names a regular file with the expected type, size, and SHA-256. Keep staging files private. The shared staging volume is a 128 MiB tmpfs. Promote evidence while the service and an authorized caller mount the volume. The collector removes its staging files older than 30 minutes when it stages new evidence.

Structured mode accepts the assessed Austin and Seattle JSON endpoints and the Census county CSV-shaped download. HTML mode accepts the Austin and Seattle dataset pages. A task supplies its source assessment and bounded extraction recipe. The collector enforces the host, path, mode, egress policy, and one-second request spacing per publisher. Each attempt is limited to 8 MiB of response data and 128 observations. Browser mode, session-based retrieval, and the live Census file parser remain pending qualification. [Qualification record](../../docs/scrapling-evaluation.md)

Run `bash tests/security/collection_network.sh` from the repository root for an isolated check with synthetic TLS, DNS, and publishers. Use the command with Docker Engine 28 or later and Compose 2.36 or later. The fixture publishes no ports. [Task schema](../../packages/contracts/src/collection/v1.schema.json)
