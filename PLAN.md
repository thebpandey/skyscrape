# Skyscrape implementation plan

The first analyst outcome is a municipal permit campaign whose accepted fields can be traced to their source and exported to a permitted CSV. It is a vertical slice of the full release. The immutable [product requirements](docs/requirements/01_Land_Intelligence_PRD.md) §3 define R01 through R20. The [implementation baseline](docs/requirements/02_Land_Intelligence_Implementation_Plan.md) §13 defines each work package's prerequisites, file boundaries, outputs, checks and exit criteria. Apply the [confirmed execution decisions](.project-kickoff/DISCOVERY.md), DEC-001 through DEC-005. Live assignments and status belong in Beads.

## First slice

For sky-slice, qualify the municipality's published dataset before collection. Record its publisher, rights evidence and assessment date, fields, jurisdiction, time coverage, free access, limits and known gaps. Austin is the first candidate. Keep an unqualified source out of the run. An offline fixture must identify itself as synthetic.

An analyst previews coverage and limits and runs a saved permit campaign. Preserve the jurisdiction and permit ID, raw and normalized status, participant role, relevant dates, source record and artifact reference. Open an accepted field and trace it back to the observation. Show missing or disputed values explicitly. Replaying the same source revision must leave one logical observation.

Export the same snapshot as a formula-safe CSV with stable columns, evidence references, row count and checksum. Enforce authorization at creation and download. Include only unsuppressed, verified public business channels for authorized analysts. Apply the same authorization to scoped MCP. A viewer can inspect contact-stripped evidence, including safe excerpts, without access to raw artifacts containing contacts.

## Requirement coverage

Read each row with the corresponding WP entry in §13. The parent records are sky-foundation, sky-workflow and sky-operations. The handoff records the individual [Beads IDs](.project-kickoff/LANES_HANDOFF.md).

| Package | Deliverable | PRD requirements served |
| --- | --- | --- |
| WP00 | Verified bootstrap and dependency pins | Foundation for R01 through R20 |
| WP01 | Shared contracts, storage and authorization | R07, R12, R14 |
| WP02 | Campaigns, schedules and durable runs | R02, R03 |
| WP03 | Isolated collection and bounded fallback | R01, R04, R05 |
| WP04 | Accessible shell and shared controls | R08 |
| WP05 | Source qualification, connectors and import | R01, R04, R05, R17, R18 |
| WP06 | Dated records, field acceptance and suppression | R07, R18, R19 |
| WP07 | Bounded research and gateway capabilities | R05, R06, R11, R19 |
| WP08 | Campaign, record and research journeys | R02, R06, R08, R16, R19 |
| WP09 | Coverage-aware analytics and changes | R09, R16 |
| WP10 | Authorized exports, REST and scoped MCP | R10, R12, R19 |
| WP11 | Source incidents and repair handoff | R13, R20 |
| WP12 | Administration, offline Help and recovery | R14, R15 |
| WP13 | Independent release evidence and private preview | R01 through R20 |

After WP01, the campaign engine, collection service and shell can proceed independently where their files are disjoint. Serialize changes to shared contracts, migrations, lockfiles and tokens. Use merged API contracts for UI integration. Pin supported TypeScript and Python dependencies during setup. Keep scheduling, authorization and canonical records in the TypeScript control plane. The isolated Python collection service performs bounded retrieval.

## Evidence for acceptance

Close sky-slice only after one bounded end-to-end run against a qualified, free public municipal permit source using the opt-in live smoke check in the implementation baseline §12.2. Record the source assessment and run ID. Trace one accepted permit field to its source observation and verify that the same field and evidence reference appear in the CSV an authorized analyst downloads from that run snapshot. Keep the CSV and raw evidence private. Link sanitized proof by ID with the row count and CSV checksum. If no source qualifies or the run fails, record the gap and keep sky-slice open. Use a small, labeled synthetic permit fixture for repeatable analyst and viewer checks. Inspect the CSV and evidence responses for restricted fields and verify that viewers cannot create or download an export. Preserve the original release evidence requirements and label any unmeasured quality, volume, coverage or performance target pending. WP13 requires the private preview, independent security and accessibility evidence, a restore rehearsal and documented limits. Public deployment, paid access and external sends have no authorization.
