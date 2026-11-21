# Land Intelligence Workbench — Autonomous Implementation Plan

Version: 1.1 • Prepared: 2026-11-14 • Updated: 2026-11-16
Product authority: `01_Land_Intelligence_PRD.md` (required companion).
Requested orchestration: Use the installed Lanes harness.

## Revision 1.1

This revision replaces the proposed custom HTML/browser/WebClaw implementation with pinned Scrapling in an isolated Python service. It updates stack ownership, repository layout, contracts, qualification gates, work packages, logging, Help and release tests. No modified fork or application code has been created by this document update.

## 0. Read this before starting

This is a build specification for an internal, free-source land intelligence application. It is not authorization to buy services, subscribe to Shovels, access a direct MLS feed, send outreach, or deploy publicly. Implement the complete PRD, including autonomous research and adaptive fallback; do not downgrade it to a scraper demo.

**Lanes verification limitation:** The authoring environment could not verify the Lanes instructions. No actual Lanes instructions, command syntax, schemas, roles, worktree rules, or release procedures have been verified. This plan deliberately supplies logical work packages, not fictional Lanes CLI commands. The implementation harness must complete the binding procedure below before claiming execution under Lanes.

Only external dependencies genuinely requiring the owner should interrupt autonomous work: unavailable Lanes access, missing gateway credentials for real-model tests, a source requiring human login/permission, or deployment credentials. Continue independent work where possible. Do not repeat questions already answered in the documents.

## 1. Coding-agent kickoff prompt

Copy this block into the owner's harness with both Markdown files in the project root:

> Build Land Intelligence Workbench according to `01_Land_Intelligence_PRD.md` and `02_Land_Intelligence_Implementation_Plan.md`. First locate and read the actual Lanes instructions for the installed Lanes harness and this repository's AGENTS.md. Pin the Lanes revision and complete the binding checklist in section 2; never invent its commands. Use the installed `ui-ux-pro-max` and `ui-styling` skills for interface work after recording their provenance. Establish the dependency graph, isolated work ownership, independent review, durable progress state, and phase acceptance gates. Implement all required features, not just mocks. Use the TypeScript/PostgreSQL control plane plus an isolated Python Scrapling collection service. Reuse pinned upstream Scrapling before considering a fork; keep domain logic and orchestration outside it. Use free sources only; do not activate paid services or submit external messages. Research tools are bounded; code repair happens through Lanes in isolated worktrees. Resolve routine choices autonomously, record decisions, and batch only real blockers. Test on fixtures in CI and permitted live sources in opt-in smoke tests. Provide a private preview, complete Help, API/MCP examples, tested backup/restore, release evidence, and a clear list of real source coverage. Stop at an explicit release gate before public deployment or irreversible production changes. Never claim untested integrations or missing credentials as working.

## 2. Preflight and actual Lanes binding

### 2.1 Repository discovery

1. Confirm target application directory and inspect existing files/AGENTS.md before scaffolding. If empty, initialize `land-intelligence-workbench`; if a repository exists, preserve its stack unless there is a documented incompatibility.
2. Locate the installed `lanes` skill through the harness's skill registry and normal skill directories. Read its complete SKILL.md and referenced operational instructions.
3. If not installed, use authenticated GitHub access to the Lanes repository designated by the operator. Read repository metadata/default branch, README, AGENTS.md, relevant SKILL.md files, installation guide, and examples before executing anything. Record commit SHA, license and paths. Inspect install scripts before running them.
4. If unavailable, record `BLOCKER-LANES-ACCESS` with attempted path/error. Request access or the skill bundle once. Do not substitute agent-team/agent-team-lite and call it Lanes. Framework-independent design/tests may be prepared, but execution cannot be reported as Lanes-driven until binding is complete.
5. Discover installed `ui-ux-pro-max` and `ui-styling`; read their instructions before UI work. Do not install an arbitrary similarly named GitHub skill. If absent, record the missing dependency, use the explicit PRD design system for preparatory work, and resolve the named skill source before final UI acceptance. A candidate upstream for ui-ux-pro-max is linked in the PRD; ui-styling's intended distribution must be established, not guessed.
6. Verify Node LTS, pnpm, uv, a supported Scrapling-compatible Python, Docker/Compose, Git, Linux container support, PostgreSQL/PostGIS image and browser sandbox support. Pin compatible stable versions in lockfile and images; no floating `latest` in released Compose.
7. Read current official docs for Fastify, Better Auth, pg-boss, Tailwind, MCP SDK and CLIProxy installation being targeted. Create `docs/dependency-versions.md` with versions, licenses, compatibility checks and source URLs.

### 2.2 Binding output

Create `docs/lanes-binding.md` containing verified values for each row:

| Logical operation | Required verified mapping |
| --- | --- |
| Initialize project | Actual Lanes entry point and required config path/schema |
| Register work package | How tasks, dependencies, acceptance criteria and ownership are represented |
| Start agents | Supported roles, concurrency and model/provider configuration |
| Isolation | Worktree/branch rules and shared-file lock ownership |
| Review | Independent reviewer invocation, severity policy and feedback loop |
| State and recovery | Canonical status store, checkpoint format, pause/resume procedure |
| Integration | Merge owner, checks, conflict handling and rollback |
| Preview/release | Required preview, approval and deployment gates |
| Repair handoff | Supported task/issue import or prompt-based route |
| Completion | Required artifacts and definition of done |

Every command in that file must cite the exact local instruction or repository path/revision where found. Do not assume JSON/YAML schemas from this document are Lanes schemas. Translate the work packages in section 13 into the verified Lanes representation and validate with its actual tooling. Copying task names alone does not complete binding.

### 2.3 Orchestration roles

Use Lanes-native equivalents. Logical roles: orchestrator/integrator; backend/data developer; collection/research developer; frontend/design developer; independent reviewer/security tester. If the harness has fewer supported concurrent workers, execute packages sequentially; do not force unsupported concurrency.

Default max three implementation streams plus reviewer once foundations merge. Use the harness's own model choices unless user configuration says otherwise. One developer per worktree; reviewer does not approve their own implementation. Shared schema/contracts/migrations owned by orchestrator during foundation; later changes require a dedicated coordinated package. No two agents edit lockfile, schema, route contracts, or theme tokens simultaneously.

Persist task state in Lanes's authoritative store. Supplement with `docs/build-status.md`, `docs/decisions/`, `docs/blockers.md`, and evidence files only when not duplicating conflicting sources of truth. On resume inspect working tree, current commits, task state and prior test results before taking new work. Never rerun external mutations blindly.

## 3. Repository layout

This is the target layout; adapt to an existing repository through an ADR, not casual drift.

```text
apps/
  server/src/
    app.ts
    auth/
    routes/{campaigns,runs,records,sources,research,exports,issues,admin,webhooks}.ts
    middleware/{authz,errors,request-id,rate-limit}.ts
  web/src/
    app/ routes/ features/ components/ styles/ lib/
  worker/src/
    main.ts scheduler.ts dispatcher.ts handlers/ maintenance/
  collection-service/
    pyproject.toml uv.lock Dockerfile
    src/collection/{app,contracts,auth,policy,sessions,artifacts,logging}.py
    src/collection/drivers/{structured,scrapling_http,scrapling_browser,documents}.py
    src/collection/adapters/ tests/
  mcp/src/
    stdio.ts tools.ts api-client.ts
packages/
  contracts/src/{campaign,record,source,evidence,error,api,mcp,settings}.ts
  db/src/schema/ migrations/ queries/ seed/
  domain/src/{campaigns,records,research,analytics,issues,exports}/
  connectors/src/{contracts,registry,collection-client,structured-drivers,normalizers}/
  llm/src/{gateway,capabilities,profiles,budgets,redaction}/
  security/src/{url-policy,secrets,scopes,export-safety}/
  shared/src/{logger,clock,ids,units,hash}/
content/help/ docs/ scripts/ tests/{fixtures,integration,e2e,security,live}/
infra/{compose,egress}/ artifacts/.gitkeep
```

Business rules live in `domain`, not in React, MCP tool handlers or connector parsers. REST and MCP call the same services. All gateway traffic uses `llm`; all untrusted HTTP uses the controlled connector fetch layer. Avoid abstractions with only one speculative use; introduce adapters only at real external boundaries.

Required root scripts after bootstrap: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:security`, `pnpm test:live`, `pnpm db:migrate`, `pnpm db:seed:demo`, `pnpm help:check`, `pnpm verify`. These are commands the application must implement, not existing Lanes commands. Add root collection scripts `pnpm collection:check` (uv sync --locked, Ruff, pytest and contract checks) and `pnpm collection:smoke` (opt-in permitted live qualification); wire them into verify/CI. Add `scripts/doctor.ts`, `scripts/admin-bootstrap.ts`, backup/restore scripts and a root README.

## 4. Data schema and migrations

Use UUID internal IDs, `timestamptz` for instants, ISO date fields for source date-only facts, decimal money/acreage, text for APNs/ZIP/FIPS, JSONB only for raw source payloads, configuration snapshots and extensible attributes. Never store all domain data in one unindexed JSON table.

Minimum tables and key constraints:

| Table group | Required columns / constraints |
| --- | --- |
| Auth | Better Auth-owned users/sessions/accounts; application roles; session expiry and audit |
| campaigns | id, version, owner_id, state, objective, geo_filter, criteria, requested_fields, source_policy_id, budget_config |
| campaign_versions | immutable config snapshot, schema_version, created_by; unique campaign/version |
| schedules | campaign_id, mode, zone, recurrence, next_due_at, overlap/misfire settings, state |
| occurrences | schedule_id, scheduled_for, disposition, run_id; unique schedule/instant |
| runs | campaign/version, trigger, state, parent/retry ID, config snapshot, counters, timestamps |
| run_tasks | run, logical task key, state, attempt, checkpoint, lease, error; unique run/task key |
| outbox | event ID, event type/payload, created_at, dispatched_at, attempts |
| sources/source_versions | manifest, eligibility, method, lineage, coverage, source version, policy evidence |
| provider_accounts/quota_reservations | encrypted key reference, free quota/reset, reserved/used; no silent overage |
| retrieval_attempts | run/task/source, method, final URL, HTTP/content result, bytes, durations, error, artifact ref |
| artifacts | SHA-256, store key, MIME, size, retention, access class, created_at; no raw filesystem path exposed |
| observations | source + source record ID + revision hash unique; event/source/fetch times; original payload ref |
| organizations/people/contacts | canonical identity, role fields, suppression; source evidence relationships |
| entity_links/merge_history | typed relation, evidence, acceptance, effective dates; reversible merges |
| parcels/parcel_lineage | county-qualified APN, geometry, acreage, effective period; splits/merges explicit |
| ownerships/transfers/transfer_parcels | dated observations, instrument identity, transaction semantics |
| projects/permits/permit_participants | jurisdiction-qualified keys, status/type raw+normalized, project links |
| planning_cases | case ID, geography, decision/conditions, proposed vs approved quantities |
| listings/listing_observations | source-qualified episode, parcel candidates, status and typed prices over time |
| field_assertions/evidence_links | subject/field/value, acceptance state, evidence IDs, conflict group, model/extractor version |
| research_steps/claims | bounded plan, tool summaries, supporting/conflicting evidence, usage |
| metric_snapshots | metric version, geography, segment/window, source vintage, sample count, values |
| incidents/repair_briefs | fingerprint, impact, reproduction artifact, lifecycle, connector version, repair release |
| exports/notifications/webhook_deliveries | requester/scope, snapshot/filter, artifact, expiry, event ID, attempts |
| settings/settings_history/audit_events | versioned config, actor, diff with secrets redacted, effective time |
| api_keys | public prefix, keyed hash, scopes, expiry, revocation, last_used, quota |

Implement foreign keys, partial/unique indexes and timestamps in migration files. Index run/state/time, source/record IDs, organization normalized identifiers, parcel county/APN, geometry (GiST), listing source/status/time, incident fingerprint, and field-assertion subject/field. Use Postgres full-text/trigram indexes for name/search where helpful, not Elasticsearch.

Source snapshots are immutable. Correcting a parser writes a new revision and recalculates canonical views; it never overwrites original evidence. Updates out of order do not revert a newer source status. Store source time uncertainty and never invent an exact timestamp from a date.

Deletion/retention: source observations may be purged according to policy while retaining a tombstone and checksum if permitted. Reports referencing deleted evidence display unavailable, not a broken link or fabricated citation. Suppression hides contact fields across UI/API/MCP/exports and is tested as one shared rule.

## 5. API and MCP contracts

### 5.1 API conventions

Prefix `/api/v1`; OpenAPI generated from validated schemas. Auth endpoints separately under `/api/auth`. Authenticated same-origin UI uses server sessions; agents use application API keys. Do not accept a gateway key as an application key.

Response: `{data, meta:{requestId, schemaVersion, nextCursor?}}`. Error: `{error:{code,message,retryable,requestId,details?}}`. Never return stack traces to ordinary callers. Cursor pagination uses stable sort and opaque cursor; default 50, max 200. Filters use allowlisted fields/operators, never arbitrary SQL. Idempotency-Key required for agent job creation; scope includes principal + endpoint + payload hash; same key/different payload yields conflict. Default retention 24 hours for idempotency responses.

| Method / path | Behavior | Scope |
| --- | --- | --- |
| GET /records, /records/:id | Search/read authorized domain records | records:read |
| GET /evidence/:id | Safe metadata/text projection; artifacts separately authorized | evidence:read |
| POST /campaigns | Create validated draft | campaigns:write |
| PATCH /campaigns/:id | Version-guarded update; active run snapshot unchanged | campaigns:write |
| POST /campaigns/:id/runs | Run now; returns 202 and run ID | runs:create |
| POST /campaigns/:id/schedule | Configure schedule; UI role or explicit separate key scope | schedules:write |
| POST /campaigns/:id/pause or /resume | Affect future scheduling | schedules:write |
| GET /runs/:id, /runs/:id/events | Status and SSE progress; polling fallback | runs:read |
| POST /runs/:id/cancel or /retry | Authorized transition; completed tasks preserved | runs:cancel / runs:create |
| POST /research | Bounded objective, filters, fields, limits; returns 202 | research:create |
| GET /sources, /sources/:id/health | Eligibility/coverage/sanitized health | sources:read |
| POST /exports | Format + record query + snapshot; returns job ID | exports:create |
| GET /exports/:id/download | Authenticated stream with expiry and scope checks | exports:read |
| GET /analytics | Parameterized defined metrics | analytics:read |
| GET /issues, /issues/:id | Sanitized incident details | issues:read |
| POST /issues/:id/repair-brief | Draft sanitized Markdown brief | issues:triage |
| GET/PATCH /admin/settings | Versioned validated settings | Admin session only |
| POST /admin/llm/test, /admin/keys | Test gateway/create application key | Admin session only |

Campaign POST example (application contract, not Lanes syntax):

```json
{
  "title": "Weekly builder activity",
  "template": "builder_activity",
  "geography": {"countyFips": ["48453"]},
  "assetTypes": ["vacant_land", "single_family"],
  "requestedFields": ["entity.name", "permit.issueDate", "buyer.acquisitionCategory"],
  "sourcePolicy": {"freeOnly": true, "allowHostedFreeTiers": false},
  "limits": {"maxPages": 100, "maxLlmCalls": 20, "maxMinutes": 60},
  "timing": {"mode": "recurring", "timezone": "America/Chicago", "frequency": "weekly", "weekdays": [1], "localTime": "08:00"}
}
```

FIPS above is a demonstration, not an inferred user market. Preview must show eligible coverage before activation. No campaign can override organization free-only or network policies.

### 5.2 MCP

Use official SDK local stdio transport, with diagnostics only on stderr and protocol frames on stdout. `LAND_INTELLIGENCE_API_URL` and `LAND_INTELLIGENCE_API_KEY` are application configuration names to implement. Do not put literal keys in committed configuration examples. Provide example MCP client config with environment placeholders and executable path generated by the package build.

Implement tool names from PRD with strict input schemas, bounded output, cursor pagination, evidence IDs, and job polling. Long operations return IDs, not blocked tool calls. Require explicit scope for research execution/export/cancellation. A read-only token cannot create a run. No generic HTTP-request tool. Test with the official SDK client or inspector and two independently scoped principals.

Remote MCP is not a V1 requirement; document stdio bridge use on the agent host. If added, it requires current MCP authorization specification compliance, protected resource metadata and an established authorization implementation, origin checks and token audience validation. Do not proxy upstream gateway bearer tokens to clients.

## 6. Job engine and scheduler implementation

Use application tables as lifecycle truth and pg-boss for delivery. A transaction creates occurrence/run/task/outbox rows. Dispatcher publishes outbox events with a stable job key and marks delivered; a crash between publication and marking is harmless because consumer commits are idempotent.

Task handler pseudocode:

```text
claim logical task lease with fencing token
if terminal task or cancelled run: acknowledge without work
load immutable run policy and enforce current revocations
reserve page/token/free-provider budget atomically
execute one bounded action; heartbeat lease
validate content and field outcomes
transaction:
  verify lease fencing token and cancellation state
  insert observation revision if absent
  write task result, counters and downstream outbox entries
release unused reservation; reconcile actual consumption
acknowledge job
```

An external request may execute more than once after crashes. Never claim exactly-once network execution. Track attempt IDs and ambiguous gateway timeouts; pessimistically retain consumed budget until reconciled. Side-effecting external operations are excluded.

Task granularity: one page, document chunk, source page, or bounded synthesis step; do not put a whole national crawl in one queue item. Pagination checkpoints include source cursor and watermark. Enumerators detect repeated cursors, truncated results and unexpected count changes. Apply overlapping update windows to catch late records; revision dedup prevents duplication.

Scheduler tests: simultaneous schedulers; crash before/after outbox publication; spring DST gap; fall repetition; end-of-month dates; timezone changes; paused schedule; missed occurrence; overlap skip/queue-one; process restart; cancellation during fetch; stale lease recovery. Use injectable clock; never rely on real sleeps for schedule tests.

## 7. Collection and normalization contracts

A connector is a bounded source adapter, not an unrestricted agent. Types below describe the TypeScript orchestration facade; HTML/browser operations delegate to the Python service. Implement matching versioned JSON Schema and Python validation, not two independently evolving domain models.

```ts
interface SourceConnector {
  id: string;
  version: string;
  capabilities: string[];
  enumerate(input: EnumerationRequest, ctx: ConnectorContext): AsyncIterable<SourceItem>;
  fetch(item: SourceItem, ctx: ConnectorContext): Promise<RetrievalResult>;
  extract(result: RetrievalResult, ctx: ConnectorContext): Promise<ObservationDraft[]>;
  validate(drafts: ObservationDraft[], ctx: ConnectorContext): Promise<ValidationResult>;
}
```

Context exposes policy-filtered fetch/browser/document tools, clock, budget, checkpoint store, redacted logger and artifact writer. It must not expose raw environment variables, shell, database superuser, or arbitrary gateway credentials. Every driver returns final URL, redirects, MIME, status, content classification, timestamps, byte count, artifact hash and safe error.

Implement drivers in order: structured downloads; Scrapling HTTP; Scrapling browser/session; document parser; separately configured optional hosted-free interface. Do not implement WebClaw or a second custom production Playwright fetcher in V1. Playwright remains the web-UI test tool and may support the scoped session-login helper. Doctor reports Python, Scrapling and browser versions, service health and actual smoke-test results. Pin uv.lock and image digests; no floating package/browser upgrades.

For Socrata/ArcGIS, inspect metadata, fields, pagination and query limits from the actual endpoint. Do not guess permit schema from dataset title. Backfills use deterministic ordering, overlapping update watermarks, explicit row-count verification and checkpointed pagination. Generic HTML extraction is supplemental; site-specific field extraction is needed for precise prices/statuses.

Document parsing: file magic validation, disk/CPU/time caps, page count, embedded-link restrictions, OCR only if text insufficient, evidence page numbers and extracted text spans. No automatic execution of document macros or remote resources.

Implement a Source Preview screen: one URL or published dataset sample, requested fields, retrieval mode, schema preview, evidence and validation errors. Add sitemap/URL mapping with max-URL/depth/domain budgets and include/exclude patterns, bounded batch URL imports, ETag/Last-Modified conditional fetching, and a force-refresh option that still respects rate limits. Cache keys include source version, URL, extraction schema, account/session scope and relevant model version; never reuse authenticated content across profiles. Optional source-debug screenshots are access-controlled short-lived evidence, not automatically exported.

For user session handoff, ship `pnpm session:login` as a local operator helper that opens visible Chromium for an explicitly selected source. The user completes login/MFA directly. Transfer only scoped browser storage state over authenticated TLS or localhost to encrypted storage; never capture passwords or print cookies. Headless-server Help explains running the helper on the operator computer. Session refresh creates an auditable version; unsupported device-bound sessions remain unsupported. No remote desktop infrastructure is required for V1.

Build source-specific mapping fixtures for statuses, participant roles, currency, acreage, APN normalization and local date formats. Classification fallback uses the gateway only when deterministic parsing cannot resolve a field. Output must include original text, classification version and inferred state.

At least two real government sources and one published aggregate download must have reproducible live smoke evidence when reachable and permitted. At least one marketplace adapter must have a real-source assessment and an end-to-end contract; if use/access is not permitted, ship disabled with fixtures and an explicit unsupported status rather than a deceptive working badge. Complete one legitimate alternative source if available; do not silently remove the listing feature.

### 7.1 Python service contract and execution

Implement a small FastAPI/Pydantic internal service; do not expose it publicly or mount its docs unauthenticated. Generate JSON Schema for request/result DTOs from the shared contract source and check both validators against identical golden payloads. Protocol version is independent of Scrapling version. Unsupported versions fail explicitly.

- `GET /internal/v1/health`: authenticated capability/version response, no secrets.
- `POST /internal/v1/tasks`: bounded task envelope; returns task ID immediately. Envelope: protocolVersion, taskId, attemptId, sourceId, sourceVersion, recipeVersion, mode, URL, allowlisted domain rules, deadline, request/byte/browser caps, permitted session reference, declarative extraction recipe, and correlationId.
- `GET /internal/v1/tasks/:id`: task status, counters and result manifest. Result: classification, final URL, redirect summary, source timestamps, original/normalized candidates, selectors/recovery annotations, evidence IDs/hashes, resources used, engine/browser versions and stable errors.
- `POST /internal/v1/tasks/:id/cancel`: abort requests and browser work; acknowledge completed work separately.

Use a private per-deployment service credential with constant-time verification; never forward user API keys or gateway secrets. TypeScript owns durable task truth. Python may keep bounded in-flight state; on restart it reports unknown tasks and the application safely replays the same logical task with a new attempt ID. Do not add Celery, Redis or a second scheduler. A repeated attempt ID within a service lifetime must not start duplicate work. Application database uniqueness handles results delivered twice.

Provide a read-only per-source/session configuration projection; encrypted session material is supplied through a restricted secret mount or authenticated ephemeral handoff, not embedded in logs or standard task JSON. Session state is not shared across identities or domains. All routes are authorized, outputs capped, and task recipes cannot contain Python, arbitrary JS evaluation, SQL, shell, or unrestricted browser commands. Public-page scripts execute only inside the sandboxed browser.

Keep the collector's only writable areas ephemeral working directories, scoped session storage and an evidence staging volume. The application validates every artifact identifier, size, type and hash before promotion. No collector DB credentials, LLM credentials or host socket. The service may reach external approved targets only through enforced egress; its policy is defense in depth, not a substitute for network isolation.

### 7.2 Scrapling-specific engineering rules

1. Evaluate a stable upstream version, record package/commit/browser hashes and inspect dependency licenses. Retain BSD notices. No fork unless a failing regression demonstrates the need; maintain minimal patches with upstream tracking and a tested update procedure.
2. Inspect the installed version's actual APIs and optional Agent Skill before using them. Do not copy API names from old screenshots. The upstream skill informs library use; our security and business policies remain authoritative.
3. Disable internal retry multiplication, implicit proxy/provider choices and uncontrolled transport changes. All network attempts debit the run budget. Robots and throttling policies are explicitly configured rather than relying on permissive defaults.
4. Verify DNS, redirects, browser subrequests, HTTP/3/QUIC and alternate proxy paths cannot escape egress controls. Disable any transport that cannot be constrained. Cloudflare-handling claims do not waive source eligibility or success validation.
5. Keep selector memory keyed by source, recipe version and page type, with explicit session separation where content differs. Back up/version useful learned state. Do not share adaptive memory across unrelated websites.
6. Test moved fields, missing fields, nearby similarly named fields, changed units, asking-vs-sold prices and stale sessions. Preserve recovery annotations. A plausible match failing semantic validation becomes an incident/candidate, not an accepted fact.
7. Use application's durable checkpoints and idempotency keys. If Scrapling crawl checkpoints are used, bind them to run/task/source version and invalidate safely after recipe changes. A checkpoint is not persisted business output.
8. Keep public MCP access through our existing TypeScript gateway. Do not expose Scrapling's raw MCP server, generic fetch tools or native exporters as a way around application scopes, safe exports or budgets.

### 7.3 Qualification and fork gate

Create `docs/scrapling-evaluation.md` before WP03 exits. Evaluate 30–50 representative permitted pages and deterministic protected/error fixtures; record page types, expected fields, correctness, usable content, time, memory, version and failures. Compare against direct structured downloads and minimal HTTP where relevant. Require 100% budget/cancellation/security test passes and no unflagged semantic substitutions in the adaptive drift fixture set. Report live failures honestly; do not require impossible universal access to finish the platform.

If a gate fails, repair integration, disable the failing mode/source, or document a bounded upstream patch. No automatic paid fallback, broad rewrite or silently abandoned requirement. A modified fork needs `docs/decisions/scrapling-fork.md`, patch ownership, regression fixture, upstream base SHA, license inventory, rollback image and an update/rebase procedure. Independent review is required before integration; external upstream issue/PR submission remains separately authorized.

## 8. Autonomous research and adaptation implementation

Research is a deterministic controller with bounded LLM planning, not an unconstrained loop. Implement phases: plan -> retrieve -> extract -> resolve -> verify -> synthesize -> finalize. Store structured plans and tool summaries, not hidden reasoning text.

Required tools map to existing domain services. Planner schema includes target facts, allowed source IDs, stop conditions, expected evidence type and per-step limits. Validate all tool arguments, URLs, geography and requested fields against run policy before dispatch. Findings cannot self-declare verified; acceptance engine checks evidence.

Budget-aware algorithm:
1. Read existing accepted records and identify gaps/staleness.
2. Prefer known sources with required fields and suitable freshness.
3. Retrieve using best eligible validated method; perform free fallback on classified failures.
4. Extract and validate; preserve conflicts instead of majority voting across syndicated copies.
5. Stop if all required fields meet policy, no eligible source remains, budget exhausted, deadline reached, or human access needed.
6. Produce partial report when unresolved; list missing fields and tested source routes.

Routing score is initially explicit: eligible -> field coverage -> recent validated success -> freshness -> resource estimate -> latency. Minimum sample and bounded exploration from PRD apply. Use Bayesian smoothing or a minimum sample guard to avoid selecting a method from one lucky attempt. Record reason for selection and policy version. User overrides can prefer/disable a method; no hidden optimization that changes access permissions.

Model gateway implementation must test endpoint compatibility, schema response support, effort mapping, usage fields, cancellation, 429/5xx, invalid output and timeout. Use a deterministic fake gateway for CI. If gateway lacks structured-output support, request JSON text then parse/validate with at most one repair attempt; never execute generated content. Mock success must remain labeled mock in acceptance evidence.

Free web-wide search is not assumed. Implement source-native discovery and local full-text search first, plus a documented pluggable free search driver. A disconnected driver cannot be shown as comprehensive internet research. Source discovery proposes new registry entries; automatic execution waits for source policy acceptance.

## 9. UI implementation instructions

Before components, produce `docs/design-system.md` and static route inventory. Read the actual design skills identified in preflight and cite them there with revision/path. Follow PRD tokens, accessibility and density; preserve user priorities over generic skill palettes.

Build one cohesive application shell and reuse primitives: page header, filter bar, data table, status label, evidence drawer, empty state, error callout, job timeline, confirmation dialog, settings field, source badge, metric caption. Avoid custom widgets where accessible Radix primitives suffice.

Routes: `/`, `/campaigns`, `/campaigns/new`, `/campaigns/:id`, `/runs/:id`, `/records`, `/records/:type/:id`, `/research`, `/research/:id`, `/sources`, `/sources/:id`, `/issues`, `/issues/:id`, `/exports`, `/help`, `/help/:slug`, `/admin/:section`.

Campaign wizard validation is progressive; do not discard prior inputs on a source failure. Show one-time schedule and recurrence in plain English. Next-run preview is calculated by the backend, not duplicated calendar logic in React. URL filters use stable serialization. Optimistic UI only for reversible local settings; run status always server-authoritative.

Forms must support pending state, field-level server errors, labels and help. Provider secret field is write-only; existing secret displays a masked presence indicator. Effort selector reflects capability profile, not a fixed global list. Connection test outputs safe status and actionable issue code.

Analytics charts require sample/window labels, no 3D/donut decoration for simple counts, and accessible table alternatives. Dense results use legible line height and sticky headers. Evidence viewer defaults to safe text; original document download is separately authorized.

Playwright screenshot scenarios: first run with no sources; populated campaign list; campaign wizard; active run; partial research report; record evidence conflict; source failure; LLM configuration error; mobile table; Help search; export completion. Independent reviewer inspects images for spacing, contrast, clipping, hierarchy and usefulness, not just pixel snapshots.

## 10. Logging and repair-brief contract

Use Pino in TypeScript and structured Python logging with the same event envelope and central redaction of authorization, cookies, API keys, session tokens, credentials in URLs, model key material, raw prompts and personally identifying content not needed for diagnosis. Correlate request/run/task/attempt/source/connector versions. Metrics use counters, not scraped page text.

Repair brief Markdown template, implemented by the app:

```markdown
# Repair brief: <incident ID and short symptom>
## Objective and impact
## Source and access policy
## Expected versus observed behavior
## Last successful version and first failure
## Sanitized reproduction steps
## Minimal fixture and artifact hashes
## Failing test / required regression test
## Evidence-backed hypothesis and alternatives
## Relevant repository paths (validated)
## Proposed change boundary
## Acceptance criteria
## Canary checks and rollback
## Unresolved dependencies
```

Include machine-readable metadata in JSON export: brief schema version, incident ID, source ID, connector ID/version, application commit, fixture IDs, error code, severity, allowed change paths, regression tests, acceptance checks. These are app fields, not an invented Lanes import format. A Lanes adapter added after actual skill verification may convert this bundle into its supported tasks. Default is downloadable handoff with no GitHub mutation.

Repair workflow testing must cover parser drift, challenge page returning 200, repeated pagination, wrong units, null contact spike, false sold detection, expiring session and a provider quota error. A good brief can conclude “source cannot supply this field” instead of prescribing code changes. Store fixes and outcomes so later incidents can reuse validated playbooks, not unreviewed model suggestions.

## 11. Security and deployment implementation

Use official Better Auth integration, secure cookies, same-origin API, session roles and login throttling. No open user registration. Admin bootstrap occurs via one-time local CLI token; no printed persistent secrets in logs. Runtime DB role cannot create arbitrary extensions; migrations run under a separate role.

API keys use 32 random bytes or equivalent entropy, display once, store only keyed hash plus prefix, and constant-time validation through a vetted implementation. Enforce scopes at domain service boundary. API/MCP output field filtering must use the same authorization helpers as UI exports.

Egress controls are a release blocker: deny private, loopback, link-local, reserved, multicast, IPv6 local/metadata destinations for untrusted fetches; block non-HTTP(S), URL credentials and unexpected ports; revalidate redirects and DNS resolution. Route Chromium through controlled egress and disable direct fallback. Verify with an internal canary service that HTML subrequests cannot reach it. LLM gateway access is a separate trusted client policy and never inherits untrusted URL exceptions.

Secrets use authenticated encryption with a host-provided master key and key version; backups do not bundle plaintext key. Session encryption keys and provider keys cannot be exported. Rotation supports decrypt-old/encrypt-new migration with audit. Docker containers nonroot, drop unnecessary capabilities, read-only filesystem where possible, ephemeral browser temp directory, bounded CPU/memory, no Docker socket.

Compose should bind application to loopback by default and database internally. A documented reverse-proxy/private-network profile adds TLS. Production public exposure is not authorized by these documents. Webhooks use explicit destination allowlist, HMAC signature, event timestamp/ID, replay window, deduplication and bounded retries. SSRF checks apply even to admin-configured hooks.

Operational defaults: logs 30 days, raw evidence 30 days, exports 24 hours, normalized observations 365 days, audit 365 days, adjustable by admin and source restrictions. Retention dependency check warns before deleting evidence used in retained reports. Backups daily with seven daily copies initially; restoration test must verify database, artifacts and separate key availability. Document RPO 24 hours and target RTO 2 hours for the small-host profile as goals, not measured guarantees.

## 12. Testing and acceptance suite

### 12.1 Fixture pack

Create synthetic fixtures and small permitted/redacted source samples with provenance. Include: active/pending/sold/removed listing, asking vs closing price, monthly financing ad, zero vs null price, duplicate network listing, multi-parcel deed, related-party transfer, assessor/deed conflict, parcel split, trade permits under one project, expired permit labeled final, duplicate contractor names, registered agent collision, unknown fund parent, scanned PDF, corrupted CSV, UTF-8 contact names, date-only facts, revised market data and source pagination.

Every connector test asserts field meaning, not just snapshot equality. Keep fixtures isolated from demonstration data. Synthetic demo records carry `is_demo=true` and are excluded from live analytics by default.

### 12.2 Mandatory checks

| Area | Required tests |
| --- | --- |
| Schedules | DST, missed events, overlap, duplicate calls, restart, timezone change |
| Queue | Duplicate delivery, stale lease, cancellation, outbox replay, idempotent commits |
| Sources | Schema drift, malformed content, stale data, repeated cursors, partial enumeration |
| Research | Unsupported claims, malicious page instructions, conflicting sources, budget exhaustion, no search provider |
| Identity | Shared agent false merge, ambiguous name, reversible merge, parcel lineage |
| LLM | Missing key, wrong endpoint, unsupported effort, invalid JSON, retry budget, unknown cost |
| Exports | CSV formula injection, HTML script escaping, Markdown injection, permissions, expiry, snapshot consistency |
| API/MCP | Read-only principal, revoked key, IDOR, scope escalation, pagination, idempotency collision |
| Network | Redirect SSRF, DNS rebinding, IPv6, metadata, browser subresource and webhook SSRF |
| UI | Keyboard/focus, empty/error/loading, mobile, secret masking, accessible tables |
| Recovery | Database/artifact restore, interrupted migration, disk full, unavailable gateway |
| Help | Broken links, feature coverage, matching option names, executable example contracts |

`pnpm verify` runs TypeScript checks plus uv/pytest/Ruff collection-service checks and cross-language fixtures without paid APIs or live crawling. `pnpm test:live` is opt-in, small and rate-limited; record source URL, date, count, fields, permissions assessment and outcome. Real gateway test is opt-in and records sanitized model/protocol/capabilities. No load test against public sources.

Performance benchmark runs on declared host specs and synthetic fixtures. Report p50/p95, dataset size, parallel jobs and memory; optimize only failed requirements. Do not rewrite architecture merely for benchmark vanity.

## 13. Work packages and dependency graph

Each package must become a Lanes-native task after binding, with objective, owner, allowed files, dependencies, tests, evidence and status. Integrator assigns exact worktree names using the real skill, not a convention invented here.

### WP00 — Verified bootstrap

- Dependencies: none. Owner: orchestrator.
- Outputs: `docs/lanes-binding.md`, skill provenance, dependency versions including Python/Scrapling, ADRs, repository scaffold, CI, root scripts, task graph.
- Checks: actual Lanes instructions read; no fabricated commands; clean install/build; no credentials committed.
- Exit: owner decisions from documents are recorded; unresolved external blockers isolated.

### WP01 — Contracts, schema and authentication

- Depends on WP00. Owner: backend.
- Files: contracts, db schema/migrations, server auth/middleware, security scopes/secrets, shared logger.
- Build: all core identity/evidence/job tables; role model; admin bootstrap; API error envelopes; secret storage and audit.
- Tests: migration empty/upgraded DB; scope and IDOR; secret redaction; role-based field access.
- Exit: UI-independent authenticated API skeleton and seed fixtures.

### WP02 — Durable campaign engine

- Depends on WP01. Owner: backend.
- Files: campaign domain/routes, worker scheduler/dispatcher/handlers, schedule tests.
- Build: campaign versions, all timing modes, occurrence uniqueness, outbox, budgets, cancellation, retry/resume, SSE.
- Tests: all scheduler/queue cases in section 12.
- Exit: synthetic campaign survives process restart and duplicate triggers.

### WP03 — Secure Scrapling integration

- Depends on WP01. Owner: collection.
- Files: collection-service, collection-client, JSON contracts, URL policy, infra egress, document sandbox.
- Build: pinned Scrapling HTTP/browser worker, bounded internal API, structured downloads/documents/imports, artifacts, content classification, quota accounting and per-source adaptive-match policy.
- Tests: cross-language contracts, SSRF including browser subrequests and alternate transports, parsing caps, challenge-200, cancellation, hidden retry accounting, free quotas, semantic validation after adaptive recovery.
- Exit: isolation demonstrated with internal canary; no browser in API process; 30–50-page qualification report with failures and unknowns; required quality/security gates pass.

### WP04 — Design system and application shell

- Depends on WP00 and contracts from WP01. Owner: frontend.
- Files: web shell/routes/styles/components, design-system.md.
- Build: actual design skill workflow, tokens, navigation, auth states, tables/forms/drawers, responsive shell.
- Tests: keyboard navigation, contrast, responsive screenshots.
- Exit: independent visual review; no fabricated dashboard metrics.

### WP05 — Source registry and initial connectors

- Depends on WP02, WP03. Owner: collection.
- Files: source domain/routes, adapters, manifests, source fixtures/live checks.
- Build: Austin/Seattle structured adapters, one aggregate download, one assessed marketplace adapter, county/board discovery, CSV/JSON import, free policy UI contract.
- Tests: metadata mapping, pagination/backfill, source drift, duplicate revisions, live smoke as available.
- Exit: verified supported-source register; blocked candidates explicitly identified.

### WP06 — Canonical records and acceptance

- Depends on WP01, WP05. Owner: data.
- Files: normalizers, records domain/queries, entity resolution, field acceptance.
- Build: organizations/contacts/parcels/ownership/transfers/permits/planning/listings, evidence links, reversible merges, suppression.
- Tests: all domain edge fixtures; sample precision/accuracy audit.
- Exit: no high-impact field without provenance; uncertain links stay candidates.

### WP07 — CLIProxy integration and autonomous research

- Depends on WP02, WP03, WP06. Owner: research.
- Files: llm package, research domain/routes, plans/claims fixtures.
- Build: encrypted profiles, capability testing, endpoint/effort mapping, controller/tools, bounded discovery, citations, adaptive free routing.
- Tests: fake gateway complete suite; malicious content; unsupported fields; budget exhaustion; optional real gateway smoke.
- Exit: multi-step research produces useful partial results and explicit gaps without shell access.

### WP08 — Campaign, records and research interface

- Depends on WP04, WP02, WP06, WP07. Owner: frontend.
- Files: campaign wizard/list/detail, records/evidence, research screens, saved views.
- Build: all normal/empty/partial/error/waiting states; schedule preview; criteria distinctions; accessible filters.
- Tests: end-to-end create/run/review/retry, mobile and keyboard.
- Exit: analyst can complete primary journeys without terminal.

### WP09 — Analytics, semantic changes and notifications

- Depends on WP06 and WP02. Owner: backend/data; frontend after API merge.
- Files: analytics queries/routes, change engine, notification/webhook delivery, dashboard.
- Build: reproducible metric snapshots, coverage labels, price/status diffs, in-app alerts, opt-in signed webhooks.
- Tests: aggregate reconciliation, revised vintages, failure != removal, webhook security.
- Exit: metric lineage and sample coverage visible; charts have table alternatives.

### WP10 — Exports and secure agent access

- Depends on WP06, WP07, WP01. Owner: integration.
- Files: exports domain/routes/UI, MCP package, OpenAPI docs, client examples.
- Build: four export formats, snapshot jobs, expiry, checksums, scopes, eight MCP tools, local client configuration.
- Tests: escaping/formulas, 100k-row stream, revocation, SDK-client roundtrip, async tool result IDs.
- Exit: REST/MCP/UI return consistent records and authorization outcomes.

### WP11 — Incidents, repair briefs and Lanes handoff

- Depends on WP03, WP05, WP07 and verified Lanes binding. Owner: reliability.
- Files: issues domain/routes/UI, drift monitors, brief renderer, optional verified Lanes export adapter.
- Build: error taxonomy, grouping, validated file references, reproduction bundles, lifecycle, canary metadata and rollback.
- Tests: drift incident -> brief -> fixture regression -> candidate -> canary failure -> rollback; include wrong-but-plausible adaptive matches and learned-selector-state version changes.
- Exit: brief sufficient for a separate agent to repair a connector; no production code execution from runtime.

### WP12 — Admin, Help and operational readiness

- Depends on relevant APIs and WP04; documentation can begin earlier. Owner: frontend/docs with backend review.
- Files: admin screens, content/help, backup/restore, doctor, deployment guide, release notes.
- Build: all PRD settings groups, local searchable Help, context links, complete setup/troubleshooting, sanitized diagnostics.
- Tests: write-only secrets, setting validation/audit, help coverage, restore rehearsal.
- Exit: an operator can configure and recover the system using shipped Help.

### WP13 — Independent release verification

- Depends on WP00–WP12. Owner: reviewer/integrator, not the author of the reviewed changes.
- Execute complete deterministic suite, permitted live samples, real gateway test when available, security checks, visual review, performance benchmark and restore rehearsal.
- Produce traceability matrix R01–R20 -> implementation paths -> tests -> evidence -> limitations.
- Fix critical/high defects before release. Record lower-severity issues with concrete consequences and owner.
- Exit: private preview, release candidate, reproducible setup, no fabricated live coverage. Stop before externally exposing production without authorization.

### Concurrency rules

WP02, WP03 and WP04 may run concurrently after their dependencies. WP06 and source-specific UI preparations can proceed once contracts stabilize. UI integration must consume merged API contracts, not a parallel unofficial schema. Serialize migrations and lockfile changes. Independent reviewer operates continuously; final review does not replace per-package checks. Do not exceed actual Lanes supported concurrency.

## 14. Help implementation backlog

Create `content/help/_index.json` with slugs, titles, feature IDs and related pages. Markdown renderer disables arbitrary HTML/scripts and builds local full-text index. API examples generated/validated against OpenAPI; MCP examples tested against built executable. No dependency on a hosted documentation service.

Required files:
`quick-start.md`, `free-source-policy.md`, `campaigns.md`, `schedules-timezones.md`, `buyers-and-entities.md`, `parcels-ownership.md`, `permits-planning.md`, `listings-market-data.md`, `research-evidence.md`, `cliproxy-models.md`, `browser-sessions.md`, `sources-imports.md`, `analytics.md`, `exports.md`, `api.md`, `mcp.md`, `admin-security.md`, `troubleshooting.md`, `repair-briefs-lanes.md`, `backup-restore.md`, `privacy-retention.md`, `scrapling-collection.md`, `release-notes.md`.

`scrapling-collection.md` documents pinned engine/browser versions, source-preview diagnostics, adaptive-match review, Python service troubleshooting, session isolation, dependency upgrades, canary rollback and when an upstream fork is justified. Doctor and release reports distinguish a service outage from an inaccessible source.

Every Admin setting has a help key and definition. Every stable error code links to a troubleshooting anchor. Each page follows prerequisites -> steps -> expected outcome -> common failures -> recovery. Do not publish missing implementation as available instructions. Screenshot fixtures contain synthetic records and masked credentials.

## 15. Decisions agents may make without asking

Permitted: package patch versions within compatibility, routine internal function names, test fixture values, component refactors, conservative retry improvements, query indexes justified by tests, source parser corrections consistent with evidence, copy refinements, accessibility fixes, worktree/task sequencing supported by Lanes.

Record an ADR for: stack change, new process/service, persistent schema redesign, change in auth model, different MCP transport, removal of required feature, or new external data/search dependency. Do not add paid sources. Ask only for missing credentials/access, human verification, paid or destructive actions, and externally visible release authority. Unknown target geography does not block reusable implementation or clearly marked demo tests.

If source eligibility is unclear, quarantine that connector and continue with known free open sources. If LLM credentials are missing, implement/test with a fake gateway and clearly mark real-gateway validation blocked. If Lanes is missing, do not claim autonomous orchestration through it. Do not treat running out of context as task completion; checkpoint and resume.

## 16. Completion artifacts and final handoff

The coding harness must deliver:
- Running private preview and repository with reproducible setup/lockfile/migrations.
- Both specification documents preserved, plus decisions and actual Lanes binding.
- OpenAPI specification, MCP client example, source connector guide, export schemas.
- In-app Help complete and searchable; README focused on setup.
- Source coverage report listing tested URLs, field availability, policy status, last sample, known gaps, and synthetic vs live evidence.
- Test/visual/security/performance reports and restore evidence, Scrapling qualification report, Python lockfile/browser versions and cross-language contract evidence.
- Configuration inventory with secret-free examples; no credentials in final output.
- Incident/repair-brief sample and demonstrated connector rollback.
- Release checklist, unresolved blockers, and R01–R20 traceability.

Do not mark done solely because `pnpm build` passes. Functional completion includes real collection on permitted free sources, research behavior, all schedule modes, exported files, scoped agent access, understandable errors, and usable Help. Owner intervention should be limited to credentials, access decisions, and release authority, not ordinary implementation choices.

## 17. Source references for implementation verification

- Lanes orchestration: Obtain the exact instructions for the installed Lanes harness during WP00.
- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI ; inspect pinned README/config and actual gateway capabilities.
- UI/UX skill candidate: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill ; use owner's installed vetted skills first.
- Tailwind: https://tailwindcss.com/docs/installation/using-vite
- Fastify auth integration: https://better-auth.com/docs/integrations/fastify
- Queue: https://github.com/timgit/pg-boss
- MCP security: https://modelcontextprotocol.io/specification/latest/basic/security_best_practices
- Scrapling: https://github.com/D4Vinci/Scrapling ; pin and qualify the actual release before use.
- Scrapling license: https://github.com/D4Vinci/Scrapling/blob/main/LICENSE
- Scrapling documentation: https://scrapling.readthedocs.io/en/latest/
- WebClaw: https://webclaw.io/docs/self-hosting ; reference only, not a V1 runtime dependency.
- Firecrawl change tracking: https://docs.firecrawl.dev/features/change-tracking ; feature reference only.
- Austin dataset: https://data.austintexas.gov/d/3syk-w9eu
- Seattle dataset: https://cos-data.seattle.gov/d/76t5-zqzr
- Shovels source collection disclosures: https://www.shovels.ai/blog/monthly-memo-june-2026/ and https://www.shovels.ai/blog/project-storm-how-were-bringing-americas-offline-jurisdictions-online/
