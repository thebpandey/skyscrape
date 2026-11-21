import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import type { SourceEntry, IssueRegister, ExportRegister } from '../../../../packages/db/src/operational-types'
import { Loading, Message, Problem } from '../components/states'
import { ApiError, campaignData, campaignWrite, can, downloadRunCsv, request } from '../lib/api'
import type { Session } from '../lib/api'
import { fieldName } from './campaigns'
import './operational-pages.css'

type Page = 'sources' | 'issues' | 'exports'
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function useRegister<T>(page: Page) {
  return useQuery({ queryKey: ['operational', page], queryFn: ({ signal }) => campaignData<T>(page, { signal }) })
}

function SourcesPage() {
  const sources = useRegister<SourceEntry[]>('sources')
  if (sources.isError) return <Problem resource="source registry" error={sources.error} retry={() => void sources.refetch()} />
  if (!sources.data) return <Loading>Loading source assessments…</Loading>
  if (!sources.data.length) return <Message title="No qualified sources">Sources appear here when a current assessment permits access.</Message>
  return <section><h2>Qualified sources</h2><ul className="ops-list">{sources.data.map(item =>
    <li key={item.id}><details><summary><strong>{item.name}</strong><span>{item.synthetic ? 'Synthetic · ' : ''}Version {item.version}</span></summary>
      <p>{item.coverage ?? 'Coverage has not been recorded.'}</p><dl className="metadata">
        <div><dt>Qualification</dt><dd>{fieldName(item.eligibility)}</dd></div>
        <div><dt>Retrieval method</dt><dd>{fieldName(item.method)}</dd></div>
        <div><dt>Assessment</dt><dd>{item.assessment ?? 'Unspecified'}</dd></div>
        <div><dt>Version recorded</dt><dd>{date(item.assessedAt)}</dd></div>
        <div><dt>County FIPS</dt><dd>{item.counties.join(', ') || 'Unspecified'}</dd></div>
        <div><dt>Approved fields</dt><dd>{item.fields.join(', ') || 'Unspecified'}</dd></div>
      </dl></details></li>)}</ul></section>
}

const nextActions: Record<string, string> = {
  SOURCE_POLICY_CHANGED: 'Review the current source assessment before starting a new run.',
  POLICY_BLOCKED: 'Review the current source assessment before starting a new run.',
  AUTH_REQUIRED: 'Have an operator review the source authorization.',
  CHALLENGE_REQUIRED: 'Have an operator inspect the source access challenge.',
  RATE_LIMITED: 'Wait for the source retry interval before resuming.',
  FREE_QUOTA_EXHAUSTED: 'Wait for free quota to reset or narrow the campaign.',
  BUDGET_EXHAUSTED: 'Narrow the geography, date range or result limit for the next run.',
  UNQUERIED_COUNTIES: 'Compare the campaign geography with the qualified counties on Sources.',
  UNSUPPORTED_FIELDS: 'Review unsupported fields in the run and update the campaign.',
  RESULT_LIMIT: 'Review accepted results or narrow the next run to a smaller window.',
}

async function saveBrief(issuePath: string, signal: AbortSignal) {
  const response = await request('/api/v1/issues/' + issuePath + '/repair-brief', { method: 'POST', signal })
  if (!response.headers.get('Content-Type')?.startsWith('text/markdown')) throw Error('Expected Markdown')
  const blob = await response.blob()
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'repair-brief.md'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function IssuesPage({ session }: { session: Session }) {
  const issues = useRegister<IssueRegister>('issues')
  const brief = useMutation({ mutationFn: (id: string) => saveBrief(id, session.verified) })
  if (issues.isError) return <Problem resource="issues" error={issues.error} retry={() => void issues.refetch()} />
  if (!issues.data) return <Loading>Loading issues and run activity…</Loading>
  const { runs, incidents } = issues.data
  return <><section><h2>Source incidents</h2>{incidents.length
    ? <ul className="ops-list">{incidents.map(item => <li key={item.id}><strong>{item.source}</strong>
      <p>{item.synthetic ? 'Synthetic · ' : ''}Version {item.version} · {fieldName(item.state)}</p>
      <details><summary>Incident details</summary><p>Review the current assessment in Sources and reproduce the failure on a permitted fixture.</p>
        <p>{item.briefCount} stored repair briefs · Incident <code>{item.id}</code></p>
        {can(session, 'issues:triage') && <button className="button" type="button" disabled={brief.isPending}
          onClick={() => brief.mutate(item.id)}>Download repair brief</button>}</details></li>)}</ul>
    : <p className="muted">No incidents recorded for current qualified sources.</p>}</section>
    {can(session, 'runs:read') && <section><h2>Run activity</h2><p className="muted">Active, failed and partial runs from the latest 100 matching runs.</p>
      {runs.length ? <ul className="ops-list">{runs.map(run => {
        const actionable = ['failed','partial','waiting_user','retry_wait'].includes(run.state)
        return <li key={run.id}><strong><Link to={'/runs/' + run.id}>{run.title}</Link></strong>
          <p>{fieldName(run.state)} · {date(run.createdAt)}{run.synthetic && ' · Synthetic'}</p>
          {run.code && <code>{run.code}</code>}{actionable && <p>{nextActions[run.code ?? ''] ??
            'Inspect the task status and coverage gaps in the run before retrying.'}</p>}
          <div className="ops-actions"><Link className="button" to={'/runs/' + run.id}>Inspect run</Link>
            {actionable && can(session, 'issues:triage') && <button className="button" type="button" disabled={brief.isPending}
              onClick={() => brief.mutate('runs/' + run.id)}>Download repair brief</button>}</div></li>
      })}</ul> : <Message title="No runs need attention">Active runs and runs with incomplete results appear here.</Message>}
      </section>}{brief.isError && <Problem resource="repair brief" error={brief.error} />}</>
}

function ExportsPage({ session }: { session: Session }) {
  const list = useRegister<ExportRegister>('exports')
  const [selected, setSelected] = useState('')
  const create = useMutation({ mutationFn: (id: string) =>
    campaignWrite<{ id: string; rowCount: number }>('runs/' + id + '/exports', {}, 'POST', undefined, session.verified),
    onSuccess: () => list.refetch() })
  const download = useMutation({ mutationFn: (id: string) => downloadRunCsv(id, session.verified) })
  if (list.isError) return <Problem resource="export history" error={list.error} retry={() => void list.refetch()} />
  if (!list.data) return <Loading>Loading export history…</Loading>
  const { runs, history } = list.data
  const error = download.error
  const stale = error instanceof ApiError && [403,404,409].includes(error.status)
  return <>{can(session, 'exports:create') && <section><h2>Create a CSV</h2>
    {runs.length ? <form className="ops-form" onSubmit={event => { event.preventDefault(); download.reset(); create.mutate(selected) }}>
      <label htmlFor="export-run">Completed or partial run</label><select id="export-run" required value={selected}
        onChange={event => setSelected(event.target.value)}><option value="">Choose a run</option>
        {runs.map(run => <option key={run.id} value={run.id}>{run.title} · {fieldName(run.state)} · {date(run.createdAt)}{run.synthetic && ' · Synthetic'}</option>)}</select>
      <button className="button" disabled={!selected || create.isPending} type="submit">{create.isPending ? 'Creating CSV…' : 'Create CSV'}</button>
    </form> : <p className="muted">Complete a campaign run to create an export.</p>}
    {create.isError && <Problem resource="CSV export" error={create.error} />}
    {create.isSuccess && <p role="status">CSV created with {create.data.rowCount} rows.</p>}</section>}
    <section><div className="ops-actions"><h2>Export history</h2><button className="button" type="button" disabled={list.isFetching}
      onClick={() => { download.reset(); void list.refetch() }}>Refresh history</button></div>{history.length ? <><p className="muted">Your latest 100 exports. Each download checks current access and source eligibility.</p>
      <ul className="ops-list">{history.map(entry => <li key={entry.id}><strong><Link to={'/runs/' + entry.runId}>{entry.title}</Link></strong>
        <p>{entry.rowCount ?? 'Unknown'} rows · {entry.expired ? 'Expired' : 'Expires'} {date(entry.expiresAt)}</p>
        {entry.sha256 && <details><summary>SHA-256 checksum</summary><code className="checksum">{entry.sha256}</code></details>}
        {!entry.expired && <button className="button" type="button" disabled={download.isPending} onClick={() => download.mutate(entry.id)}>Download CSV</button>}
        {download.variables === entry.id && download.isError && (stale
          ? <p role="alert">{error.code === 'EXPORT_CHANGED' ? 'Eligible results changed. Create a fresh CSV for this run.' :
            'This export expired or access changed. Refresh the history to check availability.'}</p>
          : <Problem resource="CSV download" error={error} />)}
      </li>)}</ul></> : <Message title="No exports yet">CSV snapshots you create appear here with their row count, checksum and expiration.</Message>}</section></>
}

export function OperationalPage({ page, session }: { page: Page; session: Session }) {
  return <div className="page operational-page"><header><h1>{fieldName(page)}</h1>
    <p className="muted">{page === 'sources' ? 'Inspect source coverage and the fields approved for collection.'
      : page === 'issues' ? 'Review collection failures and follow up on incomplete runs.'
      : 'Create and download a CSV snapshot of authorized campaign results.'}</p></header>
    {!can(session, ({ sources: 'sources:read', issues: 'issues:read', exports: 'exports:read' } as const)[page])
      ? <Problem resource={page} error={new ApiError(403)} />
      : page === 'sources' ? <SourcesPage /> : page === 'issues' ? <IssuesPage session={session} /> : <ExportsPage session={session} />}
  </div>
}
