import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { fail } from '../middleware/errors.ts'
import type { Registration, WithHost } from './store.ts'

const issuer = 'https://auth.openai.com'
const resource = 'https://api.openai.com/v1'
const direct = 'chatgpt.tokens.use.direct'
const scopes = 'openid profile email offline_access resource.invoke ' + direct
const random = () => randomBytes(32).toString('base64url')
const unavailable = () => fail(502, 'CHATGPT_UNAVAILABLE', 'ChatGPT did not complete the request. Try again.')
const reconnect = () => fail(409, 'CHATGPT_RECONNECT', 'Reconnect your ChatGPT account.')
const invalid = () => fail(400, 'CHATGPT_INVALID', 'Start a new ChatGPT sign-in.')
const terminalRefresh = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused'])
function usageError(code: unknown) {
  if (code === 'subscription_sharing_usage_limit_exceeded')
    fail(429, 'CHATGPT_PLAN_LIMIT', 'Review this app’s limits in ChatGPT usage settings.')
  if (code === 'subscription_sharing_usage_unavailable')
    fail(503, 'CHATGPT_USAGE_UNAVAILABLE', 'ChatGPT could not check usage. Try again later.')
}
async function rejectedBearer(res: Response) {
  if (res.status !== 401 && res.status !== 403) return false
  const challenges = (res.headers.get('www-authenticate') ?? '').split(/,\s*(?=[\w-]+\s+[\w-]+=)/)
  if (challenges.some(value => /^Bearer\s/i.test(value) && /(?:\s|,)error\s*=\s*"?invalid_token"?(?=\s*(?:,|$))/i.test(value)))
    return true
  const body = await res.json().catch(() => null) as { error?: string | { code?: string }; code?: string } | null
  return body?.error === 'invalid_token' || body?.code === 'invalid_token'
    || (typeof body?.error === 'object' && body.error?.code === 'invalid_token')
}
const slug = z.string().min(1).max(160)
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
  token_type: z.string().regex(/^Bearer$/i), expires_in: z.number().int().positive(), scope: z.string().optional(),
  id_token: z.string().min(1).optional() })
const catalogSchema = z.object({ models: z.array(z.object({ slug, visibility: z.string(), display_name: z.string(),
  supported_reasoning_levels: z.array(z.object({ effort: slug })).nullish() })) })
type Pending = { accountId?: string; revision: number; state: string; nonce: string; verifier: string; client?: string; session: string;
  expires: number; callback: string; server: Server; code?: string; issued?: string; denied?: boolean }

export class ChatGPT {
  private pending?: Pending
  private retryRegistration?: { session: string; client: string; expires: number }
  private starting = false
  private jwks
  private store: WithHost
  private origin: string
  private port: number
  private authorizeUrl: string
  private fetcher: typeof fetch
  constructor(store: WithHost, origin: string, port: number, fetcher: typeof fetch = fetch, authorizeUrl = issuer + '/api/accounts/authorize') {
    this.authorizeUrl = authorizeUrl
    this.store = store
    this.origin = origin
    this.port = port
    this.fetcher = fetcher
    this.jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), { [customFetch]: fetcher })
  }
  close() {
    this.pending?.server.close()
    this.pending = undefined
  }
  private async request(url: string, init: RequestInit = {}) {
    try { return await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }) }
    catch { return unavailable() }
  }
  private token(form: URLSearchParams) {
    return this.request(issuer + '/api/accounts/oauth/token', { method: 'POST', body: form })
  }
  async start(session: string, id?: string, retryNew = false) {
    if (this.starting || (this.pending && this.pending.expires > Date.now() && this.pending.session !== session))
      fail(409, 'CHATGPT_BUSY', 'Another sign-in is in progress.')
    this.starting = true
    this.close()
    try { return await this.store(async host => {
      const account = id ? host.accounts.find(a => a.id === id) : undefined
      if (id && !account) invalid()
      const retry = this.retryRegistration
      if (retryNew && (id || !retry || retry.session !== session || retry.expires <= Date.now())) return invalid()
      const client = retryNew ? retry?.client : account?.client
      const state = random(), nonce = random(), verifier = random()
      const auth = new URL(this.authorizeUrl)
      const ticket = random()
      const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Referrer-Policy', 'no-referrer')
        const p = this.pending
        if (!p || p.server !== server || p.expires <= Date.now() || req.method !== 'GET'
            || req.headers.host !== new URL(p.callback).host) { res.writeHead(400).end(); return }
        const url = new URL(req.url ?? '/', p.callback)
        if (url.pathname === '/auth/start' && url.searchParams.get('ticket') === ticket) {
          res.writeHead(303, { Location: auth.href }).end(); return
        }
        if (url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state || p.code || p.denied) {
          res.writeHead(400).end(); return
        }
        p.issued = url.searchParams.get('client_id') ?? p.client
        p.code = url.searchParams.get('code') ?? undefined
        p.denied = url.searchParams.has('error') || !p.code || !p.issued || p.issued === 'dynamic_agent_client'
          || Boolean(p.client && p.issued !== p.client)
        res.writeHead(303, { Location: this.origin + '/settings?chatgpt=return' }).end()
        server.close()
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(this.port, '127.0.0.1', resolve)
        })
      } catch { fail(409, 'CHATGPT_CALLBACK_BUSY', 'The local callback port is occupied. Finish the other sign-in and retry.') }
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); return unavailable() }
      const callback = 'http://127.0.0.1:' + address.port + '/auth/callback'
      this.retryRegistration = undefined
      this.pending = { server, session, state, accountId: account?.id, revision: host.revision ?? 0, nonce, verifier, callback, client, expires: Date.now() + 600000 }
      const timer = setTimeout(() => { if (this.pending?.state === state) this.close() }, 600000)
      timer.unref()
      auth.search = new URLSearchParams({
        client_id: client ?? 'dynamic_agent_client', ext_agent_host_id: host.host,
        ...(!client ? { agent_name_hint: 'SkyScrape' } : {}),
        ...(account?.identityOnly ? { id_token_hint: account.identityOnly, prompt: 'consent' }
          : account?.tokens ? { id_token_hint: account.tokens.identity } : {}),
        response_type: 'code', redirect_uri: callback, scope: scopes, resource, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString()
      return { url: new URL('/auth/start?ticket=' + ticket, callback).href }
    }) } finally { this.starting = false }
  }
  async finish(session: string) {
    const p = this.pending
    if (!p || p.session !== session || p.expires <= Date.now()) return invalid()
    this.close()
    if (p.denied || !p.code || !p.issued) return invalid()
    const client = p.issued
    const res = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: client,
      code: p.code, code_verifier: p.verifier, redirect_uri: p.callback, resource }))
    if (!res.ok) {
      const problem = await res.json().catch(() => ({})) as { error?: string }
      if (!p.accountId && problem.error === 'invalid_grant') {
        this.retryRegistration = { session, client, expires: p.expires }
        fail(409, 'CHATGPT_REGISTRATION_RETRY', 'Retry this new ChatGPT registration.')
      }
      return invalid()
    }
    const exchange = await res.json()
    const signIn = z.object({ id_token: z.string().min(1), scope: z.string().optional() }).safeParse(exchange)
    if (!signIn.success) return invalid()
    const identity = signIn.data.id_token
    const { payload } = await jwtVerify(identity, this.jwks, { algorithms: ['RS256'], issuer, audience: client,
      requiredClaims: ['sub', 'exp', 'nonce'] }).catch(invalid)
    if (payload.nonce !== p.nonce || !payload.sub || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== client)) return invalid()
    const subject = payload.sub
    const granted = signIn.data.scope?.split(/\s+/) ?? []
    const enabled = [direct, 'resource.invoke', 'offline_access'].every(s => granted.includes(s))
    const tokens = enabled ? tokenSchema.safeParse(exchange) : undefined
    if (tokens && !tokens.success) return invalid()
    const data = tokens?.data
    return this.store(async (host, save) => {
      if ((host.revision ?? 0) !== p.revision) return invalid()
      const firstConnection = Boolean(data) && !(host.welcomed ?? host.accounts.some(a => a.tokens))
      let account = host.accounts.find(a => a.client === client)
      if (account?.id !== p.accountId || (account && account.subject !== subject)) return invalid()
      this.retryRegistration = undefined
      if (!account) {
        account = { id: randomUUID(), client, subject, label: 'Account ' + (host.accounts.length + 1) }
        host.accounts.push(account)
      }
      if (data) {
        account.tokens = { access: data.access_token, refresh: data.refresh_token, identity, scopes: granted,
          expires: Date.now() + 1000 * data.expires_in }
        delete account.identityOnly
        host.active = account.id
        host.welcomed = true
      } else {
        delete account.tokens
        account.identityOnly = identity
        host.active ??= account.id
      }
      host.revision = p.revision + 1
      await save()
      return { firstConnection, planEnabled: Boolean(data) }
    })
  }
  private async access(a: Registration, save: () => Promise<void>) {
    const old = a.tokens
    if (!old) return reconnect()
    if (old.expires > Date.now() + 60000) return old.access
    const res = await this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: a.client,
      refresh_token: old.refresh, resource }))
    if (!res.ok) {
      const issue = await res.json().catch(() => ({})) as { error?: string | { code?: string }; code?: string }
      const code = typeof issue?.error === 'object' ? issue.error?.code : issue?.error
      if (res.status < 500 && (terminalRefresh.has(code ?? '') || terminalRefresh.has(issue?.code ?? ''))) {
        delete a.tokens; await save(); return reconnect()
      }
      return unavailable()
    }
    const token = tokenSchema.parse(await res.json())
    const granted = token.scope?.split(/\s+/) ?? old.scopes
    if (![direct, 'resource.invoke'].every(s => granted.includes(s))) { delete a.tokens; await save(); return reconnect() }
    a.tokens = { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + 1000 * token.expires_in,
      scopes: granted, identity: old.identity }
    await save()
    return a.tokens.access
  }
  private async models(a: Registration, save: () => Promise<void>) {
    const catalog = async () => this.request(resource + '/models', {
      headers: { Authorization: 'Bearer ' + await this.access(a, save) },
    })
    let res = await catalog()
    if (await rejectedBearer(res) && a.tokens) {
      a.tokens.expires = 0
      await save()
      res = await catalog()
      if (await rejectedBearer(res)) {
        delete a.tokens
        await save()
        return reconnect()
      }
    }
    if (!res.ok) return unavailable()
    return catalogSchema.parse(await res.json()).models.filter(m => m.visibility === 'list').map(m => ({
      id: m.slug, name: m.display_name, efforts: m.supported_reasoning_levels?.map(e => e.effort) ?? [],
    }))
  }
  async status(session?: string) {
    return this.store(async (host, save) => {
      const a = host.accounts.find(a => a.id === host.active)
      let models: Awaited<ReturnType<ChatGPT['models']>> = []
      let problem: string | undefined
      if (a?.tokens) {
        try { models = await this.models(a, save) } catch {
          problem = a.tokens ? 'Model list unavailable. Retry or reconnect your account.' : 'Reconnect your saved ChatGPT account.'
        }
      }
      const retry = this.retryRegistration
      const retryNew = Boolean(retry && retry.session === session && retry.expires > Date.now())
      return { retryNew, accounts: host.accounts.map(({ id, label, tokens, identityOnly }) => ({ id, label, connected: Boolean(tokens), needsConsent: Boolean(identityOnly) })), active: a?.id,
        connected: Boolean(a?.tokens), model: a?.model, effort: a?.effort, models, problem }
    })
  }
  async choose(id: string, model: string, effort?: string) {
    return this.store(async (host, save) => {
      const a = host.accounts.find(a => a.id === host.active && a.id === id)
      if (!a) return reconnect()
      const selected = (await this.models(a, save)).find(m => m.id === model)
      if (!selected || (effort && !selected.efforts.includes(effort)))
        fail(400, 'CHATGPT_MODEL', 'Select a model and reasoning effort from the current account catalog.')
      a.model = model; a.effort = effort; await save()
    })
  }
  async disconnect(id: string) {
    this.close()
    return this.store(async (host, save) => {
      const a = host.accounts.find(a => a.id === id)
      if (!a) return invalid()
      let revoked = true
      if (a.tokens) {
        revoked = false
        for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
          try {
            const discovery = await this.request(issuer + '/.well-known/openid-configuration')
            if (!discovery.ok) throw Error()
            const metadata = z.object({ issuer: z.literal(issuer), revocation_endpoint: z.url() }).parse(await discovery.json())
            if (new URL(metadata.revocation_endpoint).origin !== issuer) throw Error()
            const res = await this.request(metadata.revocation_endpoint, { method: 'POST',
              body: new URLSearchParams({ token: a.tokens.refresh, token_type_hint: 'refresh_token', client_id: a.client }) })
            revoked = res.status === 200
            if (res.status < 500) break
          } catch { /* Clear the local session even when the provider cannot confirm revocation. */ }
          if (!attempt) await delay(250)
        }
      }
      host.revision = (host.revision ?? 0) + 1
      delete a.tokens; delete a.identityOnly; if (host.active === id) delete host.active
      await save(); return { revoked }
    })
  }
  async repairBrief(incident: { category: 'parser_drift' | 'rate_limited' | 'schema_mismatch'; fieldCount: number }) {
    const safe = z.strictObject({ category: z.enum(['parser_drift', 'rate_limited', 'schema_mismatch']),
      fieldCount: z.number().int().min(0).max(1024) }).parse(incident)
    return this.store(async (host, save) => {
      const a = host.accounts.find(a => a.id === host.active)
      if (!a?.model) return reconnect()
      const model = (await this.models(a, save)).find(m => m.id === a.model)
      if (!model || (a.effort && !model.efforts.includes(a.effort))) return reconnect()
      const res = await this.request(resource + '/responses', { method: 'POST',
        headers: { Authorization: 'Bearer ' + await this.access(a, save), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.id, ...(a.effort ? { reasoning: { effort: a.effort } } : {}),
          instructions: 'Draft a short repair brief from this incident category and affected field count. Mark unknowns explicitly.',
          input: [{ role: 'user', content: JSON.stringify(safe) }], stream: true, store: false }) })
      if (!res.ok) {
        const issue = await res.json().catch(() => ({})) as { error?: { code?: string } }
        usageError(issue?.error?.code)
        return unavailable()
      }
      if (!res.body) return unavailable()
      const reader = res.body.getReader(), decoder = new TextDecoder()
      let buffer = '', output = '', size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 262144) return unavailable()
          buffer += decoder.decode(chunk.value, { stream: true })
          let split: RegExpExecArray | null
          while ((split = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, split.index); buffer = buffer.slice(split.index + split[0].length)
            const data = block.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n')
            if (!data) continue
            const event = JSON.parse(data) as { type: string; delta?: string; code?: string; response?: { error?: { code?: string } } }
            usageError(event.response?.error?.code ?? event.code)
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') output += event.delta
            if (output.length > 8192 || ['response.failed', 'error', 'response.incomplete'].includes(event.type)) return unavailable()
            if (event.type === 'response.completed' && output.trim()) return output
          }
        }
        return unavailable()
      } finally { await reader.cancel().catch(() => {}) }
    })
  }
}
