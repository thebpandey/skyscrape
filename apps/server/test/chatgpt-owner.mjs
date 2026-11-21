// Run with disposable loopback PostGIS credentials from the local integration runner.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildApp } from '../src/app.ts'
import { createUser } from '../src/auth/index.ts'
import { migrate, openDatabase, transaction } from '../../../packages/db/src/index.ts'

test('only the configured analyst session can access the provider in a running workspace', async t => {
  const urls = ['DATABASE_URL', 'MIGRATOR_DATABASE_URL', 'AUTH_DATABASE_URL', 'ADMIN_DATABASE_URL'].map(k => process.env[k])
  for (const url of urls) assert.equal(new URL(url).hostname, '127.0.0.1')
  const [pool, migrator, authPool, adminPool] = urls.map(openDatabase)
  const dir = await mkdtemp(join(tmpdir(), 'sky-chatgpt-owner-'))
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), ...[pool, migrator, authPool, adminPool].map(db => db.end())]))
  await migrate(migrator)
  const emails = [randomUUID() + '@example.invalid', randomUUID() + '@example.invalid']
  const password = randomBytes(32).toString('hex')
  const ids = await transaction(migrator, async client => {
    const ids = []
    for (const email of emails) ids.push(await createUser(client, email, password, 'analyst'))
    return ids
  })
  const origin = 'https://synthetic.example.invalid'
  const app = buildApp({ pool, authPool, adminPool, origin, authSecret: randomBytes(32).toString('hex'),
    keyPepper: randomBytes(32).toString('hex'), masterKey: randomBytes(32),
    chatgpt: { owner: ids[0], dir, port: 1455 } })
  t.after(() => app.close())
  const base = '/api/v1/settings/chatgpt'
  assert.equal((await app.inject({ url: base })).statusCode, 401)
  for (const [i, email] of emails.entries()) {
    const login = await app.inject({ url: '/api/auth/sign-in/email', method: 'POST', headers: { origin }, payload: { email, password } })
    assert.equal(login.statusCode, 204)
    const token = login.cookies.find(c => c.name === '__Secure-better-auth.session_token')
    const cookie = token.name + '=' + token.value
    assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie } })).json().data.chatgptSettings, i ? undefined : true)
    assert.equal((await app.inject({ url: base, headers: { cookie } })).statusCode, i ? 403 : 200)
    assert.equal((await app.inject({ url: base + '/connect', method: 'POST', headers: { cookie, origin: 'https://other.invalid' }, payload: {} })).statusCode, 403)
    if (i) assert.equal((await app.inject({ url: base + '/connect', method: 'POST', headers: { cookie, origin }, payload: {} })).statusCode, 403)
  }
})
