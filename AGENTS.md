# Working on Skyscrape

Read [PLAN.md](PLAN.md) and both required v1.1 specifications before changing behavior. Use [DESIGN.md](DESIGN.md) for the analyst workflow, [GLOSSARY.md](GLOSSARY.md) for domain terms, and the [approved execution decisions](.project-kickoff/DISCOVERY.md) for scope overrides. [CONTEXT.md](CONTEXT.md) and the [Lanes binding](docs/lanes-binding.md) point to the current work boundary.

## Work in Lanes

- Use embedded Beads in the canonical checkout as the only live tracker. `PLAN.md` defines approved scope and acceptance. Reconcile the live tracker and Git before dispatch or resume. The orchestrator owns shared context, tracker updates and integration.
- The orchestrator delegates code, scaffold, and documents to isolated worktrees and sends each collected revision to a separate cross-model reviewer. Keep at most six participants total. Only the orchestrator dispatches. Reconcile unfinished work before any replacement.
- Every worker and reviewer, including remediation, resume, and replacement sessions, reads the installed `poteto-mode/worker.md` first. Read and apply `poteto-mode/SKILL.md` and `ponytail/SKILL.md` in full. Use Ponytail full mode. Report unavailable Cursor-only integrations by name.
- The user selected GPT-6.2 Astra high for planning, GPT-6.2 Astra medium for complex delegated work, and GPT-6.2 Sol high for other delegated work. For independent review, select a different model from the author through the installed Lanes route. Record the model and effort the host actually accepts.
- Edit only the paths assigned in the brief. Give shared contracts, migrations, lockfiles, and theme tokens one owner at a time. Keep scratch work and disposable test services lane-local. For a test service, verify a free loopback port and label the container `lanes.lane=<lane>`. Remove only the lane's own resources.

## Verify the changed behavior

Build the smallest complete change that meets the acceptance criteria. Run focused tests for changed behavior and the failures that can cost money, compromise security or privacy, or corrupt data. Exercise authorization, suppression, and retry safety where the change touches them. Preserve the checks required by the task. Report exact commands, revision, results, and limits. Use synthetic results for repeatable checks and label them as such. Follow `PLAN.md` for qualified live evidence and use the Lanes collection format for handoff.

Use qualified public sources and free services. Keep credentials, contact data, raw evidence, and private identifiers out of Git and logs. External sends, paid vendors, and public deployment are outside the approved scope. Source eligibility, authorization, and suppression apply to exports and scoped API and MCP access. Follow the release authority recorded in the plan and use the private preview and recovery evidence required by WP13.
