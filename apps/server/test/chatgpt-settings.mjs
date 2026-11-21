import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import Fastify from 'fastify'
import { validatorCompiler } from '@fastify/type-provider-zod'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { createServer } from 'vite'
import { ChatGPT } from '../src/chatgpt/provider.ts'
import { hostStore } from '../src/chatgpt/store.ts'
import { registerChatGPT } from '../src/routes/chatgpt-settings.ts'
import { registerErrors } from '../src/middleware/errors.ts'

test('synthetic issuer, owner session, browser preferences, renewable grant and bounded repair', async t => {
  const key = randomBytes(32), owner = randomUUID(), session = randomUUID()
  const dir = await mkdtemp(join(tmpdir(), 'sky-chatgpt-synthetic-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Disposable in-process equivalent of the store's PostgreSQL transaction lock.
  let previous = Promise.resolve()
  const pool = { async connect() {
    let release
    const waiting = previous
    previous = new Promise(r => { release = r })
    await waiting
    return { query() {}, release }
  } }
  const store = hostStore(pool, dir, owner, key, 1)
  const keys = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic', alg: 'RS256' }
  let auth, issuedTokens = 0, refreshed = 0, revoked = 0, inference = 0, failInference = false
  let identity = 'synthetic-owner', direct = false, expectedConsent = false, modelCalls = 0
  let usageFailure, refreshFailure
  const granted = 'openid profile email resource.invoke offline_access chatgpt.tokens.use.direct'
  const fetcher = async (input, init) => {
    const url = String(input)
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({
      issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
    })
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const form = init.body
      assert.equal(form.get('client_id'), 'issued-synthetic')
      assert.equal(form.get('resource'), 'https://api.openai.com/v1')
      if (form.get('grant_type') === 'refresh_token') {
        refreshed++
        if (refreshFailure) return Response.json({ error: { code: refreshFailure } }, { status: 401 })
        assert.equal(form.get('refresh_token'), 'private-refresh')
        assert.equal(form.has('scope'), false)
        return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })
      }
      issuedTokens++
      assert.equal(form.get('redirect_uri'), auth.get('redirect_uri'))
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.get('code_challenge'))
      const idToken = await new SignJWT({ nonce: auth.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setSubject(identity).setAudience('issued-synthetic').setIssuer('https://auth.openai.com').setExpirationTime('5m').sign(keys.privateKey)
      if (!direct) return Response.json({ id_token: idToken, scope: 'openid profile email' })
      return Response.json({ id_token: idToken, access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600,
        token_type: 'Bearer', scope: granted })
    }
    if (url === 'https://api.openai.com/v1/models') {
      modelCalls++
      assert.match(init.headers.Authorization, /^Bearer (private|rotated)-access$/)
      return Response.json({ models: [
        { slug: 'synthetic', display_name: 'Synthetic model', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] },
        { slug: 'automatic', display_name: 'Automatic model', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden model', visibility: 'hidden' },
      ] })
    }
    if (url === 'https://api.openai.com/v1/responses') {
      inference++
      const body = JSON.parse(init.body)
      assert.equal(body.store, false); assert.equal(body.stream, true)
      assert.equal(body.model, 'synthetic'); assert.equal(body.reasoning.effort, 'medium')
      assert.deepEqual(JSON.parse(body.input[0].content), { category: 'parser_drift', fieldCount: 1 })
      if (usageFailure && !usageFailure.stream) return Response.json({ error: { code: usageFailure.code } }, { status: usageFailure.status })
      const events = [{ type: 'response.output_text.delta', delta: 'Synthetic brief' },
        { type: failInference ? 'response.failed' : 'response.completed', response: { error: { code: usageFailure?.code } } }]
      return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join(''))
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      revoked++; assert.equal(init.body.get('token_type_hint'), 'refresh_token')
      return new Response(null, { status: 200 })
    }
    throw Error('Unexpected destination')
  }
  const api = Fastify({ genReqId: () => randomUUID() })
  t.after(() => api.close())
  api.setValidatorCompiler(validatorCompiler)
  registerErrors(api)
  let actor = owner, kind = 'session'
  api.addHook('onRequest', async req => {
    req.authenticated = { principal: { id: actor, kind, role: 'analyst', scopes: [] }, proof: { kind, id: session } }
  })
  api.get('/api/v1/me', () => ({ data: { id: actor, kind, role: 'analyst', scopes: [], chatgptSettings: true },
    meta: { requestId: randomUUID(), schemaVersion: 1 } }))
  // Vite starts first to establish the canonical browser return origin.
  const frontend = await createServer({ root: resolve('apps/web'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false } })
  await frontend.listen()
  t.after(() => frontend.close())
  const origin = 'http://127.0.0.1:' + frontend.httpServer.address().port
  const provider = new ChatGPT(store, origin, 0, fetcher, origin + '/synthetic-authorize')
  t.after(() => provider.close())
  registerChatGPT(api, owner, provider)
  const apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 })
  const base = '/api/v1/settings/chatgpt'
  for (const [actorId, actorKind] of [[randomUUID(), 'session'], [owner, 'key']]) {
    actor = actorId; kind = actorKind
    assert.equal((await api.inject({ url: base })).statusCode, 403)
    assert.equal((await api.inject({ method: 'POST', url: base + '/connect', payload: {} })).statusCode, 403)
  }
  actor = owner; kind = 'session'
  const browser = await chromium.launch({ executablePath: process.env.SHELL_CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route(origin + '/api/**', async route => {
    const response = await route.fetch({ url: apiOrigin + new URL(route.request().url()).pathname })
    if ((response.headers()['content-type'] ?? '').includes('json')) {
      assert.doesNotMatch(await response.text(), /private-access|private-refresh|rotated-refresh|id_token|issued-synthetic/)
    }
    await route.fulfill({ response })
  })
  let savedHost
  frontend.middlewares.stack.unshift({ route: '/synthetic-authorize', handle: async (req, res) => {
    auth = new URL(req.url, origin).searchParams
    assert.equal(auth.get('prompt'), expectedConsent ? 'consent' : null)
    assert.equal(auth.get('scope'), granted.replace('resource.invoke offline_access', 'offline_access resource.invoke'))
    if (!savedHost) {
      savedHost = auth.get('ext_agent_host_id')
      assert.equal(auth.get('client_id'), 'dynamic_agent_client')
      assert.equal(auth.get('agent_name_hint'), 'SkyScrape')
    } else {
      assert.equal(auth.get('ext_agent_host_id'), savedHost)
      assert.equal(auth.get('client_id'), 'issued-synthetic')
      assert.equal(auth.has('agent_name_hint'), false)
    }
    const callback = new URL(auth.get('redirect_uri'))
    callback.search = new URLSearchParams({ state: auth.get('state'), client_id: 'issued-synthetic', code: 'synthetic-code' })
    await assert.rejects(provider.finish('different-workspace-session'))
    const rival = new ChatGPT(store, origin, Number(callback.port), fetcher)
    await assert.rejects(rival.start(session), /callback port is occupied/)
    const tampered = new URL(callback); tampered.searchParams.set('state', 'wrong')
    assert.equal((await fetch(tampered, { redirect: 'manual' })).status, 400)
    res.writeHead(302, { location: callback.href }).end()
  } })
  await page.goto(origin + '/settings')
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click()
  await expect(page.getByText('Account saved. ChatGPT plan use is disabled.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('ChatGPT plan use disabled')).toBeVisible()
  assert.equal(modelCalls, 0)
  await assert.rejects(provider.repairBrief({ category: 'parser_drift', fieldCount: 1 }))
  assert.equal(inference, 0)
  direct = true; expectedConsent = true
  await page.getByRole('button', { name: 'Enable ChatGPT plan for Account 1' }).click()
  await page.getByRole('button', { name: 'Got it' }).click()
  expectedConsent = false
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('automatic')
  await expect(page.getByRole('combobox', { name: 'Reasoning effort' })).toBeDisabled()
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('synthetic')
  await page.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('medium')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByText('Preferences saved.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('medium')
  const restored = new ChatGPT(hostStore(pool, dir, owner, key, 1), origin, 0, fetcher)
  const state = await restored.status()
  assert.equal(state.effort, 'medium')
  assert.deepEqual(state.models.map(m => m.id), ['synthetic', 'automatic'])
  await assert.rejects(restored.choose(state.active, 'hidden', 'high'))
  await assert.rejects(restored.choose(state.active, 'automatic', 'high'))
  const path = join(dir, owner + '.enc')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.doesNotMatch((await readFile(path)).toString('utf8'), /private-access|private-refresh|synthetic-owner/)
  await store(async (host, save) => { host.accounts[0].tokens.expires = 0; await save() })
  await Promise.all([restored.status(), provider.status()])
  assert.equal(refreshed, 1)
  assert.equal(inference, 0)
  assert.equal(await restored.repairBrief({ category: 'parser_drift', fieldCount: 1 }), 'Synthetic brief')
  failInference = true
  await assert.rejects(restored.repairBrief({ category: 'parser_drift', fieldCount: 1 }))
  await assert.rejects(restored.repairBrief({ category: 'parser_drift', fieldCount: 1, snippet: 'private' }))
  assert.equal(inference, 2)
  for (const [code, status, appCode] of [
    ['subscription_sharing_usage_limit_exceeded', 429, 'CHATGPT_PLAN_LIMIT'],
    ['subscription_sharing_usage_unavailable', 503, 'CHATGPT_USAGE_UNAVAILABLE'],
  ]) {
    for (const stream of [false, true]) {
      usageFailure = { code, status, stream }
      await assert.rejects(restored.repairBrief({ category: 'parser_drift', fieldCount: 1 }), { status, code: appCode })
    }
  }
  assert.equal((await restored.status()).connected, true)
  identity = 'other'
  await page.getByRole('button', { name: 'Reconnect Account 1' }).click()
  await expect(page.getByText('Sign-in could not be verified.', { exact: false })).toBeVisible()
  assert.equal((await restored.status()).active, state.active)
  identity = 'synthetic-owner'
  await page.getByRole('button', { name: 'Disconnect ChatGPT' }).click()
  await expect(page.getByText('Disconnected.', { exact: true })).toBeVisible()
  assert.equal(revoked, 1)
  assert.equal((await restored.status()).connected, false)
  await page.getByRole('button', { name: 'Connect Account 1' }).click()
  await expect(page.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('medium')
  assert.equal(issuedTokens, 4)
  refreshFailure = 'refresh_token_expired'
  await store(async (host, save) => { host.accounts[0].tokens.expires = 0; await save() })
  await page.reload()
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible()
  const count = refreshed
  assert.equal(count, 2)
  assert.equal((await restored.status()).connected, false)
  await assert.rejects(restored.repairBrief({ category: 'parser_drift', fieldCount: 1 }), { code: 'CHATGPT_RECONNECT' })
  assert.equal(refreshed, count)
  await expect(page.getByRole('button', { name: 'Reconnect Account 1' })).toBeVisible()
})
