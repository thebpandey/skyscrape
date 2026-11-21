# Skyscrape kickoff decisions

Project Kickoff 0.7.0, 2026-11-21. The user selected both v1.1 specifications in `docs/requirements/` as requirements and approved the kickoff plan with the recorded execution overrides. The approved planning baseline is [PLAN.md](../PLAN.md) at `9c07a5f3d3c54d8645b733a2a6b41a83755a0528`.

| Decision | Approved execution boundary |
| --- | --- |
| DEC-001 | Skyscrape is internal to one organization. Use qualified public sources, free data and services, and private hosting. External sends are outside scope, including outreach, records requests, and webhook deliveries. |
| DEC-002 | The first slice requires one qualified municipal permit campaign with traceable field provenance and an authorized CSV. Assess Austin first for rights and metadata. No production market has been selected. If Austin fails qualification, record why and assess another public municipal source. |
| DEC-003 | Only authorized analysts can export or access contacts through scoped MCP. Only verified public business channels qualify. Apply suppression everywhere, exclude uncertain personal details, and strip contacts from viewer evidence. |
| DEC-004 | Beads alone tracks execution. The main orchestrator delegates code, scaffold, and documents in isolated worktrees and dispatches separate cross-model review. Maximum six participants total. Every worker, reviewer, remediation, resume, and replacement reads installed `poteto-mode/worker.md` first and applies both `poteto-mode/SKILL.md` and `ponytail/SKILL.md` in full. |
| DEC-005 | The user selected GPT-6.2 Astra high for planning, GPT-6.2 Astra medium for complex delegated work, and GPT-6.2 Sol high for other delegated work. Record the actual model and effort at dispatch. Use small representative tests for changed behavior and consequential failures. |

## Approval and resume point

APR-001 records the user's approval of the supplied plan and DEC-001 through DEC-005, as confirmed in the 2026-11-21 handoff brief. The user then directed autonomous execution with both skills and cross-model review. The [planning handoff](LANES_HANDOFF.md) records the Git and Beads evidence for that boundary.

The tracked tree at preparation contains planning documents. WP00 owns bootstrap verification. Source qualification, application tests, independent implementation review, and release approval require evidence at their respective gates. No planning question is pending.
