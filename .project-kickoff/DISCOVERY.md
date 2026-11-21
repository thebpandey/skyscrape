# Skyscrape kickoff decisions

Project Kickoff 0.7.0 · 2026-11-21 · planning checkpoint for sky-kickoff.

The product baseline is the v1.1 PRD and its companion implementation plan in `docs/requirements/`. The following decisions come from the execution brief. They govern differences from the originals.

| Decision | Confirmed boundary |
| --- | --- |
| DEC-001 | Skyscrape is internal to one organization. The public PRD omits owner attribution. Use public sources, private deployment and free data and services. External sends are outside scope, including outreach, records requests and webhook deliveries. |
| DEC-002 | Demonstrate one qualified municipal permit campaign with field provenance and an authorized CSV. Prefer Austin after rights and metadata checks. The user has selected no production market. |
| DEC-003 | Only authorized analysts can export or access contacts through scoped MCP. Only verified public business channels qualify. Apply suppression everywhere, exclude uncertain personal details and strip contacts from viewer evidence. |
| DEC-004 | Beads alone tracks execution. The main orchestrator delegates all code, scaffold and documents in isolated worktrees and dispatches separate cross-model review. Maximum six total participants. Every worker, reviewer, remediation, resume and replacement reads the installed poteto-mode/worker.md first and applies poteto-mode/SKILL.md and ponytail/SKILL.md in full. |
| DEC-005 | Requested planning model GPT-6.2 Astra high, complex delegated work GPT-6.2 Astra medium, other work GPT-6.2 Sol high. These are requested settings. Only a dispatch receipt establishes the actual model. Use small representative tests for changed behavior and consequential failures. |

## Approval and next decision

The brief confirms the product baseline and the decisions above. The derived design and plan await independent review. An approved plan commit, integrated scaffold, toolchain verification and release approval remain pending. Bootstrap supplies project structure only. Actual source metadata and reuse rights determine whether Austin qualifies. If it fails assessment, record the reason and assess another public municipal source before claiming coverage.
