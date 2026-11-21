# Skyscrape analyst workspace

Design reference for the planned private workbench. See the v1.1 [PRD §10](docs/requirements/01_Land_Intelligence_PRD.md), [implementation plan §9](docs/requirements/02_Land_Intelligence_Implementation_Plan.md) and [decisions DEC-001 through DEC-003](.project-kickoff/DISCOVERY.md).

## Follow one permit

An analyst opens Campaigns and chooses permit monitoring. Ask for objective, geography, fields, eligible sources, timing and limits. Leave production geography empty until selected. Preview coverage, unavailable fields and the maximum work before Run. Keep Save draft separate. For a schedule, show the next five occurrences in local time and UTC.

Run detail shows accepted records, unresolved fields and the reason a source stopped. Results keep jurisdiction, permit number and raw status visible. Selecting a field opens an evidence drawer with the source, original value, dates, extraction version and acceptance state. Link permits to a project only when evidence supports the relationship. Keep conflicting observations side by side.

Authorized analysts select columns, review the snapshot and download the CSV. Identify excluded or suppressed fields without echoing their values. Viewers receive contact-stripped evidence and have no export action. Scope checks protect direct requests and downloads. Keep unsafe original documents out of viewer previews.

## Navigation and states

Group Overview, Campaigns, Records, Research, Sources, Issues, Exports and Help in the primary navigation according to access. Admin is role-gated. Global search and a keyboard command menu can open records. Preserve filters in the URL and return focus to the selected row when a drawer closes. Use Overview for counts with a period, source coverage and sample size.

An empty result identifies the filter or coverage boundary. During loading, label the operation. Partial results retain usable evidence beside each gap. Stale records show their observation date. Waiting for permission identifies who can act. On failure, show a safe reason, correlation ID and retry action when applicable. Show an access-denied state for restricted routes. Offline views identify unavailable actions. Searchable Help explains the action and recovery. Keep secrets out of messages and diagnostic examples.

## Reading and interaction

Use a warm off-white background, white surfaces, slate text and muted teal for actions and focus. Pair semantic colors with text labels. Use system sans, 14–16 px body text, 20–28 px headings, tabular numerals, a 4 px spacing scale and 6–8 px corners. Use subtle borders around dense tables. Show units and distinguish unknown values from zero.

On narrow screens, collapse navigation and scroll wide tables within their own region. Keep evidence and authorized actions reachable by keyboard and touch. Use visible form labels, inline errors, focus trapping and focus restoration in dialogs, and live status announcements. Respect reduced motion and provide table equivalents for charts.

Installed references `ui-ux-pro-max/SKILL.md` and `ui-styling/SKILL.md` informed contrast, touch targets, responsive layouts, semantic tokens and accessible dialog behavior. Planned acceptance includes numerical contrast checks against WCAG 2.2 AA, keyboard operation and populated, empty and failed screenshots using synthetic records. UI verification awaits implementation.
