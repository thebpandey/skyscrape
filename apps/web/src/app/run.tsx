import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Loading, Message, Problem } from '../components/states'
import { ApiError, campaignData, campaignWrite, can, downloadRunCsv, isResourceId } from '../lib/api'
import type { Session } from '../lib/api'
import { fieldName } from './campaigns'

type Status = {
  id: string; campaignId: string; campaignVersion: number; state: string; trigger: string
  synthetic: boolean; tasks: Record<string, number>; counters: Record<string, number>
  coverageGaps: string[]; unsupportedFields: string[]; errorCode: string | null
}
type Result = {
  resultId: string; evidenceIds: string[]; recordId: string; classification: string; date: string | null
  fields: Record<string, string | number | boolean | null>
}
type SourceEvidence = {
  id: string; sourceName: string; eventDate: string | null; fetchedAt: string
  sourceUrl: string | null; fieldLocators?: Record<string, string>
  sourceRecordId: string; extractorVersion: string; acceptance: string
}
type Export = { id: string; rowCount: number; sha256: string; expiresAt: string }
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])

function RetryTasks({ id }: { id: string }) {
  const key = useRef('')
  const client = useQueryClient()
  const retry = useMutation({
    mutationFn: () => {
      key.current ||= crypto.randomUUID()
      return campaignWrite<{ runId: string }>('runs/' + id + '/retry', {}, 'POST', key.current)
    },
    onSuccess: async ({ runId }) => {
      key.current = ''
      await client.invalidateQueries({ queryKey: ['run', runId], exact: true })
      await Promise.all([
        client.invalidateQueries({ queryKey: ['run-results', runId] }),
        client.invalidateQueries({ queryKey: ['run-evidence', runId] }),
      ])
    },
  })
  const code = retry.error instanceof ApiError ? retry.error.code : undefined
  const reason = code === 'BUDGET_EXHAUSTED' ? 'This run has no remaining collection budget.'
    : code === 'RUN_NOT_RETRYABLE' ? 'This run has no tasks eligible for retry.' : undefined
  return <><button className="button" disabled={retry.isPending || !!reason} onClick={() => retry.mutate()}>
    Retry failed tasks
  </button>
    {reason ? <p role="alert">{reason}</p> : retry.isError && <Problem resource="task retry" error={retry.error} />}
  </>
}

function Csv({ id, verified }: { id: string; verified: AbortSignal }) {
  const create = useMutation({ mutationFn: () => campaignWrite<Export>('runs/' + id + '/exports', {}) })
  const download = useMutation({ mutationFn: (exportId: string) => downloadRunCsv(exportId, verified) })
  return <section className="campaign-preview"><h2>CSV export</h2>
    {create.data && <><p>{create.data.rowCount} rows · Expires {create.data.expiresAt}</p>
      <p className="checksum">SHA-256 <code>{create.data.sha256}</code></p>
      <button className="button" disabled={download.isPending} onClick={() => download.mutate(create.data.id)}>Download CSV</button>
      {download.isError && download.error.name !== 'AbortError' && <Problem resource="CSV download" error={download.error} />}
    </>}
    <button className="button" disabled={create.isPending || download.isPending}
      onClick={() => { download.reset(); create.mutate() }}>{create.data ? 'Create fresh CSV' : 'Create CSV'}</button>
    {create.isError && <Problem resource="CSV export" error={create.error} />}
  </section>
}

function RunEvidence({ runId, id }: { runId: string; id: string }) {
  const query = useQuery({ queryKey: ['run-evidence', runId, id],
    queryFn: ({ signal }) => campaignData<SourceEvidence>('runs/' + runId + '/evidence/' + encodeURIComponent(id), { signal }) })
  if (query.isError) return <Problem resource="run evidence" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading evidence…</Loading>
  const item = query.data
  return <dl className="metadata">{Object.entries({
    Source: item.sourceName, 'Source record': item.sourceRecordId, 'Event date': item.eventDate,
    Retrieved: item.fetchedAt, Extractor: item.extractorVersion, Acceptance: item.acceptance, 'Evidence ID': item.id,
  }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Unknown'}</dd></div>)}
    <div><dt>Publisher record</dt><dd>{item.sourceUrl?.startsWith('https://')
      ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Open publisher record</a> : 'Unavailable'}</dd></div>
    {Object.entries(item.fieldLocators ?? {}).map(([field, locator]) => <div key={field}>
      <dt>{fieldName(field)} locator</dt><dd>{locator}</dd></div>)}
  </dl>
}

function Results({ id, session }: { id: string; session: Session }) {
  const [selected, setSelected] = useState<string>()
  const evidencePane = useRef<HTMLElement>(null)
  const query = useInfiniteQuery({ queryKey: ['run-results', id], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => campaignData<Result[]>('runs/' + id + '/results?limit=50'
      + (pageParam ? '&after=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: last => last.length === 50 ? last.at(-1)?.resultId : undefined,
  })
  if (query.isError) return <Problem resource="run results" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading run results…</Loading>
  const rows = query.data.pages.flat()
  if (!rows.length) return <Message title="No accepted results">This run returned no eligible evidence for the selected criteria.</Message>
  return <div className="run-results"><section><h2>Results</h2><ul>{rows.map(row =>
    <li key={row.resultId}><h3>{fieldName(row.classification)}</h3><p>{row.date ?? 'Event date unknown'}</p><dl className="metadata">
      {Object.entries(row.fields).map(([name, value]) => <div key={name}><dt>{fieldName(name)}</dt><dd>{String(value ?? 'Unknown')}</dd></div>)}
      </dl>{can(session, 'evidence:read') && row.evidenceIds.map((ref, i) => <button key={ref} className="button"
        onClick={() => { setSelected(ref); evidencePane.current?.focus() }}>Inspect evidence{row.evidenceIds.length > 1 ? ' ' + (i + 1) : ''}</button>)}</li>)}</ul>
    {query.hasNextPage && <button className="button" disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}>More results</button>}
  </section><aside aria-label="Result evidence" ref={evidencePane} tabIndex={-1}><h2>Field evidence</h2>
    {selected && rows.some(row => row.evidenceIds.includes(selected)) ? <RunEvidence runId={id} id={selected} />
      : <p className="muted">Choose a result to inspect its source observation.</p>}</aside></div>
}

export function Run({ session }: { session: Session }) {
  const { id } = useParams()
  const query = useQuery({ queryKey: ['run', id], enabled: isResourceId(id),
    queryFn: ({ signal }) => campaignData<Status>('runs/' + id, { signal }),
    refetchInterval: ({ state }) => state.error || (state.data && terminal.has(state.data.state)) ? false : 2000,
  })
  if (!id || !isResourceId(id)) return <Problem resource="run" error={new ApiError(400)} />
  if (query.isError) return <Problem resource="run" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading run progress…</Loading>
  const run = query.data
  const done = terminal.has(run.state)
  const readResults = can(session, 'records:read') && can(session, 'evidence:read')
  const exportable = run.state === 'completed' || run.state === 'partial'
  return <div className="page campaign-page">
    <Link to="/campaigns" className="text-link">Campaigns</Link><h1>Run detail</h1>
    <p><strong role="status">{fieldName(run.state)}</strong> · Campaign version {run.campaignVersion} · {fieldName(run.trigger)}</p>
    {run.synthetic && <p className="inline-alert">Synthetic source fixture</p>}
    <section className="campaign-preview"><h2>Run progress</h2>
      <dl className="metadata">{Object.entries(run.tasks).map(([state, count]) =>
        <div key={state}><dt>{fieldName(state)} tasks</dt><dd>{count}</dd></div>)}
        {Object.entries(run.counters).map(([key, count]) => <div key={key}><dt>{fieldName(key)}</dt><dd>{count}</dd></div>)}</dl>
      <ul>{run.coverageGaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
      {can(session, 'runs:create') && ['failed', 'partial', 'waiting_user'].includes(run.state)
        && (run.tasks.failed > 0 || run.tasks.waiting_user > 0) && <RetryTasks key={id} id={id} />}
      {run.errorCode && <p>Stop reason · {fieldName(run.errorCode)}</p>}
      {run.unsupportedFields.length > 0 && <p>Unavailable fields · {run.unsupportedFields.join(', ')}</p>}
    </section>
    {done && readResults && <Results key={id} id={id} session={session} />}
    {exportable && readResults && session.role === 'analyst' && can(session, 'exports:create') && can(session, 'exports:read') &&
      <Csv key={id} id={id} verified={session.verified} />}
    <Link className="text-link" to={'/campaigns?draft=' + run.campaignId}>Open saved campaign</Link>
  </div>
}
