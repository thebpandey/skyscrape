import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { checkCampaigns } from './campaigns.mjs'

const [buildDirectory, artifactDirectory] = process.argv.slice(2)
assert(buildDirectory && artifactDirectory, 'Pass the built web directory and browser artifact directory.')
await mkdir(artifactDirectory, { recursive: true })

const server = await preview({
  root: 'apps/web',
  configLoader: 'runner',
  build: { outDir: buildDirectory },
  preview: { host: '127.0.0.1', port: 0, strictPort: true, proxy: {} },
})
const socket = server.httpServer.address()
assert(socket && typeof socket !== 'string')
const origin = `http://127.0.0.1:${socket.port}`

const requestId = 'ba8e741f-ee7a-40cc-bc28-9d2d54491829'
const observationId = '96a99825-0348-4d39-8bf6-987c379599d3'
const analystId = 'e02c5a05-c681-4e54-b79b-5f3540e7604e'
const viewerId = '26db47a5-c0e1-4d76-8e0f-b5a0c3c8b3e1'
const header = { 'Cache-Control': 'no-store', 'X-Request-Id': requestId }
const envelope = (data, nextCursor) => ({
  data, meta: { requestId, schemaVersion: 1, ...(nextCursor ? { nextCursor } : {}) },
})
const types = [
  'Single-family new build', 'Residential addition', 'Single-family new build',
  'Residential remodel', 'Accessory dwelling unit', 'Residential addition', 'Residential remodel',
]
const permits = types.map((permitType, index) => ({
  id: `7fba8c11-04fb-4832-8b1c-00000000000${index}`,
  permitNumber: 'S-2026-0' + (142 - index),
  jurisdiction: 'Austin, TX',
  rawStatus: index === 4 ? null : index === 1 ? 'FINAL' : 'ISSUED',
  status: index === 4 ? null : index === 1 ? 'Final' : 'Issued',
  rawType: permitType.toUpperCase(),
  permitType,
  issuedOn: index === 4 ? null : `2026-11-${20 - index}`,
  appliedOn: '2026-11-06',
  evidenceIds: index === 4 ? [] : [observationId],
  contacts: [],
}))
const observation = {
  id: observationId, sourceName: 'Austin permit register · synthetic fixture', sourceVersion: 1,
  eventDate: '2026-11-20', sourceModifiedAt: null, fetchedAt: '2026-11-21T15:42:00Z',
  extractorVersion: 'fixture-parser 1.2.0',
  fields: [
    { recordId: permits[0].id, field: 'rawStatus', acceptance: 'verified', relation: 'supports' },
    { recordId: permits[0].id, field: 'status', acceptance: 'corroborated', relation: 'supports' },
    { recordId: permits[0].id, field: 'permitType', acceptance: 'stale', relation: 'supports' },
    { recordId: permits[1].id, field: 'unrelated-record-field', acceptance: 'inferred', relation: 'supports' },
  ],
}

async function mount(page, { role = 'analyst', authenticated = true, sharedState } = {}) {
  const state = sharedState ?? { authenticated, role, failNextList: false, denyEvidence: false, evidenceRequests: 0 }
  page.on('pageerror', error => { state.pageError = error.message })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    assert.equal(url.origin, origin)
    function respond(data, status = 200, cursor) {
      return route.fulfill({ status, headers: header, json: envelope(data, cursor) })
    }
    function reject(status, code) {
      return route.fulfill({
        status, headers: header, json: { error: { code, message: 'Synthetic failure', retryable: false, requestId } },
      })
    }

    switch (url.pathname) {
      case '/api/auth/sign-in/email': {
        assert.equal(request.method(), 'POST')
        const body = request.postDataJSON()
        assert(['analyst@example.test', 'viewer@example.test'].includes(body.email))
        assert.equal(body.rememberMe, false)
        if (body.password !== 'Synthetic valid password') return reject(401, 'UNAUTHORIZED')
        state.authenticated = true
        state.role = body.email === 'viewer@example.test' ? 'viewer' : 'analyst'
        return route.fulfill({ status: 204, headers: header })
      }
      case '/api/auth/sign-out':
        assert.equal(request.method(), 'POST')
        state.authenticated = false
        return route.fulfill({ status: 204, headers: header })
    }
    if (!state.authenticated) return reject(401, 'UNAUTHORIZED')
    if (url.pathname === '/api/v1/me') {
      const scopes = ['records:read', 'evidence:read', 'runs:read', 'sources:read', 'analytics:read', 'issues:read']
      if (state.role === 'analyst') scopes.push('exports:read', 'research:create')
      return respond({
        id: state.role === 'viewer' ? viewerId : analystId, role: state.role, kind: 'session',
        scopes: state.scopesOverride ?? scopes,
      })
    }
    if (url.pathname === '/api/v1/records') {
      if (state.failNextList) {
        state.failNextList = false
        return reject(503, 'TEMPORARY_FAILURE')
      }
      const number = url.searchParams.get('permitNumber')
      const jurisdiction = url.searchParams.get('jurisdiction')
      const authorized = state.role === 'viewer' && state.limitViewerRecords ? permits.slice(1) : permits
      const selected = authorized.filter(permit =>
        (!number || number === permit.permitNumber) && (!jurisdiction || jurisdiction === permit.jurisdiction))
      return respond(selected)
    }
    if (url.pathname.startsWith('/api/v1/records/')) {
      const permit = permits.find(permit => url.pathname === `/api/v1/records/${permit.id}`)
      return permit ? respond(permit) : reject(404, 'NOT_FOUND')
    }
    if (url.pathname === `/api/v1/evidence/${observationId}`) {
      state.evidenceRequests += 1
      return state.denyEvidence ? reject(403, 'FORBIDDEN') : respond(observation)
    }
    return reject(404, 'NOT_FOUND')
  })
  return state
}

async function deferSessionCheck(page) {
  const sessionEndpoint = '**/api/v1/me'
  const released = Promise.withResolvers()
  await page.route(sessionEndpoint, async route => {
    await released.promise
    await route.fallback()
  }, { times: 1 })
  return { requested: page.waitForRequest(sessionEndpoint, { timeout: 5000 }), release: released.resolve }
}

async function screenshot(page, name) {
  if (process.env.SHELL_SCREENSHOTS !== '0') {
    await page.screenshot({ path: join(artifactDirectory, name + '.png'), animations: 'disabled' })
  }
}

async function checkAxe(page, name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  assert.deepEqual(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })), [], name)
}

async function checkContrast(page, theme) {
  // Axe opens a page during its scan. A real tab return revalidates evidence.
  await expect(page.locator('.trace dd').first()).toBeVisible()
  const ratios = await page.evaluate(() => {
    const styles = selector => getComputedStyle(document.querySelector(selector))
    const luminance = color => color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(channel => {
      const value = Number(channel) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const pairs = [
      ['h1', 'body'],
      ['.workspace-nav a', '.rail'],
      ['.primary', '.primary'],
      ['.panel-head .muted', '.results-panel'],
      ['thead th', 'thead th'],
      ['tr[data-selected] .permit-link span', 'tr[data-selected] th'],
      ['.trace dd', '.trace'],
      ['[data-acceptance="stale"]', '.evidence-pane'],
    ]
    return pairs.map(([text, surface]) => {
      const foreground = luminance(styles(text).color)
      const background = luminance(styles(surface).backgroundColor)
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    })
  })
  const minimum = Math.min(...ratios)
  assert(minimum >= 4.5, theme + ' sampled text contrast')
  console.log(`${theme} desktop sampled text contrast: ${minimum.toFixed(2)}:1 minimum across ${ratios.length} pairs.`)
}

async function assertTheme(page, name) {
  const background = name === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'
  await expect(page.locator('html')).toHaveAttribute('data-theme', name)
  await expect(page.locator('body')).toHaveCSS('background-color', background)
}

let browser
let physicalTabs
try {
  browser = await chromium.launch({ executablePath: process.env.SHELL_CHROME ?? '/usr/bin/google-chrome', headless: true })
  if (process.env.SHELL_BROWSER_CDP) {
    physicalTabs = await chromium.connectOverCDP(process.env.SHELL_BROWSER_CDP, { noDefaults: true })
  }
  const desktop = physicalTabs?.contexts()[0] ?? await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const wide = await desktop.newPage()
  await wide.setViewportSize({ width: 1440, height: 960 })
  const wideState = await mount(wide, { authenticated: false })
  await wide.goto(origin + '/records')
  await expect(wide.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await screenshot(wide, 'sign-in-light-synthetic')
  await wide.getByLabel('Email').fill('analyst@example.test')
  await wide.getByLabel('Password').fill('Synthetic wrong password')
  await wide.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(wide.getByRole('alert')).toContainText('Check your email and password')
  await wide.getByLabel('Password').fill('Synthetic valid password')
  await wide.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(wide.getByRole('heading', { name: 'Permit Register' })).toBeVisible()
  await assertTheme(wide, 'light')

  const firstRow = wide.getByRole('button', { name: /S-2026-0142/ })
  await firstRow.focus()
  await firstRow.press('Enter')
  const evidencePane = wide.getByRole('complementary', { name: 'Field evidence' })
  await expect(evidencePane).toContainText('Austin permit register · synthetic fixture')
  await expect(evidencePane).toContainText('Original value')
  await expect(evidencePane).toContainText('Accepted value')
  await expect(evidencePane).toContainText('stale · supports')
  await expect(evidencePane).not.toContainText('unrelated-record-field')
  await expect(wide.getByRole('heading', { name: 'Field evidence' })).toBeFocused()
  const geometries = await wide.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    const table = box('.results-panel')
    const pane = box('.evidence-pane')
    return { tableEdge: table.right, evidenceEdge: pane.left, tableY: table.top, evidenceY: pane.top,
      evidenceBottom: pane.bottom, rowHeight: box('tbody tr').height,
      documentWidth: document.documentElement.scrollWidth }
  })
  assert(geometries.tableEdge < geometries.evidenceEdge)
  assert.equal(geometries.tableY, geometries.evidenceY)
  assert(geometries.evidenceBottom <= 960)
  assert.equal(geometries.rowHeight, 52)
  assert.equal(geometries.documentWidth, 1440)
  await screenshot(wide, 'register-light-synthetic')
  await checkAxe(wide, 'light desktop')
  await checkContrast(wide, 'Light')
  const secondRow = wide.getByRole('button', { name: /S-2026-0141/ })
  await secondRow.press('Enter')
  await expect(evidencePane).toContainText('S-2026-0141')
  await wide.goBack()
  await expect(evidencePane).toContainText('S-2026-0142')
  await expect(wide.getByRole('heading', { name: 'Field evidence' })).toBeFocused()
  await wide.keyboard.press('Escape')
  await expect(firstRow).toBeFocused()

  await wide.keyboard.press('Control+k')
  const command = wide.getByRole('dialog', { name: 'Search workspace' })
  await expect(command).toBeVisible()
  await command.getByLabel('Exact permit number').fill('S-2026-0142')
  await command.getByRole('button', { name: 'Find permit' }).click()
  await expect(wide).toHaveURL(/permitNumber=S-2026-0142/)
  await expect(wide.getByRole('row')).toHaveCount(2)
  await wide.getByRole('button', { name: 'Clear filters' }).click()
  await expect(wide.getByRole('row')).toHaveCount(8)

  await wide.getByRole('radio', { name: 'Dark' }).click()
  await assertTheme(wide, 'dark')
  await wide.reload()
  await assertTheme(wide, 'dark')
  await firstRow.click()
  await expect(evidencePane).toContainText('Austin permit register · synthetic fixture')
  await screenshot(wide, 'register-dark-synthetic')
  await checkAxe(wide, 'dark desktop')
  await checkContrast(wide, 'Dark')
  await wide.emulateMedia({ colorScheme: 'light' })
  await assertTheme(wide, 'dark')
  await wide.getByRole('radio', { name: 'System' }).click()
  await assertTheme(wide, 'light')
  await wide.emulateMedia({ colorScheme: 'dark' })
  await assertTheme(wide, 'dark')
  await wide.getByRole('radio', { name: 'Light' }).click()
  await assertTheme(wide, 'light')

  await wide.getByLabel('Permit number', { exact: true }).fill('S-NONEXISTENT')
  await wide.getByRole('button', { name: 'Find permits' }).click()
  await expect(wide.getByRole('heading', { name: 'No permits found' })).toBeVisible()
  await screenshot(wide, 'empty-light-synthetic')
  wideState.failNextList = true
  await wide.getByRole('button', { name: 'Clear filters' }).click()
  await expect(wide.getByRole('alert')).toContainText(requestId)
  await screenshot(wide, 'error-light-synthetic')
  await wide.getByRole('button', { name: 'Try again' }).click()
  await expect(firstRow).toBeVisible()
  await wide.getByRole('link', { name: 'Campaigns' }).click()
  await expect(wide.getByRole('heading', { name: 'Read-only access' })).toBeVisible()

  await wide.goto(origin + '/records/permit/' + permits[0].id + '?permitNumber=' + permits[0].permitNumber)
  await expect(evidencePane).toContainText('Austin permit register · synthetic fixture')
  await expect(wide.getByRole('link', { name: 'Exports' })).toBeVisible()
  await wide.keyboard.press('Control+k')
  const helpCommand = command.getByRole('button', { name: 'Help' })
  await helpCommand.focus()
  const otherTab = await desktop.newPage()
  async function activate(tab) {
    await tab.bringToFront()
    if (!physicalTabs) await tab.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  async function switchAway() {
    await otherTab.bringToFront()
    if (!physicalTabs) await wide.evaluate(() => window.dispatchEvent(new Event('blur')))
    else await expect.poll(() => wide.evaluate(() => document.visibilityState)).toBe('hidden')
  }
  await activate(wide)
  await command.getByLabel('Exact permit number').fill('unsaved synthetic search')
  await helpCommand.focus()
  for (let round = 0; round < 2; round++) {
    await switchAway()
    const samePrincipal = await deferSessionCheck(wide)
    try {
      await activate(wide)
      await samePrincipal.requested
      await expect(wide.locator('.desktop-rail')).toBeVisible()
      await expect(wide.locator('.breadcrumbs')).toBeVisible()
      await expect(wide.locator('.desktop-rail')).toHaveAttribute('inert', '')
      await expect(wide.getByText('Checking your session…')).toHaveCount(0)
      await expect(command).not.toBeVisible()
      await expect(evidencePane).not.toBeVisible()
    } finally {
      samePrincipal.release()
    }
    await expect(command.getByLabel('Exact permit number')).toHaveValue('unsaved synthetic search')
    await expect(helpCommand).toBeFocused()
  }
  await expect(helpCommand).toBeFocused()
  await expect(wide).toHaveURL(new RegExp(permits[0].id + '\\?permitNumber='))
  await wide.keyboard.press('Escape')
  await expect(command).not.toBeVisible()

  await wide.setViewportSize({ width: 1440, height: 480 })
  const draft = wide.getByLabel('Jurisdiction', { exact: true })
  await draft.fill('unsaved synthetic jurisdiction')
  const scroll = await wide.evaluate(() => {
    window.scrollTo(0, 125)
    return window.scrollY
  })
  assert(scroll > 0)
  await switchAway()
  const failedCheck = await deferSessionCheck(wide)
  await activate(wide)
  await failedCheck.requested
  await expect(wide.locator('.desktop-rail')).toBeVisible()
  assert.equal(await wide.evaluate(() => window.scrollY), scroll)
  try {
    await expect(wide.getByRole('alert')).toContainText('Couldn’t load your session', { timeout: 15_000 })
    await expect(evidencePane).not.toBeVisible()
    await expect(wide.getByRole('heading', { name: 'Sign in' })).not.toBeVisible()
  } finally {
    failedCheck.release()
  }
  await wide.getByRole('button', { name: 'Try again' }).click()
  await expect(draft).toHaveValue('unsaved synthetic jurisdiction')
  await expect.poll(() => wide.evaluate(() => window.scrollY)).toBe(scroll)
  await expect(evidencePane).toContainText('Austin permit register')
  await wide.setViewportSize({ width: 1440, height: 960 })

  // Hold an already-authorized analyst response across a second tab's role change.
  const stale = Promise.withResolvers()
  await wide.route('**/api/v1/me', async route => {
    await stale.promise
    await route.fulfill({ json: envelope({ id: analystId, role: 'analyst', kind: 'session',
      scopes: ['records:read', 'exports:read', 'evidence:read'] }) })
  }, { times: 1 })
  const pending = wide.waitForRequest('**/api/v1/me')
  await wide.evaluate(() => window.dispatchEvent(new Event('focus')))
  await pending
  await wide.evaluate(() => window.dispatchEvent(new Event('blur')))
  await mount(otherTab, { sharedState: wideState })
  await otherTab.goto(origin + '/records')
  await otherTab.bringToFront()
  await otherTab.getByRole('button', { name: 'Sign out' }).click()
  await otherTab.getByLabel('Email').fill('viewer@example.test')
  await otherTab.getByLabel('Password').fill('Synthetic valid password')
  wideState.limitViewerRecords = true
  await otherTab.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(otherTab.getByRole('heading', { name: 'Permit Register' })).toBeVisible()
  const changedPrincipal = await deferSessionCheck(wide)
  try {
    await activate(wide)
    await changedPrincipal.requested
    stale.resolve()
    await expect(wide.locator('.desktop-rail')).toBeVisible()
    await screenshot(wide, 'session-revalidation-synthetic')
    await expect(wide.getByText('Checking your session…')).toHaveCount(0)
    await expect(evidencePane).not.toBeVisible()
    await expect(wide.getByRole('link', { name: 'Exports' })).not.toBeVisible()
    const shortcutUnhandled = await wide.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, cancelable: true,
    })))
    assert.equal(shortcutUnhandled, true)
    await expect(command).not.toBeVisible()
  } finally {
    changedPrincipal.release()
  }
  await expect(wide.getByText('Viewer', { exact: true })).toBeVisible()
  await expect(command).not.toBeVisible()
  await expect(wide).toHaveURL(origin + '/records')
  await expect(evidencePane).toContainText('Select a permit')
  await expect(wide.getByRole('link', { name: 'Exports' })).toHaveCount(0)
  await expect(secondRow).toBeVisible()
  await expect(firstRow).toHaveCount(0)
  await assertTheme(wide, 'light')

  await switchAway()
  wideState.scopesOverride = ['records:read']
  await activate(wide)
  await expect(wide.getByRole('link', { name: 'Sources' })).toHaveCount(0)
  await secondRow.click()
  await expect(evidencePane.getByRole('alert')).toContainText('Access denied')
  await otherTab.close()
  console.log('Pending session checks retained the rail and breadcrumbs and concealed evidence and search. Two returns retained the draft and focus. Changed authority reset the route and records.')

  await wide.getByRole('button', { name: 'Sign out' }).click()
  await expect(wide.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  assert.equal(wideState.authenticated, false)
  assert.equal(wideState.pageError, undefined)
  await desktop.close()
  console.log('Desktop sign-in, sign-out, navigation, filters, desktop evidence focus, empty/error recovery, and light/dark/System persistence passed.')

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' })
  const narrow = await mobile.newPage()
  const narrowState = await mount(narrow, { role: 'viewer' })
  await narrow.goto(origin + '/records')
  await expect(narrow.getByRole('heading', { name: 'Permit Register' })).toBeVisible()
  const narrowRow = narrow.getByRole('button', { name: /S-2026-0142/ })
  await expect(narrowRow).toBeVisible()
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth), 390)
  assert(await narrow.getByRole('region', { name: 'Permit results' }).evaluate(node => node.scrollWidth > node.clientWidth))
  await screenshot(narrow, 'register-narrow-light-synthetic')
  await narrow.getByRole('button', { name: 'Open navigation' }).click()
  const navigation = narrow.getByRole('dialog', { name: 'Workspace' })
  await expect(navigation.getByRole('link', { name: 'Exports' })).toHaveCount(0)
  await navigation.getByRole('radio', { name: 'Dark' }).click()
  await assertTheme(narrow, 'dark')
  await navigation.getByRole('button', { name: 'Close navigation' }).click()
  await expect(narrow.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  await screenshot(narrow, 'register-narrow-dark-synthetic')

  await narrowRow.focus()
  await narrowRow.press('Enter')
  const drawer = narrow.getByRole('dialog', { name: 'Field evidence' })
  await expect(drawer).toContainText('Austin permit register · synthetic fixture')
  await drawer.getByRole('button', { name: 'Close field evidence' }).press('Tab')
  assert(await drawer.evaluate(node => node.contains(document.activeElement)), 'Focus stays in the evidence dialog')
  await screenshot(narrow, 'evidence-narrow-dark-synthetic')
  await checkAxe(narrow, 'dark narrow evidence dialog')
  await narrow.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(narrowRow).toBeFocused()
  await narrow.goto(origin + '/exports')
  await expect(narrow.getByRole('alert')).toContainText('Access denied')
  narrowState.denyEvidence = true
  await narrow.goto(origin + '/records/permit/' + permits[0].id + '?permitNumber=' + permits[1].permitNumber)
  await expect(narrow.getByRole('alert')).toContainText('Access denied')
  assert(narrowState.evidenceRequests >= 2)
  await narrow.getByRole('button', { name: 'Close field evidence' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(narrow.getByRole('heading', { name: 'Accepted permits' })).toBeFocused()
  narrowState.authenticated = false
  const expiringSearch = narrow.getByLabel('Permit number', { exact: true })
  await expiringSearch.fill('S-2026-0142')
  await expiringSearch.press('Enter')
  await expect(narrow).toHaveURL(/permitNumber=S-2026-0142/)
  await expect(narrow.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(narrow.getByRole('status')).toContainText('Your session expired')
  await expect(narrow.getByRole('table')).toHaveCount(0)
  assert.equal(narrowState.pageError, undefined)
  await mobile.close()
  await checkCampaigns(browser, origin, mount, { observationId, permit: permits[0], envelope })
  console.log('Narrow navigation, both themes, responsive table and modal, focus containment/restoration, and unauthorized states passed.')
  console.log('Axe WCAG A/AA scans passed for desktop light, desktop dark, and narrow evidence. Browser data was synthetic.')
} finally {
  await physicalTabs?.close()
  await browser?.close()
  await server.close()
}
