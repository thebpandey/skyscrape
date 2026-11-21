import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const [build, artifacts] = process.argv.slice(2)
assert(build && artifacts, 'Pass a built web directory and a private screenshot directory')
await mkdir(artifacts, { recursive: true })
const server = await preview({ root: 'apps/web', configLoader: 'runner', build: { outDir: resolve(build) },
  preview: { host: '127.0.0.1', port: 0, strictPort: true, proxy: {} } })
const origin = 'http://127.0.0.1:' + server.httpServer.address().port
const requestId = '05316845-29f3-48ea-a070-d02039ece715'
const scopes = ['analytics:read', 'campaigns:write', 'runs:read', 'records:read', 'sources:read', 'evidence:read', 'research:create']
const envelope = data => ({ data, meta: { schemaVersion: 1, requestId } })
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.SHELL_CHROME ?? '/usr/bin/google-chrome', headless: true })
  for (const [mode, width] of [['light', 1250], ['dark', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, colorScheme: mode })
    const page = await context.newPage()
    let failed = false
    let empty = false
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname.slice('/api/v1/'.length)
      const data = {
        me: { id: requestId, kind: 'session', role: 'analyst', scopes, chatgptSettings: true },
        overview: { since: '2026-10-01T00:00:00Z', asOf: '2026-10-31T00:00:00Z', permits: empty ? 0 : 3,
          observations: empty ? 0 : 4, sources: empty ? [] : [{ source: 'Fixture register', permits: 3, observations: 4 }] },
        campaigns: [{ id: requestId, title: 'Fixture investigation', template: 'custom_research', version: 1, state: 'draft' }],
        ['campaigns/' + requestId + '/runs']: [{ id: requestId, state: 'partial', createdAt: '2026-10-22T12:00:00Z' }],
      }
      if (path === 'overview' && failed) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', requestId } } })
      return route.fulfill({ status: Object.hasOwn(data, path) ? 200 : 404, json: envelope(data[path]) })
    })
    for (const name of ['Overview', 'Research', 'Help']) {
      await page.goto(origin + '/' + name.toLowerCase())
      await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible()
      if (name === 'Overview') await expect(page.getByRole('rowheader', { name: 'Fixture register' })).toBeVisible()
      if (name === 'Research') {
        await expect(page.getByRole('link', { name: /Custom research/ })).toHaveAttribute('href', '/campaigns?template=custom_research')
        await page.getByRole('button', { name: 'Run history for Fixture investigation' }).click()
        await expect(page.getByRole('link', { name: /partial/ })).toHaveAttribute('href', '/runs/' + requestId)
      }
      if (name === 'Help') {
        await page.getByRole('searchbox', { name: 'Search help' }).fill('SSH')
        await expect(page.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings')
        await expect(page.getByRole('status')).toHaveText('1 topic found')
      }
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      assert.deepEqual(violations.map(({ id }) => id), [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: resolve(artifacts, mode + '-' + name + '.png'), fullPage: true })
    }
    failed = true
    await page.goto(origin + '/overview')
    await expect(page.getByRole('alert')).toContainText('Request failed')
    failed = false
    empty = true
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByText(/No qualifying permit evidence/)).toBeVisible()
    await context.close()
  }
  console.log('Synthetic analyst pages passed in light desktop and dark mobile Chromium.')
} finally {
  await browser?.close()
  await server.close()
}
