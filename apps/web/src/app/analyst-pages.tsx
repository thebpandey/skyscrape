import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Loading, Message, Problem } from '../components/states'
import { TemplateIcon } from '../components/template-icon'
import { campaignData, campaignPage, can } from '../lib/api'
import type { Session } from '../lib/api'
import '../styles/analyst-pages.css'

type Counts = { permits: number; observations: number }
type Coverage = Counts & { since: string; asOf: string; sources: (Counts & { source: string })[] }
type SavedCampaign = { id: string; title: string; state: string; template: string; version: number }
type RunItem = { id: string; state: string; createdAt: string }

const date = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
}).format(new Date(value))

function CoverageSummary() {
  const query = useQuery({ queryKey: ['permit-coverage'], queryFn: ({ signal }) =>
    campaignData<Coverage>('overview', { signal }) })
  if (query.isError) return <Problem resource="permit coverage" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading permit coverage…</Loading>
  const { permits, observations, sources, since, asOf } = query.data
  return <>
    <p className="muted">Retrieved {date(since)} – {date(asOf)} UTC. Includes accepted evidence from qualified sources marked as live.</p>
    <dl className="coverage-counts">
      <div><dt>Distinct permits</dt><dd>{permits.toLocaleString()}</dd></div>
      <div><dt>Source observations</dt><dd>{observations.toLocaleString()}</dd></div>
      <div><dt>Contributing sources</dt><dd>{sources.length.toLocaleString()}</dd></div>
    </dl>
    {sources.length ? <div className="coverage-table"><table><caption>Coverage by contributing source</caption>
      <thead><tr><th scope="col">Source</th><th scope="col">Permits</th><th scope="col">Observations</th></tr></thead>
      <tbody>{sources.map(row => <tr key={row.source}><th scope="row">{row.source}</th>
        <td>{row.permits.toLocaleString()}</td><td>{row.observations.toLocaleString()}</td></tr>)}</tbody>
    </table></div> : <p>No qualifying permit evidence was retrieved in this period. Activity outside this sample is unknown.</p>}
  </>
}

function CampaignRuns({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['campaign-runs', id],
    queryFn: ({ signal }) => campaignData<RunItem[]>('campaigns/' + id + '/runs', { signal }) })
  if (query.isError) return <Problem resource="campaign runs" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading run history…</Loading>
  if (!query.data.length) return <p>This campaign has no runs yet.</p>
  return <ul className="activity-list">{query.data.map(run => <li key={run.id}>
    <Link to={'/runs/' + run.id}>{run.state.replaceAll('_', ' ')} · <time dateTime={run.createdAt}>{date(run.createdAt)} UTC</time></Link>
  </li>)}</ul>
}

function Activity({ recent }: { recent?: boolean }) {
  const [selected, setSelected] = useState('')
  const limit = recent ? 5 : 25
  const query = useInfiniteQuery({ queryKey: ['workspace-campaign-list', limit], initialPageParam: '',
    queryFn: ({ signal, pageParam }) => campaignPage<SavedCampaign[]>('campaigns?limit=' + limit
      + (pageParam ? '&after=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: page => page.meta.nextCursor })
  if (query.isError) return <Problem resource="saved campaigns" error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return <Loading>Loading saved campaigns…</Loading>
  const campaigns = query.data.pages.flatMap(page => page.data)
  if (!campaigns.length) return <Message title="No saved campaigns">Saved campaigns and their run histories will appear here.</Message>
  return <><ul className="activity-list">{campaigns.map(campaign => <li key={campaign.id}>
    <div className="activity-row"><Link to={'/campaigns?draft=' + campaign.id}>{campaign.title}</Link>
      <span className="muted">{campaign.state} · v{campaign.version}</span>
      <button type="button" className="button" aria-expanded={selected === campaign.id}
        aria-label={'Run history for ' + campaign.title} onClick={() => setSelected(selected === campaign.id ? '' : campaign.id)}>Run history</button></div>
    {selected === campaign.id && <CampaignRuns id={selected} />}
  </li>)}</ul>
    {query.hasNextPage && (recent ? <Link className="text-link" to="/campaigns">View all campaigns</Link>
      : <button className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>More campaigns</button>)}</>
}

export function Overview({ session }: { session: Session }) {
  return <div className="page analyst-page"><h1>Overview</h1>
    <section><h2>Permit coverage</h2><CoverageSummary />
      {can(session, 'records:read') && <Link className="text-link" to="/records">Open permit register <ArrowRight size={15} aria-hidden="true" /></Link>}
    </section>
    {can(session, 'runs:read') && <section><h2>Recently saved campaigns</h2>
      <p className="muted">Up to five of your most recently created campaigns. Open a run to review its progress and findings.</p>
      <Activity recent /></section>}
  </div>
}

const startingPoints = [
  ['custom_research', 'Custom research', 'Choose a record type and subject to investigate.'],
  ['institutional_sfr_acquisition_research', 'Institutional SFR acquisition research', 'Trace documented acquisitions to an institutional buyer.'],
  ['source_gap_investigation', 'Source-gap investigation', 'Check where a county or record type lacks qualifying evidence.'],
] as const

export function Research({ session }: { session: Session }) {
  return <div className="page analyst-page"><h1>Research</h1>
    {can(session, 'campaigns:write') && <section><h2>Start an investigation</h2>
      <p className="muted">Choose a template, narrow the question and preview eligible evidence before running it.</p>
      <nav className="template-catalog" aria-label="Research templates">{startingPoints.map(([id, title, description]) =>
        <Link key={id} to={'/campaigns?template=' + id}><TemplateIcon template={id} />
          <strong>{title}</strong><span className="template-description">{description}</span></Link>)}</nav>
      <Link className="text-link" to="/campaigns">Browse all campaign templates</Link></section>}
    <section><h2>Model availability</h2><p>Research runs use the campaign’s eligible source records. Model-assisted research is unavailable.
      Settings stores the owner’s ChatGPT connection and model preferences.</p></section>
    {can(session, 'runs:read') && <section><h2>Saved investigations and runs</h2>
      <p className="muted">Open a campaign’s run history, then select a run to read its findings, inspect field evidence and review gaps.</p>
      <Activity /></section>}
  </div>
}
