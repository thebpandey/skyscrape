import {
  envelopeSchema, errorEnvelope, evidenceProjection, idParams, recordProjection, recordsQuery,
} from '../../../../packages/contracts/src/index'
import type { Role, Scope } from '../../../../packages/security/src/index'

type Parser<T> = { parse: (value: unknown) => T }
const metadata = envelopeSchema(idParams).shape.meta
const records = envelopeSchema(recordProjection.omit({ contacts: true }).strip().array())
const record = envelopeSchema(recordProjection.omit({ contacts: true }).strip())
const evidence = envelopeSchema(evidenceProjection)

export type Permit = ReturnType<typeof record.parse>['data']
export type Observation = ReturnType<typeof evidence.parse>['data']
export type PermitFilters = Pick<ReturnType<typeof recordsQuery.parse>, 'jurisdiction' | 'permitNumber'>
export type Session = {
  id: string
  chatgptSettings?: boolean
  role: Role
  scopes: ReadonlySet<string>
  verified: AbortSignal
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly requestId?: string, readonly code?: string) {
    super('Request failed')
  }
}

export async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
  })
  if (!response.ok) {
    const payload = errorEnvelope.safeParse(await response.json().catch(() => undefined))
    throw new ApiError(response.status, payload.data?.error.requestId, payload.data?.error.code)
  }
  return response
}

async function get<T>(path: string, parser: Parser<T>, signal: AbortSignal) {
  const response = await request(path, { signal })
  return parser.parse(await response.json())
}

const sessionEnvelope = {
  parse(value: unknown): Omit<Session, 'verified'> {
    if (typeof value !== 'object' || value === null || !('data' in value) || !('meta' in value)) {
      throw Error('Invalid session response')
    }
    metadata.parse(value.meta)
    const session = value.data
    if (typeof session !== 'object' || session === null || !('kind' in session) || session.kind !== 'session'
        || !('role' in session)
        || !('id' in session) || !('scopes' in session) || !Array.isArray(session.scopes)
        || !session.scopes.every(scope => typeof scope === 'string')) {
      throw Error('Invalid session response')
    }
    const role = session.role
    if (role !== 'admin' && role !== 'analyst' && role !== 'viewer') throw Error('Invalid session role')
    return { id: idParams.shape.id.parse(session.id), role, chatgptSettings: 'chatgptSettings' in session && session.chatgptSettings === true, scopes: new Set(session.scopes) }
  },
}

export async function getSession(signal: AbortSignal): Promise<Session> {
  return { ...await get('/api/v1/me', sessionEnvelope, signal), verified: signal }
}

export async function signIn(email: string, password: string) {
  const response = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, rememberMe: false }),
  })
  if (response.status !== 204) throw Error('Invalid sign-in response')
}

export async function signOut() {
  const response = await request('/api/auth/sign-out', { method: 'POST' })
  if (response.status !== 204) throw Error('Invalid sign-out response')
}

export function can(session: Session, scope: Scope) {
  return session.scopes.has(scope)
}

export function isResourceId(value: unknown) {
  return idParams.shape.id.safeParse(value).success
}

export function getPermits(filters: PermitFilters, cursor: string | undefined, signal: AbortSignal) {
  const parsed = recordsQuery.safeParse({ ...filters, cursor, limit: 25 })
  if (!parsed.success) throw new ApiError(400)
  const query = parsed.data
  const params = new URLSearchParams({ limit: String(query.limit) })
  if (query.jurisdiction !== undefined) params.set('jurisdiction', query.jurisdiction)
  if (query.permitNumber !== undefined) params.set('permitNumber', query.permitNumber)
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return get('/api/v1/records?' + params, records, signal)
}

export function getPermit(id: string, signal: AbortSignal) {
  return get('/api/v1/records/' + encodeURIComponent(id), record, signal)
}

export function getObservation(id: string, signal: AbortSignal) {
  return get('/api/v1/evidence/' + encodeURIComponent(id), evidence, signal)
}

/** Campaign endpoints share the authenticated transport and versioned envelope. */
export async function campaignPage<T>(path: string, init?: RequestInit) {
  const response = await request('/api/v1/' + path, init)
  const payload = await response.json()
  const meta = metadata.parse(payload.meta)
  if (payload.data == null) throw Error('Missing campaign data')
  return { data: payload.data as T, meta }
}

export async function campaignData<T>(path: string, init?: RequestInit): Promise<T> {
  return (await campaignPage<T>(path, init)).data
}

export function campaignWrite<T>(path: string, body: unknown, method = 'POST', requestKey?: string, signal?: AbortSignal) {
  return campaignData<T>(path, {
    method, signal, headers: { 'Content-Type': 'application/json', ...(requestKey && { 'Idempotency-Key': requestKey }) },
    body: JSON.stringify(body),
  })
}

export async function downloadRunCsv(id: string, signal: AbortSignal) {
  if (!isResourceId(id)) throw new ApiError(400)
  const response = await request('/api/v1/exports/' + id + '/download', { signal })
  if (!response.headers.get('Content-Type')?.startsWith('text/csv')) throw Error('Expected CSV')
  const blob = await response.blob()
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'campaign-' + id + '.csv'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
