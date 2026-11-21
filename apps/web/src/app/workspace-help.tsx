import { useState } from 'react'
import { Link } from 'react-router'
import { can } from '../lib/api'
import type { Session } from '../lib/api'
import type { Scope } from '../../../../packages/security/src/index'

type Topic = { title: string; paragraphs: string[]; page?: string; scope?: Scope }

const topics: Topic[] = [
  { title: 'Sign in to the private workspace', paragraphs: [
    'Use the private workspace address and the email and password provisioned by the operator. Public signup is closed. Connecting ChatGPT is a separate, optional step after signing in.',
    'If sign-in fails, confirm the address and saved email. After a password reset, sign in again with the new password. For a lost password, contact the operator through your existing private channel. Keep passwords and session cookies out of screenshots and reports.',
  ] },
  { title: 'Choose from ten campaign templates', page: 'Campaigns', scope: 'runs:read', paragraphs: [
    'Land-buyer discovery finds documented acquisitions. Builder activity groups permit participants by role. Institutional SFR acquisition research examines single-family acquisitions by institutional buyers. A contractor role alone cannot establish buying intent.',
    'Permit monitoring follows filings and statuses. Ownership/transfer lookup traces parcels, owners and instruments. Land/SFR listing watch follows listing episodes and asking prices. A listing price and a recorded closing price describe different events.',
    'Market snapshot summarizes available records for a county, asset and period. Contact enrichment checks verified public business channels. Source-gap investigation identifies missing record coverage. Custom research narrows a record type to a subject. Each template depends on eligible evidence for the requested geography.',
  ] },
  { title: 'Understand the data behind a campaign', page: 'Records', scope: 'records:read', paragraphs: [
    'Permits and projects link jurisdiction-specific filings to documented work. Parcels use county and assessor parcel number. Ownership observations identify who a source named on a date. Transfers identify recorded instruments and the parcels they affect.',
    'Planning cases distinguish proposed units from approved decisions. Listings describe dated offers, status changes and asking prices. Organizations and buyer profiles distinguish stated criteria from documented acquisitions. Business channels require a verified link to the organization and role.',
    'Market metrics depend on a period, coverage and sample size. Provenance records the publisher, source identity, dates and evidence behind a field. Check Preview coverage for data available to your campaign. The Records register currently displays permits. Other eligible results appear within their runs.',
  ] },
  { title: 'Save a campaign and preview its limits', page: 'Campaigns', scope: 'runs:read', paragraphs: [
    'Choose a template. Enter a title, objective, five-digit county FIPS codes and requested fields. Set the reporting window and result limit in Template settings. Work limits bound pages, minutes and model calls.',
    'For Seattle permit monitoring, enter King County (53033) and leave asset types blank. The city feed covers Seattle within the county. Select Save draft, then Preview coverage. Check the eligible sources, stored sample, unsupported fields and gaps. Editing the draft invalidates that preview.',
    'Choose Run now for an instant run. A saved draft alone does not start work. If coverage is missing, check Sources and refine the geography or fields. A zero result count describes this search only.',
  ] },
  { title: 'Schedule or pause a campaign', page: 'Campaigns', scope: 'runs:read', paragraphs: [
    'Under Timing, choose once, daily, weekly, monthly or cron. Enter one-time starts in UTC. Recurring schedules use local time in the selected time zone. Preview the upcoming occurrences in local time and UTC before choosing Activate schedule.',
    'Review the next scheduled run on the saved campaign. Use Pause schedule before editing an active schedule. A pause prevents future launches. Check the existing run separately for its current status.',
  ] },
  { title: 'Read a result and trace field provenance', page: 'Records', scope: 'records:read', paragraphs: [
    'In a saved campaign, open a run from Campaign runs. Under Results, choose Inspect evidence. Compare the source record, event date, retrieval time, extractor version and evidence ID. Where a publisher link or field locator is available, use it to check the original context.',
    'In Records, filter by jurisdiction or exact permit number, select a permit and inspect Field evidence. Raw status preserves the publisher’s wording. Acceptance and observation dates explain whether a value is supported, conflicted, unknown or stale. Preserve missing dates as unknown.',
    'An issuance alone cannot establish a construction start or completion. Several trade permits can describe one project. Ownership is dated, an assessor and recorder can disagree, and a bulk instrument may cover multiple parcels.',
  ] },
  { title: 'Investigate a subject or coverage gap', page: 'Research', scope: 'research:create', paragraphs: [
    'Choose a research template and preview its candidate evidence. For a targeted lookup, enter an exact subject ID in Custom research. Follow a saved investigation’s Run history to read the results, inspect the evidence and review gaps.',
    'Campaign research evaluates available source records. Model-assisted research is unavailable. Raising the model-call limit or connecting a ChatGPT account does not enable it.',
  ] },
  { title: 'Check sources and interpret the coverage period', page: 'Sources', scope: 'sources:read', paragraphs: [
    'Review the source’s qualification and geographic coverage before choosing it for a campaign. A qualified source can still lack the requested field or period. A synthetic fixture supplies repeatable examples and cannot establish live coverage.',
    'Overview counts distinct permits and source observations supported by eligible evidence retrieved in the last 30 days from sources explicitly marked live. Retrieval time can differ from an event date. One permit can contribute to multiple source rows.',
    'The operator can inspect a bounded publisher download before registering eligible local input. Keep raw publisher responses private. When a publisher blocks access or free limits expire, retain the gap and check the source before retrying.',
  ] },
  { title: 'Create and verify a CSV export', page: 'Exports', scope: 'exports:read', paragraphs: [
    'From a completed or partial run, an authorized analyst can choose Create CSV. Check the row count, expiration and SHA-256 checksum, then Download CSV. Match the exported evidence reference to the same run’s field evidence.',
    'Keep the file private. Source eligibility, permissions and suppression also apply at download. A changed policy or expired export may require a fresh CSV. Viewer accounts receive contact-stripped evidence. Only eligible, unsuppressed and verified public business channels can be disclosed to an authorized analyst.',
  ] },
  { title: 'Connect ChatGPT from the server or over SSH', page: 'Settings', paragraphs: [
    'The designated owner opens Settings and chooses Continue with ChatGPT. From a browser on the miniserver, select the local-browser option if prompted. From another computer, copy the SSH tunnel command shown in Settings into a terminal on that computer. Use your SSH login and leave the terminal open. A quiet terminal is expected.',
    'Choose Tunnel ready, continue. Complete provider sign-in in the same browser, review plan permissions and return to Settings. Choose a supported model and effort, then Save preferences. Review plan limits before enabling use for repair briefs.',
    'If the callback is refused, check the forwarded port and SSH host. Close your own conflicting tunnel or reuse the correct one. Start fresh in Settings and discard stale callback URLs. After an expired first registration, choose Retry new registration. Keep tokens and callback links private.',
  ] },
  { title: 'Recover a failed, partial or waiting run', page: 'Issues', scope: 'issues:read', paragraphs: [
    'Open the run and read its stop reason, task counts, unavailable fields and coverage gaps. A partial run can retain usable evidence. A failed retrieval cannot establish a sale, disappearance or change in ownership.',
    'Check Issues and the affected source. After resolving an eligible failure, use Retry failed tasks when offered. Reopen the same run to check progress. For a changed draft or eligibility warning, reload the saved campaign and preview coverage again.',
    'If the workspace goes offline, reconnect to the private network and select Try again. For a persistent failure, give the operator the safe error code, request ID and time. For suspected data loss, preserve the current database and evidence volume. The operator should verify restored database, artifacts and separately held encryption keys in an isolated environment before switching the workspace.',
  ] },
]

export function WorkspaceHelp({ session }: { session: Session }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const matches = topics.filter(topic => [topic.title, ...topic.paragraphs].join(' ').toLowerCase().includes(query))
  return <div className="page analyst-page"><h1>Help</h1>
    <label className="help-search">Search help<input type="search" value={search}
      onChange={event => setSearch(event.target.value)} placeholder="Try provenance, SSH or schedules" /></label>
    <p role="status" className="muted">{matches.length} {matches.length === 1 ? 'topic' : 'topics'}{query ? ' found' : ''}</p>
    {!matches.length && <p>Try a shorter phrase or clear the search to see every topic.</p>}
    {matches.map(topic => <details className="help-topic" key={topic.title + Boolean(query)} open={query ? true : undefined}>
      <summary>{topic.title}</summary>{topic.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      {topic.page && (topic.scope ? can(session, topic.scope) : session.chatgptSettings) &&
        <p><Link className="text-link" to={'/' + topic.page.toLowerCase()}>Open {topic.page}</Link></p>}
    </details>)}
  </div>
}
