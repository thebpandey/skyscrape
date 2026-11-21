# Land Intelligence Workbench — Product Requirements Document

Version: 1.1 • Prepared: 2026-11-14 • Updated: 2026-11-16
Status: Implementation-ready product specification. Verify the installed Lanes harness and bind it during implementation preflight.
Companion: `02_Land_Intelligence_Implementation_Plan.md`.

## Revision 1.1

Adopts Scrapling as the primary HTML/browser engine, adds an isolated Python service and cross-language contracts, removes WebClaw/custom-browser implementation as V1 requirements, and adds qualification, fork governance, adaptive-match safeguards and updated test/Help requirements. Campaigns, free-only sources, CLIProxy, scoped MCP/API and Lanes remain unchanged.

## 1. Product decision

Build a private, self-hosted web application that collects free public land and single-family housing data, connects evidence across sources, identifies potential buyers, and runs repeatable research campaigns. A campaign is a saved collection/research objective, geography, field selection, source policy, execution budget, and schedule. It does not mean an outreach or advertising campaign.

The application must answer: who is acquiring or developing relevant property, where and when they have been active, what they appear to buy, which contact handles acquisitions, and what evidence supports those conclusions. It must also expose observed listings, transfers, ownership, permits, planning decisions, and market indicators.

Use Shovels, Firecrawl, and WebClaw as product and collection-method references, not required paid subscriptions. Do not require MLS membership, MLS feeds, paid parcel datasets, paid scraping APIs, or a proprietary search API. Build autonomous research, multiple eligible fallback providers, and site-specific adapters into V1. Free-source gaps remain explicit; the application must not invent missing data or quietly substitute paid access.

### 1.1 Important constraints

- Internal application for one organization; multiple internal users, no public SaaS billing or public registration.
- Sources are free-first and free-only by default. No card-required trials or automatic overage. Hosted free tiers are optional and disabled unless explicitly configured; local execution must work without them.
- Compute, storage, and CLIProxy upstream LLM consumption may still cost money. Display these separately from data-access spending. Do not describe unknown model costs as zero.
- Autonomous research executes bounded tools. Autonomous coding uses the owner's Lanes harness. Runtime scraping must never execute arbitrary generated code inside the application server.
- No guaranteed universal protected-site access, national completeness, title certification, verified beneficial ownership, or comprehensive MLS history.
- No automatic emailing, calling, SMS, records-request submission, purchases, or externally published content. Generate drafts and briefs for download; external communication requires a separately authorized feature.
- No CAPTCHA-solving service, identity impersonation, paywall bypass, stolen sessions, or unchecked proxy escalation. Authorized session handoff and approved public-source collection are supported.
- Source terms, available fields, fees, and current coverage must be checked per source. Public page visibility is not a blanket bulk-use license.

### 1.2 Unresolved inputs and nonblocking defaults

| Input | Default / behavior |
| --- | --- |
| Target markets | No production geography preselected; Austin and Seattle are clearly labeled demonstration sources, not the user's chosen markets |
| Product name | Land Intelligence Workbench; configurable brand name |
| Time zone | America/Chicago; every campaign can override with an IANA time zone |
| Deployment | Docker Compose on one private Linux host; localhost binding by default |
| LLM gateway | User supplies CLIProxy-compatible base URL, key, model; extraction without LLM and fixture demonstration work before configuration |
| Lanes | Use the installed Lanes harness. Verify its instructions during preflight and do not invent its commands or schemas. |
| Design skills | Discover and read the owner's installed `ui-styling` and `ui-ux-pro-max`; see implementation preflight for missing-skill handling |

## 2. Users and success measures

Roles: Admin (configuration, users, secrets, policies), Analyst (campaigns, review, exports, research), Viewer (permitted records/reports), Service principal (scoped API/MCP). No role can read back plaintext gateway keys through a normal API.

Primary journeys:
1. Analyst selects “Find land buyers,” enters counties and property criteria, reviews source coverage and budget, runs now, and receives a ranked, evidence-linked list.
2. Analyst monitors permit or listing changes on a recurring schedule and sees only meaningful changes, not HTML noise.
3. Analyst opens a parcel and sees dated ownership, transactions, listings, permit projects, and uncertain entity connections separately.
4. Agent submits a bounded query through authenticated MCP, receives a job ID, then retrieves records and citations.
5. Admin opens a source incident, sees its impact and reproduction evidence, exports a repair brief, and tracks a tested connector update.

Proposed pilot acceptance targets, not vendor claims:
- 100% of accepted material facts have source identity and observation timestamps.
- At least 98% correct audited critical fields and 99% precision for automatically accepted identity links on a stratified, labeled sample of at least 200 applicable records. Publish numerator, denominator, source mix, confidence interval, and exclusions. If sample volume is insufficient, show provisional quality, not certification.
- Duplicate trigger, retry, and crash recovery produce no duplicate logical run or committed observation.
- No secrets or unrestricted raw browser content in standard logs, HTML exports, or model prompts.
- Typical internal list query p95 below 1 second on a documented 100,000-record synthetic benchmark; exports of 100,000 rows stream without exhausting memory. Live source latency is measured separately.
- Core workflows keyboard-accessible at 1440, 1280, 768, and 390 pixel viewport widths; no inaccessible critical control.
- Routine retry, resumable jobs, and known source failures do not require owner intervention. Credentials, human challenges, missing rights, and destructive actions remain explicit exceptions.

## 3. Scope and priorities

All P0 requirements and P1 capabilities below belong to the complete V1 handoff. Milestones sequence implementation; they are not permission to omit difficult capabilities.

| ID | Requirement | Priority | Acceptance evidence |
| --- | --- | --- | --- |
| R01 | Free-source registry and eligibility enforcement | P0 | Paid/unknown-cost requests blocked before execution; reason displayed |
| R02 | Instant, one-time scheduled, recurring campaigns | P0 | Time-zone, DST, duplicate-trigger, pause, cancellation tests |
| R03 | Durable jobs, checkpoints, retry/resume | P0 | Kill worker mid-run; recover without duplicate records |
| R04 | Structured downloads, Scrapling HTTP/browser extraction, documents and imports | P0 | Same contract suite across supported drivers |
| R05 | Multiple fallback providers and adaptive routing | P0 | At least two local retrieval methods and two separately configured optional provider slots; quota/cost exhaustion tested |
| R06 | Autonomous evidence-driven research | P0 | Multi-step research yields claims, citations, gaps, budget accounting |
| R07 | Domain acceptance model, deduplication and entity links | P0 | False-merge, conflicting-owner, bulk-sale fixtures |
| R08 | Campaign and record UI with evidence review | P0 | End-to-end analyst workflow |
| R09 | Analytics and coverage dashboard | P0 | Metrics reconcile against fixture SQL totals |
| R10 | CSV, JSON, Markdown, HTML exports | P0 | Round-trip schema checks; injection/escaping tests |
| R11 | CLIProxy keys, model and reasoning-effort configuration | P0 | Mock and optional real gateway capability tests |
| R12 | Secure REST API and MCP access | P0 | Scope isolation, revoked keys, malicious inputs tested |
| R13 | Structured logs, incidents, actionable repair briefs | P0 | Simulated parser drift produces sanitized reproducible brief |
| R14 | Admin configuration and audit history | P0 | Every configurable policy has authorized UI and validation |
| R15 | Searchable in-app Help and operational documentation | P0 | Help coverage mapped to every feature and common failure |
| R16 | Structured change tracking, alerts, saved views | P1 | No alert on retrieval failure masquerading as removal |
| R17 | Coverage discovery and no-fee request drafts | P1 | Missing geography creates gap record and draft, never auto-send |
| R18 | Import user-owned data, suppressions and feedback | P1 | Field mapping preview; reversible import; feedback recorded |
| R19 | Exportable research reports and buyer-property matching | P1 | Stated/observed/inferred criteria displayed distinctly |
| R20 | Repair lifecycle with Lanes handoff and canary rollback | P1 | Regression -> brief -> tested candidate -> canary -> rollback test |

Deferred: paid data procurement, public SaaS, native mobile applications, GIS editing, arbitrary public code execution, automatic outreach, autonomous production deployment, advanced machine-learned routing, vector database, graph database, Kubernetes.

## 4. Architecture stack

Use a TypeScript application/control plane and one isolated Python collection service built on Scrapling. The second language is a deliberate tradeoff to reuse mature retrieval machinery. Keep business rules, scheduling, canonical data and public APIs in TypeScript; do not duplicate the application in Python.

| Layer | Decision | Rationale |
| --- | --- | --- |
| Runtime / packages | Supported Node.js LTS + TypeScript/pnpm; supported Scrapling-compatible Python + uv | Pin both lockfiles and browser/runtime versions; share versioned JSON contracts |
| Web | React + Vite + React Router; TanStack Query and Table | Internal application does not need server-side rendering |
| UI | Tailwind CSS current stable compatible version, CSS custom-property tokens, shadcn/ui/Radix primitives, Lucide icons | Consistent accessible controls without custom widget frameworks |
| API | Fastify, Zod validation, generated OpenAPI | Typed request boundaries and small service layer |
| Auth | Better Auth through supported Fastify integration, local credential login, server sessions | Avoid hand-written password/session cryptography; registration disabled |
| Database | PostgreSQL + PostGIS; Drizzle schema/migrations, explicit SQL for complex spatial queries | Relational facts and geographic joins in one database |
| Queue | pg-boss; application schedule/occurrence table + DB lock | Durable jobs without Redis; application defines timing semantics |
| Storage | Local durable volume behind artifact-store interface; content-addressed files | No initial object-store dependency; later S3 adapter possible |
| Retrieval | Scrapling pinned upstream package in isolated Python collection service; native structured-data downloads remain first | Reuse HTTP fetching, browser sessions, parsing and bounded crawling; no custom parallel HTML engine |
| Documents | Sandboxed PDF text extraction; OCR via optional local Tesseract; CSV/JSON parsers | Keep large binaries away from API; no mandatory LLM OCR |
| LLM | Server-side CLIProxy-compatible adapter supporting capability-tested Responses or Chat Completions | No baked-in model IDs or effort assumptions |
| MCP | Official TypeScript MCP SDK; local stdio bridge to scoped REST API in V1 | Secure agent integration without inventing remote OAuth server |
| Analytics | SQL aggregates, small SVG chart components or Recharts; tables for exact values | No external analytics service or BI stack |
| Logs / tests | Pino JSON + compatible structured Python logs; Vitest; pytest/Ruff; Playwright E2E + axe; PostgreSQL integration tests | Cross-language contract and sandbox tests; Playwright remains a UI test tool |
| Deployment | Docker Compose: app, TypeScript worker, Python collection service, database, egress control | Distinct process privileges; one host, no microservice platform |

API and UI share an origin. The API never runs browsers. Worker retrieval egress is filtered; only the trusted LLM client may connect to the configured internal gateway. The Python collection service, including every browser it launches, must not reach database, gateway, internal subnets, host services, or cloud metadata. Container network separation plus a filtering egress proxy/firewall enforces this; request interception alone is not sufficient.

Scrapling is the primary HTML/browser engine; WebClaw and Firecrawl remain references, not required runtime dependencies. Do not build three competing scraping engines. Keep structured government downloads independent so a Scrapling outage does not interrupt those sources. An optional future alternative engine requires measured benefit, license review and an ADR.

Do not install a second workflow framework, second ORM, Redis, Elasticsearch, or an agent framework without a measured need and an architecture decision record (ADR: a short record explaining a design choice).

### 4.1 Scrapling adoption, fork policy and ownership

Use the upstream package pinned to an evaluated release. A repository mirror is optional for continuity; a modified fork is not the starting requirement. Keep source adapters in our application repository. Fork only for a reproduced internal limitation that cannot be solved through documented extension points. Record the upstream commit, minimal patch, license notices, regression test, upstream issue/PR if authorized, and rebase/update owner. Do not auto-upgrade browsers or Scrapling on production workers.

The upstream repository documents HTTP/browser retrieval, adaptive matching and crawling features; these are capabilities to verify, not a guarantee for our target sites. Its BSD-3-Clause license permits modification/reuse under its conditions. Retain notices and review dependencies. Sponsor advertisements and external proxy/solver services are not bundled free features.

Application owns campaigns, budgets, rights, retries across attempts, schedules, global domain throttles, evidence, canonical records and exports. Scrapling owns one bounded fetch/parse/crawl operation. Its internal retries count against the same request budget and are disabled or capped to avoid retry multiplication. Its checkpoints are subordinate to application run/task IDs, never a second job scheduler. Its MCP server is not exposed to users; our scoped MCP/API remains the agent entry point.

Service boundary: private authenticated versioned HTTP interface; strict request/response schemas; short tasks with timeout and cancellation; no LLM keys, database credentials, or arbitrary Python execution. The service returns observations and evidence manifests; the TypeScript worker validates and persists them. Shared JSON Schema is validated in TypeScript and Python. Artifacts are placed in a restricted staging volume and promoted by the worker after MIME/size/hash checks; returned paths are opaque IDs, not arbitrary filesystem paths.

### 4.2 Adaptive extraction and qualification gates

Adaptive element matching may recover changed selectors but can also select the wrong element. Record original selector, recovered selector, recovery method, matching metadata when exposed, and validation outcome. No recovered price, owner, APN or status becomes verified merely because a nonempty string was found. Critical adaptive matches require independent semantic checks; ambiguous cases become candidates for review. Similarity scores are not calibrated truth probabilities.

Qualify a pinned build on 30–50 representative pages across public records, planning documents and eligible property sources. Include layout-shift fixtures, multi-page results, rate limits, challenge pages, session expiry and wrong-but-plausible field matches. Measure accepted-field accuracy, usable results, memory, latency and maintenance burden against simple structured/HTTP baselines. Unknown or blocked sources are not counted as successful. If security/quality gates fail, isolate that mode/source and produce a repair brief; do not silently declare universal access or switch to paid services.

Admin adds collection engine/browser versions, engine health, per-source retrieval mode, adaptive matching policy, session isolation, attempt caps and rollback version. Users see collection failures as source incidents. Help explains dependency versus fork, refresh/replay, adaptive matching versus code repair, free-only behavior and why a challenge may still need a person.

## 5. Campaign behavior

### 5.1 Campaign definition

Fields: ID, version, owner, title, objective/template, natural-language question, geography (county FIPS/polygon/address list), asset types, criteria, requested fields, seed entities/URLs, allowed sources, excluded domains, field freshness, research depth, deduplication scope, schedule, budgets, output preferences, notification rules, retention policy.

Templates: land-buyer discovery; builder activity; institutional SFR acquisition research; permit monitoring; ownership/transfer lookup; land/SFR listing watch; market snapshot; contact enrichment; source-gap investigation; custom research. Templates set defaults, not hidden permissions.

Wizard steps: Objective -> Geography and filters -> Sources and gaps -> Timing and limits -> Review. Show next five scheduled times in local zone and UTC, estimated maximum work, eligible source count, unsupported requested fields, and LLM configuration status. Advanced settings are collapsed. Save draft, preview, and run are distinct.

### 5.2 Execution and scheduling

Campaign state: draft, active, paused, archived. Run state: queued, running, waiting_user, retry_wait, completed, partial, failed, cancelling, cancelled. Each run snapshots campaign version, source policy versions, prompt/model configuration, and schedule occurrence.

- Instant: enqueue after preflight; return immediately with run ID. Idempotency key prevents double-click duplicates.
- Scheduled once: persist chosen instant and original zone; overdue runs follow misfire policy.
- Recurring: daily/weekly/monthly UI and advanced validated cron. Default timezone is America/Chicago. Show DST behavior explicitly: nonexistent local time skips that occurrence; repeated local time runs once at the first occurrence. Monthly day 29/30/31 skips months without that day. Use a timezone-aware tested library, not string arithmetic.
- Scheduler locks due schedule rows, creates unique `(schedule_id, scheduled_for)` occurrence and run in a transaction. Outbox dispatcher retries queue publication after crashes. Assume at-least-once delivery; handlers are idempotent.
- Misfire default: coalesce into one catch-up within 24 hours, otherwise mark missed; never unbounded backfill. Admin can configure skip/coalesce and grace period.
- Overlap default: skip next occurrence while prior run active; record skipped reason. Optional queue-one behavior, never unlimited overlap.
- Pause prevents future launches; current run continues unless separately cancelled. Resume does not replay all missed occurrences.
- Cancellation propagates at task boundaries and aborts active requests; completed evidence remains with cancelled/partial provenance. Retry failed tasks, not the entire successful history.
- Waiting-user sessions expire after a default 24 hours; unrelated sources continue. A campaign can finish partial with unresolved items.

Default per run: 100 pages, depth 2, 20 LLM calls, 60-minute wall time, 200,000 total input/output tokens, 50 MB per download, 200 MB artifact budget, 2 browser pages concurrently, per-domain concurrency 1. All validated and configurable; no implied spend estimate when pricing unknown. Refresh-only work may have lower limits. Global scheduler tick <=30 seconds and graceful worker shutdown required.

## 6. Source registry and autonomous collection

### 6.1 Source manifest

Every source includes ID, category, root URL, domain allowlist, jurisdiction/geography, upstream lineage, connector family/version, published fields, data period, update cadence, source timestamps, cost mode, free quota/reset, rights assessment URL/date/status, robots policy, authentication requirements, limits, expected totals if available, last success, known gaps, and next health check.

Lifecycle: discovered -> assessment_needed -> eligible -> active -> degraded/paused -> retired. Discovery is not authorization. Deterministic approved open-data patterns may pass a documented policy; ambiguous terms remain assessment_needed while other work continues. Persist assessment reason. A changed terms fingerprint queues reassessment rather than silently expanding access.

Source types: published CSV/JSON; Socrata; ArcGIS feature service; generic HTML; browser portal; PDF/document archive; manual import; optional free-tier provider. Connector capabilities: discover, enumerate, fetch, extract, checkpoint, validate, normalize, diff. A source can support only a subset.

### 6.2 Free-source candidate register

Candidates require live verification during implementation. None are promised nationwide integrations.

| Candidate | Seed URL | Expected use / initial status |
| --- | --- | --- |
| Austin construction permits | https://data.austintexas.gov/d/3syk-w9eu | Public structured data connector; verify schema and terms |
| Seattle building permits | https://cos-data.seattle.gov/d/76t5-zqzr | Public structured data connector; verify live identifier |
| Census BPS | https://www.census.gov/construction/bps/ | Aggregate new-construction context, not buyer records |
| Redfin downloads | https://www.redfin.com/news/data-center/downloads/ | Published research files only after conditions review |
| Realtor.com research | https://www.realtor.com/research/data/ | Published aggregate data; home categories may exclude land |
| Zillow research | https://www.zillow.com/research/market-data/ | Published research downloads; do not equate model index to sale price |
| LandSearch | https://www.landsearch.com/ | Listing candidate; assess collection permission and completeness |
| Land.com / LandWatch / Land And Farm | https://www.land.com/ | Shared-network candidates; deduplicate, not independent corroboration |
| LANDFLIP | https://www.landflip.com/land-for-sale | Asking-price/inventory candidate |
| Landmodo | https://www.landmodo.com/ | Land-investor seller discovery; advertised financing != cash price |
| Homes.com sold | https://www.homes.com/sold/ | Sold-page candidate; field and access assessment required |
| HAR sold | https://www.har.com/homevalues/sold | Texas candidate; “listed for” != closed price |
| County assessor/recorder/GIS | Jurisdiction-specific discovery | Parcel and transaction evidence; fees or unavailable prices create gaps |
| Contractor boards / business registries | State-specific discovery | License and entity relationships; role must be preserved |
| Planning departments | Jurisdiction-specific discovery | Agendas, minutes, plats, cases; separate proposals from approvals |

Redfin listing scraping is not an enabled default because the reviewed terms restrict it. Do not infer permissions for other portals from their presence in this table. Sources requiring payment remain disabled. A public-data request draft may be generated but never sent automatically.

### 6.3 Adaptive routing

Try cheapest eligible method that historically supplies requested fields: published feed -> HTTP -> browser -> alternative free provider -> human/session handoff or gap. Alternative evidence sources are a separate decision: another retrieval vendor cannot supply a fact absent from the page.

Store per domain/page-type/field/method: attempts, content-valid successes, accepted fields, latency, tokens, quota usage, blocked responses, source independence, and failure reasons. Start deterministic; use rolling validated-success rates with minimum 20 attempts before reordering. Exploration is capped at 10% of run budget. Recent failures trip a per-domain circuit breaker (default five consecutive failures, 30-minute cooldown). Honor source rate limits and Retry-After. Default max three transient attempts, exponential backoff with jitter. Never retry 401/403 as a transient loop; classify and route.

The agent can recommend improved routing based on observations. It cannot change rights policy, enable billing, change secret destinations, or raise its own budgets. Two provider configurations may share an upstream source and must not count as independent evidence. Free quotas are atomically reserved before dispatch; unknown remaining quota causes conservative pause, not billable fallback.

### 6.4 Collection utilities

Include bounded sitemap/URL mapping, include/exclude filters, batch URL imports, conditional HTTP caching, force refresh within rate limits, and a source-preview workspace that shows extracted fields alongside evidence before a campaign runs. Cache isolation includes session identity and extractor/schema versions. Optional diagnostic screenshots are protected short-lived artifacts; users opt in before including them in repair bundles. These utilities reproduce useful managed-scraping conveniences without requiring their hosted services.

### 6.5 Protected-source support

Support ordinary JavaScript rendering, permitted interactions, cookie/session persistence, user-completed login/MFA/challenges, per-source waits, downloads, and explicit access denial detection. Detect likely challenge pages without claiming perfect vendor identification. Maintain operational recipes for Cloudflare-style challenge pages, AWS WAF challenges, and unknown access blocks as classifications and handoff paths, not bypass guarantees. An authentication failure must never be converted into an accepted empty record.

## 7. Domain model and field acceptance

All observations carry source record ID/URL, original value, normalized value, event date when known, source-modified time, fetched time, evidence artifact/hash, extractor/model version, and acceptance state. States: verified, corroborated, inferred, conflicted, unknown, stale. Confidence is field-level and not just an LLM percentage.

| Entity | Minimum fields | Critical acceptance rules |
| --- | --- | --- |
| Organization | Raw/normalized name, organization ID, type, source | Role can be builder, contractor, developer, fund, REIT, operator, manager, land investor, unknown; LLC != hedge fund |
| Entity relationship | From/to entity, role, evidence, effective dates | Shared agent/address alone never auto-merges; maintain manager/fund/subsidiary separately |
| Buyer profile | Entity, observed activity, target geography, acquisition category, criteria state | Existing-home buyer != raw-land buyer; distinguish stated, observed, inferred |
| Person/contact | Business association, role, channel, source, checked date, match state | No invented email; registered agent != acquisitions lead; uncertain personal contact separate from public business contact |
| Parcel | County FIPS + raw APN, normalized APN, geometry/address, acreage source, vintage | Leading zeros retained; no national APN uniqueness; split/merge lineage |
| Ownership observation | Parcel, named owner, role, mailing address, source effective date | Assessor and deed observations kept separately; no claim of definitive title |
| Transfer | Instrument, grantor/grantee, recording/execution dates, consideration, parcel links | Bulk consideration not allocated blindly; related-party and nominal transfers flagged |
| Permit/project | Jurisdiction + permit ID, project/parent link, location, raw status/type, dates, parties | Trade permits != homes; issued != started; ambiguous final/expiry != completion |
| Planning case | Jurisdiction + case ID, applicant, geography, proposed/approved quantities, decision/conditions | Recommendation != approval; agenda != enacted decision |
| Listing episode | Source + listing ID, property linkage, raw/normalized status, prices, dates | Missing listing != sold; pending price unknown; separate asking/closing/model values |
| Market metric | Geography, segment, window, numerator/denominator, sample size, vintage, method | Label observed sample vs representative coverage; retain revisions |
| Evidence claim | Subject, predicate, value, supporting observation IDs, contradiction IDs | No unsupported high-impact claim; untrusted content never becomes system instructions |

Identity resolution: exact trusted IDs first; address/geometry/license matches second; fuzzy name matches generate candidates. Auto-merge threshold must be calibrated on labeled fixtures, not arbitrary model confidence. Every merge is reversible, audited, and retains original source identities. Multi-parcel projects and multi-listing parcels use relationship tables.

Price normalization: numeric decimal plus currency and semantic type (asking_cash, down_payment, monthly_payment, closing, valuation, model_estimate). Keep financing terms; never compare monthly payment to total property price. Null != zero. Units explicit; acres and square feet converted with recorded method. Geocodes carry match precision; do not imply a parcel centroid is a building entrance.

## 8. Autonomous research and buyer matching

Research planner decomposes the objective into required facts, identifies missing fields, selects eligible tools, and stops on completion or budget. Persist each step as goal, inputs, tool, evidence outputs, decision summary, and resource use. Do not store or expose hidden chain-of-thought. All LLM output is schema-validated.

Tools: search internal records, discover eligible source candidates, enumerate allowed source, fetch URL, parse document, extract fields, resolve candidate identity, compare observations, calculate metrics, draft report. A model cannot run shell commands, arbitrary SQL, code, network requests outside the controlled fetch interface, or send messages.

Search independence: use internal full-text search, known official catalogs/sitemaps, user seed URLs, and source-native search. Optional configured free search provider can broaden discovery. If web-wide search is unavailable, state bounded discovery coverage rather than presenting exhaustive research. Do not rely on scraping a search engine as an undocumented universal search backend.

Research reports contain question, geography, time window, findings, buyer candidates, supporting records, source limitations, conflicting evidence, unverified inferences, and next recommended checks. Citation verification tests that the cited evidence exists and contains support; it is not proof that a source's claim is true.

Buyer matching displays separate fit, recent activity, evidence strength, contactability, and unresolved gaps. Hard filters for acquisition category and geography precede ranking. Suggested initial windows: 90/180/365 days; missing history reduces confidence, not evidence of inactivity. A listing agent is an intermediary, not the buyer. A seller with multiple listings is a prospect whose buying intent remains unconfirmed.

## 9. LLM gateway configuration

Use user-provided CLIProxy API credentials, not hard-coded direct-provider keys. Admin can add named profiles: base URL, encrypted key, authentication type supported by adapter, preferred endpoint protocol, model ID, effort policy, timeout, maximum output, context limit override, allowed tasks, routing priority, and optional per-token cost estimates.

- Validate connectivity separately from a generation test; never expose key in browser responses after save.
- Model discovery is optional. Cache IDs when available and allow an explicitly entered ID because gateway discovery may be incomplete.
- Reasoning effort is capability-dependent: UI includes Default/Unset plus only verified/configured supported choices. Responses-style `reasoning.effort` and Chat Completions-style `reasoning_effort` are not interchangeable. Pin supported mappings to gateway version and model profile; test before enabling.
- Do not assume every model accepts tools, JSON schema, streaming, vision, or the same effort values. Unsupported configuration produces an actionable error. Never silently send a different model or paid fallback.
- Profiles for extraction, research planning, synthesis, and repair-brief drafting may differ. Run snapshots record actual model and parameters.
- Track retries, token usage, gateway request ID, elapsed time, finish reason, and estimated cost when supplied. Unknown cost is “unknown.” Redact prompts containing unnecessary personal data; send only needed evidence.
- Configure an internal gateway host through an admin-only trusted connection allowlist. This exception never applies to scraper URLs, browser traffic, webhooks, or arbitrary redirects.
- No gateway key: deterministic extraction, imports, scheduling, browsing, exports, and Help still work. Research explains its configuration dependency.

## 10. Interface and design system

Deliver an efficient analytical workspace, not an AI-chat landing page. Persistent sidebar: Overview, Campaigns, Records, Research, Sources, Issues, Exports, Help. Admin appears for authorized users. Global search and keyboard command menu; chat is not the primary navigation.

Design tokens: warm off-white background, white surfaces, slate text, one muted teal accent, semantic status colors with text labels. System sans font; tabular numerals for counts/prices. Body 14–16 px, headers 20–28 px, 4 px spacing scale, 6–8 px radii, subtle borders, minimal shadows. No decorative gradients, glass panels, giant greeting banners, animated particles, rainbow charts, excessive pills, emoji icons, or blank hero areas. Optional dark theme uses the same semantic tokens.

Main views:
- Overview: compact KPI strip (accepted records, unresolved gaps, source health, active runs), activity trend, recent runs, prioritized issues. Every metric shows period and coverage context.
- Campaigns: sortable table, template filter, New campaign; detail tabs for Overview, Runs, Results, Changes, Settings.
- Results: server-side filters, saved views, column chooser, bulk select, export, evidence drawer. Use virtualization only when measured need exists. Show partial-data indicators without clutter.
- Research: brief composer, structured task progress, findings, citations, gaps; no invented progress percentage.
- Source detail: fields, coverage, freshness, eligibility, recent attempts, quota, incidents, recipe/version.
- Issue detail: human explanation, affected campaigns/fields, sanitized evidence, retry/pause, repair-brief export, candidate-fix history.
- Admin: grouped settings with search, per-setting help, validation and audit history; “Test connection” never doubles as “Save.”

Loading, empty, partial, unauthorized, waiting-user, stale, offline, and error states must be designed for every critical page. Filters persist in URL; unsaved edits prompt on navigation. Tables remain horizontally scrollable on small screens without hiding essential actions. Buttons use verbs. Danger actions name consequences; irreversible deletion uses confirmation, ordinary save/run does not.

Accessibility target WCAG 2.2 AA: focus visibility, labels, contrast, live status announcements, reduced motion, keyboard menus/dialog focus trapping, chart text summaries, no color-only interpretation. Verify contrast numerically. Require real screenshot review of populated, empty, and failed states. Use `ui-ux-pro-max` for design direction and `ui-styling` for implementation if available; record actual skill provenance and do not claim a skill was used when absent.

## 11. Analytics, monitoring, exports

Analytics: unique entities/parcels, observed acquisitions, permit projects and units separately, listing inventory and transitions, price reductions, days observed, buyer activity, field acceptance, source coverage, collection lag, error rates, connector quality, token/runtime consumption, queue age. Distinguish market metrics from operational metrics.

Months of supply = eligible observed active inventory at period end divided by average monthly eligible closed transactions over configured trailing window. If coverage/history/denominator is insufficient, return unavailable with reason. List-price-per-acre cohorts must match geography, land use and acreage band; do not combine rural acreage and infill lots. Revised publisher datasets retain vintage and replace/recompute affected aggregates without erasing history.

Changes: field-level semantic diffs plus optional cleaned-text diff. Detect new listing, explicit status change, price change, permit event, contact change. A fetch failure produces a source incident, never a property removal. Removal needs explicit source evidence or a separately labeled repeated-not-observed state. In-app notifications are baseline; signed outbound webhooks are opt-in and use event IDs, replay protection, bounded retries, and separate allowlisted destinations. No email/SMS delivery in V1.

Exports:
- CSV: selectable flattened schema; APNs as text; UTF-8; stable columns; spreadsheet-formula escaping by default for leading `=`, `+`, `-`, `@`, tab/CR; raw JSON preserves exact strings.
- JSON: versioned envelope, records, evidence references, filters, coverage, generated time, run/source versions.
- Markdown: readable report/tables, source links, limitations, no embedded executable HTML.
- HTML: self-contained static document with escaped content, no scripts, no untrusted remote resources, accessible tables, print CSS.
- All formats: honor role/field-level contact visibility, suppress secrets/raw cookies, consistent snapshot, row counts, manifest, SHA-256 checksum. Exports >10,000 records become jobs; authenticated downloads expire (default 24 hours). Revoked credentials lose access immediately.

## 12. Admin and security

Admin sections: Organization/users/roles; Geography; Campaign defaults/schedules; Source eligibility/recipes; Retrieval drivers/free quotas; LLM connections/model/effort profiles; Research budgets/prompts; Quality/identity thresholds; Notifications/webhooks; API keys/MCP; Retention/exports; Jobs/resources; Audit/backups; Help/version diagnostics.

User-configurable means safe validated options, not arbitrary shell, SQL, executable prompts, unrestricted outbound hosts, or uploadable server plugins. Secret rotation and master encryption key operations use documented host procedures. Admin can modify declarative connector selectors/configuration within constrained schema; executable connector code follows release controls.

Security requirements:
- Local/private deployment baseline; HTTPS for remote access. Secure HTTP-only sessions, CSRF/origin defenses, rate-limited login, logout and revocation. Initial admin setup requires a one-time host-generated secret; no default password or open signup. Provide offline admin reset command with audit record.
- Scoped opaque API keys, high-entropy generation, hashed storage, expiry, revocation, prefix display, per-key quotas. Keys cannot edit settings, retrieve secrets, or impersonate admins.
- All URL retrieval validates schemes, DNS results, resolved IP, redirects, IPv4/IPv6, internal names and metadata ranges. Pin validated destination or enforce DNS-aware egress to prevent rebinding. Apply to browser subresources, PDFs, remote images, and webhooks.
- Scraper workers lack database credentials where possible; Python collection service accepts bounded authenticated tasks and returns artifacts through controlled channel. No host Docker socket or shell access.
- Uploads: extension and MIME validation, archive/zip bomb limits, path traversal rejection, parser process limits. Raw files are attachments, not served inline on app origin.
- Encrypted provider/session secrets; master key outside DB; backup/key separation. Role-filtered contacts and retention. Raw evidence may contain personal data; minimal access and configurable deletion.
- Audit: authentication, settings, source policy, API keys, exports, identity merges, suppressions, repair promotion. Log summaries and IDs, not secret values.

MCP V1: official SDK stdio bridge using a scoped API key from environment/key store. Tools: `search_records`, `get_record`, `get_evidence`, `create_research_run`, `get_run`, `cancel_run`, `create_export`, `get_source_status`. No arbitrary SQL, raw secrets, shell tool, or default schedule mutation. Tool annotations are descriptive, not authorization. REST enforces scopes and budgets. Remote Streamable HTTP MCP is optional after standards-compliant OAuth/resource metadata implementation; do not expose a public unauthenticated MCP endpoint or claim OAuth compliance from a custom bearer header alone.

## 13. Descriptive errors and repair intelligence

Use a stable error taxonomy: SOURCE_ACCESS_DENIED, AUTH_REQUIRED, CHALLENGE_REQUIRED, RATE_LIMITED, SOURCE_CHANGED, PAGINATION_INCOMPLETE, EMPTY_CONTENT, PARTIAL_CONTENT, PARSE_FAILED, SCHEMA_MISMATCH, IDENTITY_CONFLICT, SOURCE_STALE, FREE_QUOTA_EXHAUSTED, POLICY_BLOCKED, LLM_CONFIG_INVALID, LLM_UNAVAILABLE, LLM_OUTPUT_INVALID, BUDGET_EXCEEDED, STORAGE_FAILED, INTERNAL_ERROR.

Each error contains safe user message, code, retryability, correlation ID, source/run/task/connector version, attempted action, observed outcome, likely cause labeled as hypothesis, and suggested next action. Stack traces are admin-only with redaction. Log events include duration and counters. Do not put all errors in a generic “AI failed” bucket.

Incident grouping uses source + connector version + normalized failure signature. Track first/last seen, occurrence count, impacted fields/records, severity, owner, status, workaround, resolution version. Drift monitors compare field null rates, record counts, and schema changes against a baseline; distinguish real market decline from failed pagination.

Every actionable incident can produce a Markdown repair brief with: objective; source access policy; sanitized reproduction; expected vs actual; last good/current versions; minimal fixture; failing test; suspected files from connector registry; proposed change boundaries; regression criteria; deployment/rollback steps; unknowns. Generated file paths must be validated against the repository manifest, not guessed. Briefs do not contain access tokens or copyrighted bulk content beyond the necessary permitted fixture.

Lifecycle: detected -> triaged -> brief_ready -> assigned -> candidate_tested -> canary -> resolved / rolled_back. Runtime creates local briefs only. Lanes performs code work in isolated worktrees; production code is never rewritten by a research run. Safe canary promotion may be preauthorized by an admin policy for allowlisted connector-only changes after independent review; default promotion is manual. Changes to auth, source rights, network policy, billing, or database schema always require explicit review.

## 14. Help section and documentation contract

Help is a product feature, not a link to a README. Ship searchable version-controlled Markdown rendered safely, with task-oriented navigation, glossary, related links, code-copy buttons for API examples, and contextual links from every settings group/error state. Help must work without LLM or external network. Optional AI help is out of scope.

Required pages:
1. Quick start and first campaign, including a clearly labeled offline fixture demo.
2. Source coverage, free-only policy, limitations, source assessment and free-quota behavior.
3. Land/SFR buyer research and the distinction between buyers, sellers, contractors, funds and managers.
4. Geographic selection, county/APN matching, permits/projects, ownership and transfer interpretation.
5. Run now, schedule once, recurrence, timezone/DST, overlap, misfires, pause/resume/cancel.
6. Research depth, evidence, conflicts, confidence states, budgets and stopping behavior.
7. CLIProxy setup, connectivity tests, model discovery/manual IDs, endpoint compatibility, reasoning effort, gateway key rotation, unknown costs.
8. Scrapling retrieval modes, browser sessions, login/MFA handoff, challenges, adaptive-match review and unsupported access.
9. Source onboarding, CSV/JSON imports, documents/OCR, schema mapping, connector health.
10. Listing statuses, price semantics, sold-price limitations, coverage-adjusted market metrics.
11. Saved views, buyer matching, changes, notifications and webhook administration.
12. Exports with exact schemas and CSV safety behavior.
13. API authentication, scopes, errors, pagination, idempotency, sample requests and MCP configuration.
14. Admin roles, retention, credentials, audit history, backup/restore, host upgrades.
15. Troubleshooting by stable error code and how to read a repair brief.
16. Lanes operator workflow, code repair boundaries and rollback.
17. Privacy, suppression, data deletion, local compute costs and source rights.
18. Release notes, known limitations, source health and diagnostic bundle export.

Each page includes prerequisites, numbered steps, expected result, common failures, recovery, and related Help links. Screenshots must match shipped UI, exclude secrets and use synthetic records. Add a feature-to-Help coverage test and broken-link check. UI, API, and Help must use the same terms for status and settings.

## 15. Release acceptance and exclusions

Release requires all P0/P1 functions implemented, deterministic integration tests, real-source smoke evidence for accessible permitted sources, export/security tests, backup restoration, accessibility review, and a documented operational runbook. Candidate commercial portals blocked by policy or inaccessible live may remain explicitly unsupported; never mark them working based on synthetic fixtures. A platform release can be complete while a jurisdiction's coverage is incomplete, but both statuses must be visible.

No simulation presented as live data. No user credential invented. No paid dependency added to claim coverage. No assumption that agent-written code is correct without independent review and repeatable tests. The coding harness must resolve routine engineering choices autonomously and batch only genuine external blockers for the owner.

## 16. Evidence and reference register

These references inform the specification; architecture and acceptance rules above are proposed decisions. Recheck moving documentation during bootstrap and record versions. Do not treat an upstream README as installation authorization for arbitrary scripts.

- Shovels collection disclosures: https://www.shovels.ai/blog/monthly-memo-june-2026/ and https://www.shovels.ai/blog/project-storm-how-were-bringing-americas-offline-jurisdictions-online/
- Shovels field provenance: https://www.shovels.ai/data-dictionary and https://www.shovels.ai/blog/shovels-data-source-column/
- Scrapling repository/license: https://github.com/D4Vinci/Scrapling and https://github.com/D4Vinci/Scrapling/blob/main/LICENSE ; capabilities require pinned-version validation.
- Scrapling parsing documentation: https://scrapling.readthedocs.io/en/latest/parsing/selection.html
- WebClaw self-host differences (reference only): https://webclaw.io/docs/self-hosting and https://github.com/0xMassi/webclaw
- Firecrawl change tracking: https://docs.firecrawl.dev/features/change-tracking (inspiration for semantic diff; no service dependency)
- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI and its current config.example.yaml; model capabilities must be tested against the user's installation.
- MCP security: https://modelcontextprotocol.io/specification/latest/basic/security_best_practices
- Tailwind/Vite: https://tailwindcss.com/docs/installation/using-vite
- Better Auth/Fastify: https://better-auth.com/docs/integrations/fastify
- pg-boss: https://github.com/timgit/pg-boss
- UI/UX skill candidate: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill ; use owner's installed vetted copy where available.
- Lanes orchestration: Use the installed Lanes harness. Its exact instructions were unverified during authoring.
