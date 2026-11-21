import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronLeft, ChevronRight, Link2, LockKeyhole, Search, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router'
import { Loading, Message, Problem } from '../components/states'
import { ApiError, can, getObservation, getPermit, getPermits, isResourceId } from '../lib/api'
import type { Observation, Permit, PermitFilters, Session } from '../lib/api'

const narrowEvidence = '(max-width: 899px)'
const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeZone: 'UTC',
})
const timestampFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
})

function formatDate(value: string | null) {
  return value ? dateFormat.format(new Date(value)) : 'Unknown'
}

function formatTimestamp(value: string | null) {
  return value ? timestampFormat.format(new Date(value)) + ' UTC' : 'Unknown'
}

function FieldTrace({ title, raw, accepted }: { title: string; raw: string | null; accepted: string | null }) {
  return <section className="record-field">
    <h3>{title}</h3>
    <dl className="trace">
      <div><dt>Original value</dt><dd className="mono">{raw ?? 'Unknown'}</dd></div>
      <ArrowRight aria-hidden="true" size={17} />
      <div><dt>Accepted value</dt><dd>{accepted ?? 'Unknown'}</dd></div>
    </dl>
  </section>
}

const fieldLabels = new Map([
  ['rawStatus', 'Original status'], ['status', 'Accepted status'],
  ['rawType', 'Original permit type'], ['permitType', 'Accepted permit type'],
  ['appliedOn', 'Application date'], ['issuedOn', 'Issue date'],
  ['jurisdiction', 'Jurisdiction'], ['permitNumber', 'Permit number'],
])

function ObservationDetails({ observation, permitId }: { observation: Observation; permitId: string }) {
  const fields = observation.fields.filter(field => field.recordId === permitId)
  return <div className="observation">
    <dl className="metadata">
      <div><dt>Source</dt><dd>{observation.sourceName}</dd></div>
      <div><dt>Source version</dt><dd>{observation.sourceVersion}</dd></div>
      <div><dt>Source event</dt><dd>{formatDate(observation.eventDate)}</dd></div>
      {observation.sourceModifiedAt && <div><dt>Source modified</dt><dd>{formatTimestamp(observation.sourceModifiedAt)}</dd></div>}
      <div><dt>Retrieved</dt><dd>{formatTimestamp(observation.fetchedAt)}</dd></div>
      <div><dt>Extractor</dt><dd className="mono">{observation.extractorVersion}</dd></div>
      <div><dt>Observation ID</dt><dd className="mono">{observation.id}</dd></div>
    </dl>
    {fields.length > 0 ? <ul className="field-states" aria-label="Field evidence states">
      {fields.map(({ field, relation, acceptance }) => <li key={field + ':' + relation + ':' + acceptance}>
        <span>{fieldLabels.get(field) ?? field}</span>
        <span className="field-state" data-acceptance={acceptance}>{acceptance} · {relation}</span>
      </li>)}
    </ul> : <p className="muted">No field evidence is available for this permit in the observation.</p>}
  </div>
}

function ObservationView({ id, permitId }: { id: string; permitId: string }) {
  const query = useQuery({
    queryKey: ['observation', id],
    queryFn: ({ signal }) => getObservation(id, signal),
  })
  if (query.isPending) return <Loading>Loading the source observation…</Loading>
  if (query.isError) return <Problem resource="source observation" error={query.error} retry={() => void query.refetch()} />
  return <ObservationDetails observation={query.data.data} permitId={permitId} />
}

function EvidenceContent({ permit, session }: { permit: Permit; session: Session }) {
  const [selected, setSelected] = useState(permit.evidenceIds[0])
  const evidenceId = selected && permit.evidenceIds.includes(selected) ? selected : permit.evidenceIds[0]
  return <div className="evidence-body">
    <h3 className="section-label">Record values</h3>
    <FieldTrace title="Permit status" raw={permit.rawStatus} accepted={permit.status} />
    <FieldTrace title="Permit type" raw={permit.rawType} accepted={permit.permitType} />
    <section className="source-section" aria-labelledby="source-title">
      <h3 id="source-title"><Link2 size={17} aria-hidden="true" />Source observation</h3>
      {can(session, 'evidence:read') ? <>
        {permit.evidenceIds.length > 1 && <label className="observation-picker">Observation
          <select value={evidenceId} onChange={event => setSelected(event.target.value)}>
            {permit.evidenceIds.map((id, index) => <option key={id} value={id}>Observation {index + 1}</option>)}
          </select>
        </label>}
        {evidenceId ? <ObservationView id={evidenceId} permitId={permit.id} />
          : <p className="muted">This permit has no available observations.</p>}
      </> : <Problem resource="source observations" error={new ApiError(403)} />}
    </section>
  </div>
}

function EvidencePane({ selectedId, session, onClose, onRestore }: {
  selectedId: string | undefined; session: Session; onClose: () => void; onRestore: () => void
}) {
  const [narrow, setNarrow] = useState(() => matchMedia(narrowEvidence).matches)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const media = matchMedia(narrowEvidence)
    const sync = () => setNarrow(media.matches)
    media.addEventListener('change', sync)
    sync()
    return () => media.removeEventListener('change', sync)
  }, [])
  useEffect(() => {
    if (!narrow && selectedId) title.current?.focus()
  }, [narrow, selectedId])

  const valid = selectedId !== undefined && isResourceId(selectedId)
  const query = useQuery({
    queryKey: ['permit', selectedId],
    queryFn: ({ signal }) => getPermit(selectedId ?? '', signal),
    enabled: valid,
  })
  const permit = !query.isError ? query.data?.data : undefined
  let content
  if (!selectedId) content = <p className="evidence-empty muted">Select a permit to inspect its field evidence.</p>
  else if (!valid) content = <Problem resource="permit" error={new ApiError(400)} />
  else if (query.isError) content = <Problem resource="permit" error={query.error} retry={() => void query.refetch()} />
  else if (permit) content = <EvidenceContent key={permit.id} permit={permit} session={session} />
  else content = <Loading>Loading permit evidence…</Loading>

  const subtitle = permit && <p className="muted"><span className="mono">{permit.permitNumber}</span> · {permit.jurisdiction}</p>
  const footer = <footer className="panel-foot"><LockKeyhole size={14} aria-hidden="true" />Safe evidence · {session.role} access</footer>
  if (narrow) return <Dialog.Root open={Boolean(selectedId)} onOpenChange={open => {
    if (!open) onClose()
  }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-sheet narrow-evidence" onCloseAutoFocus={event => {
        event.preventDefault()
        onRestore()
      }}>
        <header className="dialog-header"><div><Dialog.Title>Field evidence</Dialog.Title>{subtitle}</div>
          <Dialog.Close className="icon-button" aria-label="Close field evidence"><X size={19} aria-hidden="true" /></Dialog.Close>
        </header>
        <Dialog.Description className="sr-only">Review the selected permit and its source observations.</Dialog.Description>
        {content}
        {permit && footer}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>

  return <aside className="panel evidence-pane" aria-labelledby="evidence-title" onKeyDown={event => {
    if (selectedId && event.key === 'Escape') onClose()
  }}>
    <header className="panel-head">
      <div><h2 id="evidence-title" tabIndex={-1} ref={title}>Field evidence</h2>{subtitle}</div>
      {selectedId && <button className="icon-button" type="button" aria-label="Close field evidence" onClick={onClose}>
        <X size={19} aria-hidden="true" />
      </button>}
    </header>
    {content}
    {permit && footer}
  </aside>
}

function FilterForm({ filters, onFilter }: { filters: PermitFilters; onFilter: (filters: PermitFilters) => void }) {
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onFilter({
      permitNumber: String(form.get('permitNumber')).trim() || undefined,
      jurisdiction: String(form.get('jurisdiction')).trim() || undefined,
    })
  }

  return <form className="filter-bar" onSubmit={apply}>
    <label>Permit number
      <input type="search" name="permitNumber" placeholder="Exact permit number" defaultValue={filters.permitNumber} maxLength={256} />
    </label>
    <label>Jurisdiction
      <input type="search" name="jurisdiction" placeholder="Exact jurisdiction" defaultValue={filters.jurisdiction} maxLength={256} />
    </label>
    <button className="button primary" type="submit"><Search size={16} aria-hidden="true" />Find permits</button>
    {(filters.jurisdiction || filters.permitNumber) && <button className="button" type="button"
      onClick={() => onFilter({})}>Clear filters</button>}
  </form>
}

export function Register({ session }: { session: Session }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const match = useMatch('/records/permit/:id')
  const selectedId = match?.params.id
  const lastOpenPermit = useRef<string>(undefined)
  const resultsTitle = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (selectedId) lastOpenPermit.current = selectedId
  }, [selectedId])
  const filters = {
    permitNumber: params.get('permitNumber')?.trim() || undefined,
    jurisdiction: params.get('jurisdiction')?.trim() || undefined,
  }
  const cursor = params.get('cursor') ?? undefined
  const query = useQuery({
    queryKey: ['permits', filters, cursor],
    queryFn: ({ signal }) => getPermits(filters, cursor, signal),
  })
  const list = query.data?.data
  const nextCursor = query.data?.meta.nextCursor

  function restoreFocus() {
    const permitId = lastOpenPermit.current
    requestAnimationFrame(() => {
      const heading = resultsTitle.current
      if (!heading) return
      const rowButton = permitId ? document.getElementById('permit-result-' + permitId) : null
      const destination = rowButton ?? heading
      destination.focus()
    })
  }

  function closeEvidence() {
    void navigate('/records' + location.search, { replace: true })
    restoreFocus()
  }

  function updateFilters(next: PermitFilters, page?: string) {
    const params = new URLSearchParams()
    if (next.permitNumber) params.set('permitNumber', next.permitNumber)
    if (next.jurisdiction) params.set('jurisdiction', next.jurisdiction)
    if (page) params.set('cursor', page)
    const search = params.toString()
    void navigate('/records' + (search ? '?' + search : ''))
  }

  if (location.pathname !== '/records' && location.pathname !== '/records/' && !match) {
    return <div className="page"><h1>Page not found</h1><button className="button" type="button" onClick={closeEvidence}>Return to records</button></div>
  }

  return <div className="page register">
    <header className="page-heading"><h1>Permit Register</h1></header>
    <div className="register-sections"><span aria-current="page">Results</span></div>
    <div className="register-split">
      <section className="panel results-panel" aria-labelledby="results-title">
        <header className="panel-head"><div>
          <h2 id="results-title" ref={resultsTitle} tabIndex={-1}>Accepted permits</h2>
          <p className="muted" role="status">{query.isSuccess
            ? `${list?.length ?? 0} ${list?.length === 1 ? 'record' : 'records'} on this page` : 'Search by exact permit number or jurisdiction.'}</p>
        </div></header>
        <FilterForm key={JSON.stringify(filters)} filters={filters} onFilter={updateFilters} />
        {query.isPending ? <Loading>Loading accepted permits…</Loading>
          : query.isError ? <Problem resource="accepted permits" error={query.error} retry={() => void query.refetch()} />
          : !list?.length ? <Message title="No permits found">{filters.permitNumber || filters.jurisdiction
            ? 'Check the exact permit number or jurisdiction, or clear the filters.'
            : 'No accepted permits are available in this workspace.'}</Message>
          : <div className="table-scroll" role="region" aria-label="Permit results" tabIndex={0}>
            <table className="permit-table">
              <thead><tr><th scope="col">Permit number</th><th scope="col">Issued</th><th scope="col">Permit type</th>
                <th scope="col">Raw status</th><th scope="col">Field evidence</th></tr></thead>
              <tbody>{list.map(permit => <tr key={permit.id} data-selected={selectedId === permit.id || undefined}>
                <th scope="row"><button id={'permit-result-' + permit.id} className="permit-link" type="button"
                  aria-expanded={selectedId === permit.id}
                  onClick={() => void navigate('/records/permit/' + permit.id + location.search)}>
                  <span className="mono">{permit.permitNumber}</span><small>{permit.jurisdiction}</small>
                </button></th>
                <td className="tabular">{formatDate(permit.issuedOn)}</td>
                <td>{permit.permitType ?? 'Unknown'}</td>
                <td className="mono muted">{permit.rawStatus ?? 'Unknown'}</td>
                <td className="evidence-count">{permit.evidenceIds.length
                  ? <><Link2 size={15} aria-hidden="true" />{permit.evidenceIds.length} {permit.evidenceIds.length === 1 ? 'observation' : 'observations'}</>
                  : <span className="muted">No observations</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        {query.isSuccess && (cursor || nextCursor) && <footer className="panel-foot page-controls">
          {cursor && <button className="button" type="button" onClick={() => updateFilters(filters)}>
            <ChevronLeft size={16} aria-hidden="true" />First page</button>}
          {nextCursor && <button className="button" type="button" onClick={() => updateFilters(filters, nextCursor)}>
            Next page<ChevronRight size={16} aria-hidden="true" /></button>}
        </footer>}
      </section>
      <EvidencePane selectedId={selectedId} session={session} onClose={closeEvidence} onRestore={restoreFocus} />
    </div>
  </div>
}
