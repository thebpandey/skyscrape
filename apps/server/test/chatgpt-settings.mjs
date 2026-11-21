import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { createServer as createSocketServer } from 'node:net'
import { once } from 'node:events'
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
  let usageFailure, refreshFailure, exchangeFails = false
  let expectedClient = 'dynamic_agent_client', callbackClient = 'issued-synthetic', efforts = [{ effort: 'medium' }]
  const granted = 'openid profile email resource.invoke offline_access chatgpt.tokens.use.direct'
  const fetcher = async (input, init) => {
    const url = String(input)
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({
      issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
    })
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const form = init.body
      assert.equal(form.get('client_id'), callbackClient)
      assert.equal(form.get('resource'), 'https://api.openai.com/v1')
      if (form.get('grant_type') === 'refresh_token') {
        refreshed++
        if (refreshFailure) return Response.json({ error: { code: refreshFailure } }, { status: 401 })
        assert.equal(form.get('refresh_token'), 'private-refresh')
        assert.equal(form.has('scope'), false)
        return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })
      }
      issuedTokens++
      if (exchangeFails) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      assert.equal(form.get('redirect_uri'), auth.get('redirect_uri'))
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.get('code_challenge'))
      const idToken = await new SignJWT({ nonce: auth.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setSubject(identity).setAudience(callbackClient).setIssuer('https://auth.openai.com').setExpirationTime('5m').sign(keys.privateKey)
      if (!direct) return Response.json({ id_token: idToken, scope: 'openid profile email' })
      return Response.json({ id_token: idToken, access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600,
        token_type: 'Bearer', scope: granted })
    }
    if (url === 'https://api.openai.com/v1/models') {
      modelCalls++
      assert.match(init.headers.Authorization, /^Bearer (private|rotated)-access$/)
      return Response.json({ models: [
        { slug: 'synthetic', display_name: 'Synthetic model', visibility: 'list', supported_reasoning_levels: efforts },
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
  const probe = createSocketServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const callbackPort = probe.address().port
  probe.close()
  await once(probe, 'close')
  const provider = new ChatGPT(store, origin, callbackPort, fetcher, origin + '/synthetic-authorize')
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
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.context().route(origin + '/api/**', async route => {
    const response = await route.fetch({ url: apiOrigin + new URL(route.request().url()).pathname })
    if ((response.headers()['content-type'] ?? '').includes('json')) {
      assert.doesNotMatch(await response.text(), /private-access|private-refresh|rotated-refresh|id_token|issued-synthetic/)
    }
    await route.fulfill({ response })
  })
  // Simulate a browser on another computer: its loopback cannot reach the API host.
  const sshHosts = new Map([
    ['https://miniserver.test:10444', 'miniserver.test'],
    ['https://[fd00::1]:10444', 'fd00::1'],
  ])
  const remotePage = await context.newPage()
  let starts = 0
  let loopbackVisits = 0
  await context.route(url => sshHosts.has(url.origin), async route => {
    const { origin: remoteOrigin, pathname: path } = new URL(route.request().url())
    if (path === base + '/connect') starts++
    const target = path.startsWith('/api/') ? apiOrigin : origin
    await route.fulfill({ response: await route.fetch({
      url: route.request().url().replace(remoteOrigin, target),
    }) })
  })
  await remotePage.route('http://127.0.0.1:*/auth/start?*', route => {
    loopbackVisits++
    return route.fulfill({ status: 200, body: 'Synthetic client loopback' })
  })
  const connectButton = remotePage.getByRole('button', { name: 'Continue with ChatGPT' })
  const tunnel = remotePage.getByRole('dialog', { name: 'Connect from this computer' })
  for (const [remoteOrigin, host] of sshHosts) {
    await remotePage.goto(remoteOrigin + '/settings')
    await connectButton.click()
    await expect(tunnel.locator('code')).toHaveText(
      `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${callbackPort}:127.0.0.1:${callbackPort} `
      + (process.env.CHATGPT_SSH_USER ?? userInfo().username) + '@' + host)
    await tunnel.getByRole('button', { name: 'Cancel' }).click()
    assert.equal(starts, 0)
    assert.equal(loopbackVisits, 0)
  }
  await connectButton.click()
  await tunnel.getByRole('button', { name: 'Tunnel ready, continue' }).click()
  await expect(remotePage.getByText('Synthetic client loopback')).toBeVisible()
  assert.equal(starts, 1)
  assert.equal(loopbackVisits, 1)
  await remotePage.close()
  let savedHost
  frontend.middlewares.stack.unshift({ route: '/synthetic-authorize', handle: async (req, res) => {
    auth = new URL(req.url, origin).searchParams
    assert.equal(auth.get('prompt'), expectedConsent ? 'consent' : null)
    assert.equal(auth.get('scope'), granted.replace('resource.invoke offline_access', 'offline_access resource.invoke'))
    savedHost ??= auth.get('ext_agent_host_id')
    assert.equal(auth.get('ext_agent_host_id'), savedHost)
    assert.equal(auth.get('client_id'), expectedClient)
    assert.equal(auth.has('agent_name_hint'), expectedClient === 'dynamic_agent_client')
    const callback = new URL(auth.get('redirect_uri'))
    callback.search = new URLSearchParams({ state: auth.get('state'), client_id: callbackClient, code: 'synthetic-code' })
    await assert.rejects(provider.finish('different-workspace-session'))
    const rival = new ChatGPT(store, origin, Number(callback.port), fetcher)
    await assert.rejects(rival.start(session), /callback port is occupied/)
    const tampered = new URL(callback); tampered.searchParams.set('state', 'wrong')
    assert.equal((await fetch(tampered, { redirect: 'manual' })).status, 400)
    res.writeHead(302, { location: callback.href }).end()
  } })
  // This browser is on the miniserver and opens Settings by its Tailscale hostname.
  await page.goto('https://miniserver.test:10444/settings')
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click()
  assert.equal(starts, 1)
  await page.getByRole('button', { name: 'I’m using a browser on the miniserver' }).click()
  await expect(page.getByText('Account saved. ChatGPT plan use is disabled.')).toBeVisible()
  assert.equal(starts, 2)
  await page.reload()
  await expect(page.getByText('ChatGPT plan use disabled')).toBeVisible()
  assert.equal(modelCalls, 0)
  await assert.rejects(provider.repairBrief({ category: 'parser_drift', fieldCount: 1 }))
  assert.equal(inference, 0)
  direct = true; expectedConsent = true; expectedClient = callbackClient
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
  efforts = []
  await page.reload()
  const effortPicker = page.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(effortPicker).toHaveValue('')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByText('Preferences saved.')).toBeVisible()
  assert.equal((await provider.status()).effort, undefined)
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('automatic')

  // Keep tab A's draft open while tab B reauthorizes and switches registrations.
  const otherTab = await page.context().newPage()
  await otherTab.goto(origin + '/settings')
  exchangeFails = true
  await otherTab.getByRole('button', { name: 'Reconnect Account 1' }).click()
  await expect(otherTab.getByText('Sign-in could not be verified.', { exact: false })).toBeVisible()
  await expect(otherTab.getByRole('button', { name: 'Retry new registration' })).toHaveCount(0)
  expectedClient = 'dynamic_agent_client'; callbackClient = 'issued-synthetic-2'
  await otherTab.getByRole('button', { name: 'Add ChatGPT account' }).click()
  await expect(otherTab.getByRole('button', { name: 'Retry new registration' })).toBeVisible()
  assert.equal((await provider.status()).active, state.active)
  assert.equal((await provider.status('different-owner-session')).retryNew, false)
  await assert.rejects(provider.start('different-owner-session', undefined, true), { code: 'CHATGPT_INVALID' })
  exchangeFails = false; expectedClient = callbackClient; identity = 'second-synthetic'
  await otherTab.getByRole('button', { name: 'Retry new registration' }).click()
  await expect(otherTab.getByText('Using ChatGPT plan · Account 2')).toBeVisible()
  await assert.rejects(provider.start(session, undefined, true), { code: 'CHATGPT_INVALID' })
  const [staleSave] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/preferences')),
    page.getByRole('button', { name: 'Save preferences' }).click(),
  ])
  assert.equal(staleSave.status(), 409)
  assert.equal((await provider.status()).model, undefined)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('Using ChatGPT plan · Account 2')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Save preferences' })).toBeDisabled()
  await store(async host => {
    assert.equal(host.accounts[0].model, 'synthetic')
    assert.equal(host.accounts[1].model, undefined)
  })
  await otherTab.close()
  refreshFailure = 'refresh_token_expired'
  await store(async (host, save) => { host.accounts[1].tokens.expires = 0; await save() })
  await page.reload()
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible()
  const count = refreshed
  assert.equal(count, 2)
  assert.equal((await restored.status()).connected, false)
  await assert.rejects(restored.repairBrief({ category: 'parser_drift', fieldCount: 1 }), { code: 'CHATGPT_RECONNECT' })
  assert.equal(refreshed, count)
  await expect(page.getByRole('button', { name: 'Reconnect Account 2' })).toBeVisible()
})

test('catalog rejects a bearer, refreshes once, and preserves only recoverable grants', async () => {
  const a = { id: 'account', label: 'Account 1', client: 'issued', subject: 'subject', model: 'saved',
    tokens: { access: 'first', refresh: 'rotate', expires: Date.now() + 3600000, identity: 'id',
      scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'] } }
  let host = { host: 'host', active: a.id, accounts: [a] }
  const store = async work => {
    const snapshot = structuredClone(host)
    return work(snapshot, async () => { host = structuredClone(snapshot) })
  }
  const requests = []
  let mode = 'recovered', nextAccess = 0
  const catalog = Response.json({ models: [{ slug: 'saved', display_name: 'Saved', visibility: 'list' }] })
  const fetcher = async (url, init) => {
    if (url.endsWith('/models')) {
      requests.push(init.headers.Authorization)
      if (mode === 'policy') return new Response(null, { status: 403 })
      if (init.headers.Authorization === 'Bearer first') {
        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="catalog", error="invalid_token"' } })
      }
      if (mode === 'confirmed') return Response.json({ error: { code: 'invalid_token' } }, { status: 401 })
      return catalog.clone()
    }
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token')
    requests.push('refresh')
    if (mode === 'transient') return new Response(null, { status: 503 })
    return Response.json({ access_token: 'next' + ++nextAccess, refresh_token: 'rotate' + nextAccess,
      expires_in: 3600, token_type: 'Bearer' })
  }
  const provider = new ChatGPT(store, 'http://127.0.0.1', 0, fetcher)
  assert.equal((await provider.status()).models[0].id, 'saved')
  assert.deepEqual(requests.splice(0), ['Bearer first', 'refresh', 'Bearer next1'])
  host.accounts[0] = structuredClone(a)
  nextAccess = 0; mode = 'transient'
  assert.equal((await provider.status()).connected, true)
  assert.deepEqual(requests.splice(0), ['Bearer first', 'refresh'])
  mode = 'recovered'
  assert.equal((await provider.status()).models[0].id, 'saved')
  assert.deepEqual(requests.splice(0), ['refresh', 'Bearer next1'])
  mode = 'policy'
  assert.equal((await provider.status()).connected, true)
  assert.deepEqual(requests.splice(0), ['Bearer next1'])
  mode = 'confirmed'
  assert.equal((await provider.status()).connected, false)
  assert.deepEqual(requests.splice(0), ['Bearer next1', 'refresh', 'Bearer next2'])
  assert.equal((await provider.status()).active, a.id)
  assert.equal((await provider.status()).model, 'saved')
  assert.deepEqual(requests, [])
})
