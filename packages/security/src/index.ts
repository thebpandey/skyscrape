import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export const roles = ['admin', 'analyst', 'viewer'] as const
export const scopes = [
  'records:read', 'evidence:read', 'contacts:read', 'campaigns:write', 'runs:create',
  'schedules:write', 'runs:read', 'runs:cancel', 'research:create', 'sources:read',
  'exports:create', 'exports:read', 'analytics:read', 'issues:read', 'issues:triage',
] as const
export type Scope = typeof scopes[number]
export type Role = typeof roles[number]
export type Principal = { id: string; role: Role; kind: 'session' | 'key'; scopes: readonly Scope[] }
const viewerScopes: readonly Scope[] = [
  'records:read', 'evidence:read', 'runs:read', 'sources:read', 'analytics:read', 'issues:read',
]
const analystOnly: readonly Scope[] = ['contacts:read', 'exports:create', 'exports:read']

export function roleScopes(role: Role): readonly Scope[] {
  if (role === 'viewer') return viewerScopes
  if (role === 'analyst') return scopes
  return scopes.filter(scope => !analystOnly.includes(scope))
}

export function can(principal: Principal, scope: Scope) {
  return roleScopes(principal.role).includes(scope) && principal.scopes.includes(scope)
}

export function tokenDigest(value: string, pepper: string) {
  return createHmac('sha256', pepper).update(value).digest()
}

export function seal(secret: string, key: Buffer, version: number, purpose: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify([version, purpose])))
  const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes])
}

export function unseal(encrypted: Buffer, key: Buffer, version: number, purpose: string) {
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
  decipher.setAAD(Buffer.from(JSON.stringify([version, purpose])))
  decipher.setAuthTag(encrypted.subarray(12, 28))
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
}

type Contact = {
  channel: 'email' | 'phone' | 'website'
  value: string
  verified: boolean
  public_business: boolean
  suppressed: boolean
  person_suppressed: boolean
  checked_on: string | null
}

function hasCurrentCheckDate(checkedOn: string | null, today: string) {
  if (checkedOn === null || checkedOn > today) return false
  const timestamp = Date.parse(checkedOn)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === checkedOn
}

export function projectContacts(principal: Principal, contacts: readonly Contact[]) {
  if (!can(principal, 'contacts:read')) return []
  const today = new Date().toISOString().slice(0, 10)
  return contacts
    .filter(contact => contact.verified && contact.public_business && hasCurrentCheckDate(contact.checked_on, today)
      && !contact.suppressed && !contact.person_suppressed)
    .map(({ channel, value }) => ({ channel, value }))
}
