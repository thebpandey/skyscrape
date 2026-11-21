import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { campaignDraft } from '../../../../packages/contracts/src/index'
import type { CampaignDraft, CampaignTiming } from '../../../../packages/contracts/src/index'
import { TemplateIcon } from '../components/template-icon'
import { Loading, Message, Problem } from '../components/states'
import { ApiError, campaignData, campaignPage, campaignWrite, can, isResourceId } from '../lib/api'
import type { Session } from '../lib/api'

type Setting = { kind: 'integer'; min: number; max: number; default: number }
  | { kind: 'choice'; options: string[]; default: string }
  | { kind: 'text'; maxLength: number; default: string }
type Template = { id: string; title: string; aliases: string[]; settings: Record<string, Setting> }
type Draft = CampaignDraft & { criteria?: Record<string, string | number> }
type Saved = { id: string; version: number; state: string; nextDueAt?: string }
type Preview = {
  activationEligible?: boolean; asOf: string; criteria: Record<string, string | number>
  sample: { fields: Record<string, string | number | boolean | null>; evidenceIds: string[] }[]
  sources: { id: string; name: string; coverage: string; synthetic: boolean }[]
  coveredCountyFips: string[]; coverageGaps: string[]; unsupportedFields: string[]; limits: CampaignDraft['limits']
  occurrences: { local: string; utc: string; timezone: string }[]; llmConfigured: boolean
}

const descriptions: Record<string, string> = {
  land_buyer_discovery: 'Find buyers with documented land acquisitions.',
  builder_activity: 'Track builders and their roles in permitted projects.',
  institutional_sfr_acquisition_research: 'Review single-family acquisitions by institutional buyers.',
  permit_monitoring: 'Follow permit filings, status changes and issue dates.',
  ownership_transfer_lookup: 'Trace dated ownership and transfers for a parcel.',
  land_sfr_listing_watch: 'Follow listing episodes and changes in asking price.',
  market_snapshot: 'Compare activity within a market and reporting window.',
  contact_enrichment: 'Review evidence for verified public business channels.',
  source_gap_investigation: 'Identify missing evidence for a selected record type.',
  custom_research: 'Investigate a subject using a bounded set of records.',
}

const requestedFields: Record<string, string> = {
  land_buyer_discovery: 'buyerId, acquisitionCount, lastAcquisition, criteriaBasis',
  builder_activity: 'participantId, role, permitCount, linkedProjectCount',
  institutional_sfr_acquisition_research: 'buyerId, buyerTypes, acquisitionCount, lastAcquisition',
  permit_monitoring: 'permitNumber, jurisdiction, rawStatus, status',
  ownership_transfer_lookup: 'apn, ownerId, basis, instrumentId, granteeId',
  land_sfr_listing_watch: 'listingId, status, priceType, amount, currency',
  market_snapshot: 'countyFips, asset, sampleSize, active, pending, sold',
  contact_enrichment: 'organizationId, role, channel, checkedOn',
  source_gap_investigation: 'countyFips, requiredKind, observedRecords, observedSources',
  custom_research: 'subjectId, recordKind, countyFips, acceptance',
}

export function fieldName(key: string) {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function settingLabel(key: string) {
  if (key === 'windowDays') return 'Lookback (days)'
  if (key === 'maxResults') return 'Maximum results'
  return fieldName(key)
}

export function Campaigns({ session }: { session: Session }) {
  const [params] = useSearchParams()
  const id = params.get('draft')
  const templateId = params.get('template')
  const write = can(session, 'campaigns:write')
  // Keep the editor mounted across Activity suspension. The private client clears on sign-out.
  const catalog = useQuery({ queryKey: ['campaign-templates'], gcTime: Infinity, enabled: write,
    queryFn: ({ signal }) => campaignData<Template[]>('campaigns/templates', { signal }) })
  const saved = useQuery<Saved & { draft: Draft }>({ queryKey: ['campaign', id], gcTime: Infinity, enabled: write && isResourceId(id),
    refetchInterval: query => query.state.data?.state === 'active' && query.state.data.draft.timing?.mode === 'once' ? 5000 : false,
    queryFn: ({ signal }) => campaignData<Saved & { draft: Draft }>('campaigns/' + id, { signal }) })
  if (id && !isResourceId(id)) return <Problem resource="draft" error={new ApiError(400)} />
  if (!write) return <div className="page"><h1>Campaigns</h1>
    {id && can(session, 'runs:read') ? <RunHistory id={id} /> : <Message title="Read-only access">
      An analyst can configure campaigns. Open a saved campaign to inspect its runs.</Message>}
    {!id && <SavedCampaigns />}
  </div>
  const failures = [catalog, ...(id ? [saved] : [])].filter(query => query.isError)
  const blocking = failures.find(({ data, error }) => !data ||
    !(error instanceof TypeError || (error instanceof ApiError && error.status >= 500)))
  const failed = blocking ?? failures[0]
  const problem = failed && <Problem resource="campaigns" error={failed.error} retry={() => void failed.refetch()} />
  if (blocking) return problem
  if (!catalog.data || (id && !saved.data)) return <Loading>Loading campaigns…</Loading>
  const selected = id ? saved.data?.draft.template : templateId
  if (selected) {
    const template = catalog.data.find(item => item.id === selected || item.aliases.includes(selected))
    if (!template) return <Message title="Template unavailable"><Link to="/campaigns">Return to campaigns</Link></Message>
    return <>{problem}<Editor key={id ? [id, saved.data?.version, saved.data?.state].join('/') : template.id}
      template={template} saved={id ? saved.data : undefined} session={session} /></>
  }
  if (problem) return problem
  return <div className="page campaign-page"><h1>Campaigns</h1><SavedCampaigns /><div className="catalog-heading"><h2 id="template-heading">Choose a template</h2><span>{catalog.data.length} templates</span></div>
    <nav className="template-catalog" aria-labelledby="template-heading">{catalog.data.map(template =>
      <Link key={template.id} to={'/campaigns?template=' + encodeURIComponent(template.id)}>
        <TemplateIcon template={template.id} /><ArrowUpRight className="template-arrow" size={17} aria-hidden="true" />
        <strong>{template.title}</strong><span className="template-description">{descriptions[template.id]}</span>
      </Link>)}</nav>
  </div>
}

function SavedCampaigns() {
  const campaigns = useInfiniteQuery({ queryKey: ['campaigns'], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => campaignPage<(Saved & { title: string })[]>(
      'campaigns' + (pageParam ? '?after=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: page => page.meta.nextCursor,
  })
  const rows = campaigns.data?.pages.flatMap(page => page.data)
  return <section aria-label="Saved campaigns"><h2>Saved campaigns</h2>
    {campaigns.isError ? <Problem resource="saved campaigns" error={campaigns.error} retry={() => void campaigns.refetch()} />
      : !rows ? <Loading>Loading saved campaigns…</Loading>
      : rows.length ? <ul>{rows.map(campaign => <li key={campaign.id}>
        <Link to={'/campaigns?draft=' + campaign.id}>{campaign.title}</Link> · {fieldName(campaign.state)}
      </li>)}</ul> : <p>No saved campaigns.</p>}
    {campaigns.hasNextPage && <button className="button" disabled={campaigns.isFetchingNextPage}
      onClick={() => void campaigns.fetchNextPage()}>More campaigns</button>}
  </section>
}

type TimingChoice = 'instant' | 'once' | 'daily' | 'weekly' | 'monthly' | 'cron'
function readTiming(data: FormData, mode: TimingChoice): CampaignTiming {
  const timezone = String(data.get('timezone'))
  const localTime = String(data.get('localTime'))
  switch (mode) {
    case 'instant': return { mode }
    case 'once': return { mode, timezone, scheduledFor: new Date(String(data.get('scheduledFor')) + 'Z').toISOString() }
    case 'cron': return { mode: 'recurring', timezone, frequency: mode, cron: String(data.get('cron')) }
    case 'daily': return { mode: 'recurring', timezone, frequency: mode, localTime }
    case 'weekly': return { mode: 'recurring', timezone, frequency: mode, localTime,
      weekdays: data.getAll('weekdays').map(Number) }
    case 'monthly': return { mode: 'recurring', timezone, frequency: mode, localTime, dayOfMonth: Number(data.get('dayOfMonth')) }
  }
}

function Timing({ mode, setMode, initial, disabled }: {
  mode: TimingChoice; setMode: (mode: TimingChoice) => void; initial?: CampaignTiming; disabled: boolean
}) {
  return <fieldset disabled={disabled}><legend>Timing</legend><div className="campaign-grid">
    <label>Frequency<select value={mode} onChange={e => setMode(e.target.value as TimingChoice)}>
      {['instant', 'once', 'daily', 'weekly', 'monthly', 'cron'].map(value =>
        <option key={value} value={value}>{value === 'instant' ? 'Run now' : fieldName(value)}</option>)}</select></label>
    {mode !== 'instant' && <label>Time zone<input name="timezone" required maxLength={80}
      defaultValue={initial && initial.mode !== 'instant' ? initial.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>}
    {mode === 'once' && <label>Start date and time (UTC)<input type="datetime-local" name="scheduledFor" required
      defaultValue={initial?.mode === 'once' ? new Date(initial.scheduledFor).toISOString().slice(0, 16) : ''} /></label>}
    {['daily', 'weekly', 'monthly'].includes(mode) && <label>Local time<input type="time" name="localTime" required
      defaultValue={initial && 'localTime' in initial ? initial.localTime : '08:00'} /></label>}
    {mode === 'weekly' && <label>Weekdays<select multiple name="weekdays" required
      defaultValue={initial && 'weekdays' in initial ? initial.weekdays.map(String) : ['1']}>
      {['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day,i) =>
        <option key={day} value={i + 1}>{day}</option>)}</select></label>}
    {mode === 'monthly' && <label>Day of month<input name="dayOfMonth" type="number" required min="1" max="31"
      defaultValue={initial && 'dayOfMonth' in initial ? initial.dayOfMonth : 1} /></label>}
    {mode === 'cron' && <label>Cron expression<input name="cron" required maxLength={128}
      defaultValue={initial && 'cron' in initial ? initial.cron : ''} placeholder="0 8 * * 1" /></label>}
  </div></fieldset>
}

function Editor({ template, saved, session }: { template: Template; saved?: Saved & { draft: Draft }; session: Session }) {
  const draft = saved?.draft
  const timing = draft?.timing
  const [mode, setMode] = useState<TimingChoice>(timing?.mode === 'recurring' ? timing.frequency : timing?.mode ?? 'instant')
  const active = saved?.state === 'active'
  const [dirty, setDirty] = useState(!saved)
  const [preview, setPreview] = useState<(Preview & { version?: number })>()
  const activationEligible = preview?.activationEligible ?? Boolean(preview?.sources.length)
  const [destination, setDestination] = useState('')
  const [invalid, setInvalid] = useState('')
  const creation = useRef<{ key: string; body: Draft } | null>(null)
  const runKey = useRef('')
  const navigate = useNavigate()
  const client = useQueryClient()
  useEffect(() => {
    const clearPreview = () => setPreview(undefined)
    session.verified.addEventListener('abort', clearPreview, { once: true })
    return () => session.verified.removeEventListener('abort', clearPreview)
  }, [session.verified])
  const mutation = useMutation({ mutationFn: async ({ action, body }: { action: string; body: Draft }) => {
    if (action === 'pause' && saved && active) {
      const { state } = await campaignWrite<{ state: string }>('campaigns/' + saved.id + '/pause', {})
      return { saved: { ...saved, state, nextDueAt: undefined } }
    }
    if (active) throw Error('Pause this schedule before editing')
    if (action === 'preview') {
      const signal = session.verified
      try {
        const data = await campaignWrite<Preview>('campaigns/preview', body, 'POST', undefined, signal)
        if (!signal.aborted) setPreview({ ...data, version: dirty ? undefined : saved?.version })
      } catch (error) {
        if (!signal.aborted) throw error
      }
      return {}
    }
    if (action === 'save') {
      let target: Saved | undefined = saved
      if (!target) {
        const attempt = creation.current ??= { key: crypto.randomUUID(), body }
        try {
          target = await campaignWrite<Saved>('campaigns', attempt.body, 'POST', attempt.key)
        } catch (error) {
          if (error instanceof ApiError && error.status === 400) creation.current = null
          throw error
        }
        if (JSON.stringify(attempt.body) === JSON.stringify(body)) return { saved: target }
        // A recovered create needs a separate authorized update for subsequent edits.
        session.verified.throwIfAborted()
      }
      return { saved: await campaignWrite<Saved>('campaigns/' + target.id, { version: target.version, draft: body }, 'PATCH') }
    }
    if (!saved || dirty || !activationEligible || preview?.version !== saved.version || session.verified.aborted) throw Error('Preview a saved draft first')
    if (mode !== 'instant') return { schedule: await campaignWrite<{ nextDueAt: string; version: number; state: string }>(
      'campaigns/' + saved.id + '/schedule', { version: preview.version, timing: body.timing }) }
    runKey.current ||= crypto.randomUUID()
    return { run: await campaignWrite<{ runId: string }>('campaigns/' + saved.id + '/runs',
      { version: preview.version }, 'POST', runKey.current) }
  }, onSuccess(result, { body }) {
    if (result.saved) {
      client.setQueryData(['campaign', result.saved.id], { ...result.saved, draft: body })
      setDirty(false)
      if (!saved) setDestination('/campaigns?draft=' + result.saved.id)
    }
    if (result.run) setDestination('/runs/' + result.run.runId)
    if (result.schedule && saved) {
      client.setQueryData(['campaign', saved.id], { ...saved, version: result.schedule.version,
        nextDueAt: result.schedule.nextDueAt, state: result.schedule.state, draft: body })
    }
  }, onError(error) {
    if (error instanceof ApiError && error.status === 409) setPreview(undefined)
  } })
  // Activity restores effects only when this same session is verified again.
  useEffect(() => {
    if (destination) void navigate(destination, { replace: destination.startsWith('/campaigns') })
  }, [destination, navigate])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutation.isPending || active) return
    const action = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value || 'preview'
    const data = new FormData(event.currentTarget)
    const split = (key: string) => String(data.get(key) ?? '').split(',').map(v => v.trim()).filter(Boolean)
    setInvalid('')
    const criteria = Object.fromEntries(Object.entries(template.settings).map(([key, spec]) =>
      [key, spec.kind === 'integer' ? Number(data.get('setting-' + key)) : String(data.get('setting-' + key))]))
    const parsed = campaignDraft.safeParse({
      title: data.get('title'), objective: data.get('objective') || undefined, template: template.id,
      geography: { countyFips: split('counties') }, assetTypes: split('assets'), requestedFields: split('fields'),
      limits: { maxPages: Number(data.get('pages')), maxMinutes: Number(data.get('minutes')), maxLlmCalls: Number(data.get('calls')) },
      timing: readTiming(data, mode), sourcePolicy: { freeOnly: true, allowHostedFreeTiers: draft?.sourcePolicy.allowHostedFreeTiers ?? false },
    })
    if (!parsed.success) { setInvalid('Check ' + parsed.error.issues.map(issue => issue.path.join(' / ')).join(', ') + '.'); return }
    const body = { ...parsed.data, criteria }
    mutation.mutate({ action, body })
  }
  const allowed = can(session, mode === 'instant' ? 'runs:create' : 'schedules:write')
  return <div className="page campaign-page">
    <Link to="/campaigns" className="text-link">Campaign templates</Link>
    <h1 className="template-title"><TemplateIcon template={template.id} />{template.title}</h1>
    <p className="muted">{descriptions[template.id]}</p>
    {active && <section className="campaign-preview">
      <p role="status">Schedule active. Pause it to edit the campaign.{saved.nextDueAt && ' Next run ' + saved.nextDueAt + ' UTC.'}</p>
      {can(session, 'schedules:write') && <button className="button" disabled={mutation.isPending}
        onClick={() => mutation.mutate({ action: 'pause', body: saved.draft })}>Pause schedule</button>}
    </section>}
    <form className="campaign-form" onSubmit={submit} onChange={() => {
      setDirty(true); setPreview(undefined); setInvalid(''); mutation.reset()
    }}>
      <fieldset disabled={active || mutation.isPending}><legend>Campaign draft</legend><div className="campaign-grid">
        <label>Title<input name="title" required maxLength={256} defaultValue={draft?.title ?? template.title} /></label>
        <label>Objective<input name="objective" maxLength={256} defaultValue={draft?.objective} /></label>
        <label>County FIPS codes<input name="counties" required placeholder="Five digits per county, comma-separated"
          defaultValue={draft?.geography.countyFips.join(', ')} /></label>
        <label>Asset types<input name="assets" placeholder="Comma-separated types" defaultValue={draft?.assetTypes.join(', ')} /></label>
        <label>Requested fields<input name="fields" required defaultValue={draft?.requestedFields.join(', ') ??
          requestedFields[template.id]} /></label>
      </div></fieldset>
      <fieldset disabled={active || mutation.isPending}><legend>Template settings</legend>
        {template.id === 'permit_monitoring' && <p className="muted">For Seattle permits, enter King County (53033) and leave asset types blank. A qualified city feed covers Seattle only. Austin county searches require records with verified county attribution.</p>}
        <div className="campaign-grid">
        {Object.entries(template.settings).map(([key, setting]) => <label key={key}>{settingLabel(key)}
          {setting.kind === 'choice' ? <select name={'setting-' + key} defaultValue={draft?.criteria?.[key] ?? setting.default}>
            {setting.options.map(value => <option key={value} value={value}>{fieldName(value)}</option>)}</select>
            : <input name={'setting-' + key} type={setting.kind === 'integer' ? 'number' : 'text'}
              {...(setting.kind === 'integer' ? { min: setting.min, max: setting.max, required: true } : { maxLength: setting.maxLength })}
              defaultValue={draft?.criteria?.[key] ?? setting.default} />}
        </label>)}</div></fieldset>
      <fieldset disabled={active || mutation.isPending}><legend>Work limits</legend><div className="campaign-grid">
        <label>Maximum pages<input name="pages" type="number" min="1" max="10000" required defaultValue={draft?.limits.maxPages ?? 5} /></label>
        <label>Maximum minutes<input name="minutes" type="number" min="1" max="1440" required defaultValue={draft?.limits.maxMinutes ?? 10} /></label>
        <label>Maximum model calls<input name="calls" type="number" min="0" max="10000" required defaultValue={draft?.limits.maxLlmCalls ?? 0} /></label>
      </div><p className="muted">Only eligible, free sources can be used.</p></fieldset>
      <Timing mode={mode} setMode={setMode} initial={timing} disabled={active || mutation.isPending} />
      {invalid && <p role="alert">{invalid}</p>}
      {mutation.isError && (mutation.error instanceof ApiError && mutation.error.status === 409
        ? mutation.error.code === 'NO_QUALIFIED_SOURCE'
          ? <p role="alert">Source eligibility changed. Preview coverage again to see which sources qualify.</p>
          : <p role="alert">The saved campaign changed. Reload the draft before saving or activating it again.</p>
        : <Problem resource="campaign action" error={mutation.error} />)}
      <div className="campaign-actions"><button className="button" value="save" disabled={active || mutation.isPending || !dirty}>Save draft</button>
        <button className="button primary" value="preview" disabled={active || mutation.isPending}>Preview coverage</button>
        {saved && <Link className="text-link" to={'/campaigns?draft=' + saved.id}>Saved draft · v{saved.version}</Link>}
      </div>
      {preview && <section className="campaign-preview" aria-label="Coverage preview"><h2>Coverage preview</h2>
        {preview.sources.length ? <ul>{preview.sources.map(source => <li key={source.id}><strong>{source.name}</strong>
          {source.synthetic && ' · Synthetic fixture'}<p>{source.coverage}</p></li>)}</ul>
          : <p>No eligible sources for this template and geography.</p>}
        <p>Counties with eligible source coverage · {preview.coveredCountyFips.join(', ') || 'None confirmed'}</p>
        <ul>{preview.coverageGaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        <h3>Stored sample</h3>
        <p>As of {preview.asOf} UTC · {Object.entries(preview.criteria).map(([key, value]) =>
          settingLabel(key) + ' ' + (value === '' ? 'Any' : value)).join(' · ')}</p>
        {preview.sample.length ? <ul>{preview.sample.map((row, i) => <li key={i}>
          <dl className="metadata">{Object.entries(row.fields).map(([key, value]) =>
            <div key={key}><dt>{fieldName(key)}</dt><dd>{String(value ?? 'Unknown')}</dd></div>)}
            <div><dt>Evidence IDs</dt><dd>{row.evidenceIds.join(', ') || 'Unavailable'}</dd></div>
          </dl></li>)}</ul> : <p>No matching stored sample is available.</p>}
        <p>Unavailable fields · {preview.unsupportedFields.join(', ') || 'None reported'}</p>
        <p>Maximum work · {preview.limits.maxPages} pages · {preview.limits.maxMinutes} minutes · {preview.limits.maxLlmCalls} model calls</p>
        {!preview.llmConfigured && <p>Model research is unavailable.</p>}
        {mode !== 'instant' && <><h3>Upcoming occurrences</h3><ul>{preview.occurrences.map(o =>
          <li key={o.utc}>{o.local} ({o.timezone}) · {o.utc} UTC</li>)}</ul></>}
        {allowed && activationEligible && (dirty ? <p>Save this draft to activate it.</p> :
          <button className="button primary" value="activate" disabled={mutation.isPending ||
            (mode !== 'instant' && !preview.occurrences.length)}>{mode === 'instant' ? 'Run now' : 'Activate schedule'}</button>)}
      </section>}
    </form>
    {saved && can(session, 'runs:read') && <RunHistory id={saved.id} refreshCampaign={() => void client.invalidateQueries({ queryKey: ['campaign', saved.id] })} />}
  </div>
}

function RunHistory({ id, refreshCampaign }: { id: string; refreshCampaign?: () => void }) {
  const runs = useQuery({ queryKey: ['campaign-runs', id],
    queryFn: ({ signal }) => campaignData<{ id: string; state: string; createdAt: string }[]>(
      'campaigns/' + id + '/runs', { signal }) })
  return <section className="campaign-preview" aria-label="Campaign runs"><h2>Campaign runs</h2>
    <button className="button" disabled={runs.isFetching} onClick={() => { void runs.refetch(); refreshCampaign?.() }}>Refresh runs</button>
    {runs.isError ? <Problem resource="campaign runs" error={runs.error} />
      : !runs.data ? <Loading>Loading runs…</Loading>
      : runs.data.length ? <ul>{runs.data.map(run => <li key={run.id}>
        <Link to={'/runs/' + run.id}>{fieldName(run.state)} · <time dateTime={run.createdAt}>{run.createdAt}</time></Link>
      </li>)}</ul> : <p>No runs yet.</p>}
  </section>
}
