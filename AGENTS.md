# Working on Skyscrape

Read [PLAN.md](PLAN.md) and both required v1.1 specifications before changing behavior. Use [DESIGN.md](DESIGN.md) for the analyst workflow, [GLOSSARY.md](GLOSSARY.md) for domain terms, and the [approved execution decisions](.project-kickoff/DISCOVERY.md) for prior scope overrides. Apply the current instructions below for model routing, design, and demo hosting. [CONTEXT.md](CONTEXT.md) and the [Lanes binding](docs/lanes-binding.md) point to the current work boundary.

## Work in Lanes

- Use embedded Beads in the canonical checkout as the only live tracker. `PLAN.md` defines approved scope and acceptance. Reconcile the live tracker and Git before dispatch or resume. The orchestrator owns planning, questions for the owner, shared context, tracker updates, dispatch, and integration. Delegate implementation and verification to lanes.
- The orchestrator delegates code, scaffold, and documents to isolated worktrees and sends each collected revision to a separate cross-model reviewer. Keep at most six participants total. Only the orchestrator dispatches. Reconcile unfinished work before any replacement.
- Every worker and reviewer, including remediation, resume, and replacement sessions, reads the installed `poteto-mode/worker.md` first. Read and apply `poteto-mode/SKILL.md` and `ponytail/SKILL.md` in full. Use Ponytail full mode. Report unavailable Cursor-only integrations by name.
- The owner requests GPT-6.2 Astra medium for the orchestrator. The owner controls the active session setting. Assign GPT-6.2 Sol high to complex delegated work and GPT-6.2 Sol medium to standard delegated work. For independent review, select a different model from the author through the installed Lanes route. Record the model and effort the host actually accepts.
- Edit only the paths assigned in the brief. Give shared contracts, migrations, lockfiles, and theme tokens one owner at a time. Keep scratch work and disposable test services lane-local. For a test service, verify a free loopback port and label the container `lanes.lane=<lane>`. Remove only the lane's own resources.

## Verify the changed behavior

Build the smallest complete change that meets the acceptance criteria. Run focused tests for changed behavior and the failures that can cost money, compromise security or privacy, or corrupt data. Exercise authorization, suppression, and retry safety where the change touches them. Preserve the checks required by the task. Report exact commands, revision, results, and limits. Use synthetic results for repeatable checks and label them as such. Follow `PLAN.md` for qualified live evidence and use the Lanes collection format for handoff.

Use qualified public sources and free services. Keep credentials, contact data, raw evidence, and private identifiers out of Git and logs. External sends, paid vendors, and public deployment are outside the approved scope. Source eligibility, authorization, and suppression apply to exports and scoped API and MCP access. Follow the release authority recorded in the plan and use the private preview and recovery evidence required by WP13.

## Design and release

The owner approved the Permit Register layout, with the results table and evidence side by side. The revised mockup uses a gray menu panel and yellow accents, with a white canvas in light mode and a black canvas in dark mode. Limit GUI work to static design mockups until the owner approves the revised mockup. Begin GUI implementation after that approval.

Use the full Docker Compose profile for local development and verification. Run builds, lint, and tests locally. Obtain fresh, explicit authorization for each remote action, including any push to `origin/main`, hosted CI trigger, or deployment. Treat the published source-only baseline and the private runtime, credentials, and data as separate release decisions.

Vercel Hobby and Supabase Free are the requested targets for a temporary, entirely noncommercial recording demo. See the [demo hosting proposal](docs/demo-hosting.md) for the hosted compatibility checks. Preserve the full application and its privacy requirements. Obtain separate instructions before deleting demo resources after recording.
