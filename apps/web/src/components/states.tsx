import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError } from '../lib/api'

export function Loading({ children }: { children: ReactNode }) {
  return <p className="state-card muted" role="status">{children}</p>
}

export function Message({ title, children }: { title: string; children: ReactNode }) {
  return <div className="state-card">
    <h2>{title}</h2><p className="muted">{children}</p>
  </div>
}

export function Problem({ error, resource, retry }: { error: unknown; resource: string; retry?: () => void }) {
  const status = error instanceof ApiError ? error.status : undefined
  const requestId = error instanceof ApiError ? error.requestId : undefined
  const forbidden = status === 403
  const missing = status === 404
  const offline = !navigator.onLine
  const title = forbidden ? 'Access denied' : missing ? 'Unavailable' : offline ? 'You’re offline' : 'Request failed'
  let description = `Couldn’t load ${resource}. Try again.`
  if (forbidden) description = `Your account doesn’t have access to ${resource}.`
  if (missing) description = `The requested ${resource} is unavailable.`
  if (offline) description = `Reconnect to load ${resource}.`
  if (status === 400) description = 'Check the address or filters and try again.'

  return <div className="state-card problem">
    <div role="alert">
      <h2><AlertTriangle size={17} aria-hidden="true" />{title}</h2>
      <p>{description}</p>
      {requestId && <p className="request-id">Request ID <code>{requestId}</code></p>}
    </div>
    {retry && !forbidden && !missing && status !== 400 && <button className="button" type="button" onClick={retry}>Try again</button>}
  </div>
}
