import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'

// Same-origin HTTP fixtures. Source eligibility, sign-in and CSV bytes here are synthetic.
export async function checkCampaigns(browser, origin, mount, { observationId, permit, envelope }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  try {
    const page = await ctx.newPage()
    const state = await mount(page)
    state.scopesOverride = ['campaigns:write', 'runs:create', 'runs:read', 'schedules:write',
      'records:read', 'evidence:read', 'exports:create', 'exports:read']
    const id = '11a2fdb1-25c6-4ff0-b707-59d4e735731e'
    const runId = '11a2fdb1-25c6-4ff0-b707-59d4e735731f'
    const retryEvidence = '11a2fdb1-25c6-4ff0-b707-59d4e7357322'
    const partialCsv = 'evidenceId,permitNumber\r\n' + observationId + ',' + permit.permitNumber + '\r\n'
    const csv = partialCsv + retryEvidence + ',SYN-RETRIED\r\n'
    const catalog = [
      ['land_buyer_discovery', 'Land-buyer discovery'], ['builder_activity', 'Builder activity'],
      ['institutional_sfr_acquisition_research', 'Institutional SFR acquisition research'],
      ['permit_monitoring', 'Permit monitoring'], ['ownership_transfer_lookup', 'Ownership/transfer lookup'],
      ['land_sfr_listing_watch', 'Land/SFR listing watch'], ['market_snapshot', 'Market snapshot'],
      ['contact_enrichment', 'Contact enrichment'], ['source_gap_investigation', 'Source-gap investigation'],
      ['custom_research', 'Custom research'],
    ].map(([id, title]) => ({ id, title, aliases: [], settings: id === 'builder_activity'
      ? { participantRole: { kind: 'choice', options: ['any', 'builder'], default: 'any' } }
      : id === 'permit_monitoring' ? {
        windowDays: { kind: 'integer', min: 1, max: 3650, default: 90 },
        maxResults: { kind: 'integer', min: 1, max: 1000, default: 100 },
        status: { kind: 'text', maxLength: 128, default: '' },
      } : {} }))
    let draft
    let version = 0
    let polls = 0
    let failCampaignRefresh = false
    let exportRequests = 0
    const keys = []
    const taskRetryKeys = []
    let failedTasks = true
    const saveResponse = Promise.withResolvers()
    const csvResponse = Promise.withResolvers()
    const scheduledRun = '11a2fdb1-25c6-4ff0-b707-59d4e7357320'
    let history = []
    let campaignState = 'draft'
    const creations = new Map()
    let holdDownload = false
    let scheduled
    let denyDownload = true
    let sampleVisible = true
    let rejectCoverage = false
    let lastPreview
    await page.route('**/api/v1/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname.slice('/api/v1/'.length)
      const ok = (data, status = 200) => route.fulfill({ status, json: envelope(data) })
      const reject = (status, code = 'FIXTURE_DENIED') => route.fulfill({ status, json: { error: { code,
        message: 'Synthetic failure', retryable: false, requestId: id } } })
      if (path === 'campaigns/templates') return ok(catalog)
      if (path === 'campaigns/preview') {
        lastPreview = request.postDataJSON()
        const eligible = lastPreview.template === 'permit_monitoring' && lastPreview.geography.countyFips.includes('53033') && !lastPreview.assetTypes.length
        return ok({ activationEligible: eligible || lastPreview.template === 'source_gap_investigation', sources: eligible ? [{ id, name: 'Synthetic permit feed', synthetic: true, coverage: 'City limits' }] : [],
          coveredCountyFips: eligible ? ['53033'] : [], coverageGaps: eligible ? ['No municipal coverage for county 53061.'] : [],
          criteria: lastPreview.criteria, asOf: '2027-01-01',
          sample: eligible && sampleVisible ? [{ evidenceIds: [observationId], fields: { permitNumber: permit.permitNumber } }] : [],
          unsupportedFields: eligible ? [] : lastPreview.requestedFields,
          limits: lastPreview.limits, llmConfigured: false, occurrences: lastPreview.timing.mode !== 'instant' ?
            [{ utc: '2027-01-01T14:00:00Z', local: '2027-01-01 08:00', timezone: lastPreview.timing.timezone }] : [] })
      }
      if (path === 'campaigns' || path === 'campaigns/' + id) {
        if (request.method() === 'GET' && path === 'campaigns') {
          if (!draft) return ok([])
          if (url.searchParams.get('after') === scheduledRun) return ok([{ id, title: draft.title, version, state: campaignState }])
          return route.fulfill({ json: envelope([{ id: scheduledRun, title: 'Recent campaign', version: 1, state: 'draft' }], scheduledRun) })
        }
        if (request.method() === 'GET' && failCampaignRefresh) return reject(503)
        if (request.method() === 'GET') return ok({ id, version, state: campaignState, draft })
        const body = request.postDataJSON()
        if (request.method() === 'POST') {
          const key = request.headers()['idempotency-key']
          assert.ok(key)
          if (!creations.has(key)) {
            draft = body
            creations.set(key, { id, version: ++version, state: campaignState })
            if (creations.size === 1) return route.abort('connectionreset')
          }
          if (JSON.stringify(body) !== JSON.stringify(draft)) return reject(409, 'IDEMPOTENCY_CONFLICT')
          return ok(creations.get(key), 201)
        } else {
          assert.notEqual(campaignState, 'active')
          assert.equal(body.version, version)
        }
        await saveResponse.promise
        draft = body.draft ?? body
        return ok({ id, version: ++version, state: campaignState })
      }
      if (path === 'campaigns/' + id + '/schedule') {
        const activation = request.postDataJSON()
        if (activation.version !== version) return reject(409, 'VERSION_CONFLICT')
        if (campaignState === 'active') return reject(409, 'ACTIVE_SCHEDULE')
        scheduled = activation.timing
        assert.deepEqual(scheduled, draft.timing)
        campaignState = 'active'
        return ok({ id: scheduledRun, version: ++version, state: 'active', nextDueAt: '2027-01-01T14:00:00Z' })
      }
      if (path === 'campaigns/' + id + '/pause') {
        campaignState = 'paused'
        return ok({ id: scheduledRun, state: campaignState })
      }
      if (path === 'campaigns/' + id + '/runs') {
        if (request.method() === 'GET') return ok(history)
        assert.deepEqual(request.postDataJSON(), { version })
        assert.deepEqual(lastPreview, draft)
        if (rejectCoverage) return reject(409, 'NO_QUALIFIED_SOURCE')
        keys.push(request.headers()['idempotency-key'])
        return keys.length === 1 ? reject(503) : ok({ runId }, 202)
      }
      if (path === 'runs/' + scheduledRun) return ok({ id: scheduledRun, campaignId: id, campaignVersion: version,
        trigger: 'scheduled', state: 'running', tasks: {}, counters: {}, coverageGaps: [], unsupportedFields: [], synthetic: true })
      if (path === 'runs/' + runId + '/retry') {
        assert.equal(request.method(), 'POST')
        taskRetryKeys.push(request.headers()['idempotency-key'])
        if (taskRetryKeys.length === 1) return reject(503)
        failedTasks = false
        return ok({ runId }, 202)
      }
      if (path === 'runs/' + runId) return ok({ id: runId, campaignId: id, campaignVersion: version, trigger: 'manual',
        state: ++polls === 1 ? 'running' : failedTasks ? 'partial' : 'completed', tasks: { completed: 1, failed: Number(failedTasks) }, counters: { pages: 1 },
        coverageGaps: [], unsupportedFields: [], errorCode: null, synthetic: true })
      if (path === 'runs/' + runId + '/results') return ok([{ resultId: id, classification: 'permit_event', date: null, evidenceIds: [observationId], recordId: permit.id,
        fields: { permitNumber: permit.permitNumber } },
        ...(failedTasks ? [] : [{ resultId: scheduledRun, classification: 'permit_event', date: null, evidenceIds: [retryEvidence],
          recordId: scheduledRun, fields: { permitNumber: 'SYN-RETRIED' } }])])
      if ([observationId, retryEvidence].some(ref => path === 'runs/' + runId + '/evidence/' + ref)) return ok({ id: path.split('/').at(-1), sourceName: 'Synthetic permit feed',
        sourceRecordId: path.endsWith(retryEvidence) ? 'SYN-RETRIED' : permit.permitNumber, sourceUrl: null, fieldLocators: { permitNumber: 'permitnum' }, eventDate: null, fetchedAt: '2027-01-01T14:00:00Z', extractorVersion: failedTasks ? 'fixture-partial' : 'fixture-parser', acceptance: 'verified' })
      if (path === 'runs/' + runId + '/exports') {
        exportRequests++
        return ok({ id: failedTasks ? scheduledRun : id, rowCount: failedTasks ? 1 : 2,
          sha256: createHash('sha256').update(failedTasks ? partialCsv : csv).digest('hex'), expiresAt: '2027-01-02T00:00:00Z' }, 201)
      }
      if (path === 'exports/' + scheduledRun + '/download') return route.fulfill({ contentType: 'text/csv', body: partialCsv })
      if (path === 'exports/' + id + '/download') {
        if (holdDownload) await csvResponse.promise
        return denyDownload ? reject(403) : route.fulfill({ contentType: 'text/csv', body: csv })
      }
      return route.fallback()
    })
    const gapId = '11a2fdb1-25c6-4ff0-b707-59d4e7357321'
    await page.route('**/campaigns/' + gapId, route => route.fulfill({ json: envelope({ id: gapId,
      state: 'draft', version: 1, draft: { title: 'Uncovered county', template: 'source_gap_investigation',
        geography: { countyFips: ['53061'] }, assetTypes: [], requestedFields: ['countyFips'],
        limits: { maxPages: 1, maxMinutes: 1, maxLlmCalls: 0 }, timing: { mode: 'instant' },
        sourcePolicy: { freeOnly: true, allowHostedFreeTiers: false } } }) }))
    await page.route('**/campaigns/' + gapId + '/runs', route => route.fulfill({
      json: envelope(route.request().method() === 'POST' ? { runId: scheduledRun } : []),
    }))
    await page.goto(origin + '/campaigns?draft=' + gapId)
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText('No eligible sources for this template and geography.')).toBeVisible()
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page).toHaveURL(origin + '/runs/' + scheduledRun)
    await page.goto(origin + '/campaigns')
    await expect(page.locator('.template-catalog a')).toHaveCount(10)
    await page.getByRole('link', { name: /Builder activity/ }).click()
    await page.getByLabel('Participant role').selectOption('builder')
    await page.getByLabel('County FIPS codes').fill('00000')
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText('No eligible sources for this template and geography.')).toBeVisible()
    assert.equal(lastPreview.criteria.participantRole, 'builder')
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0)
    await page.getByRole('link', { name: 'Campaign templates' }).click()
    await page.getByRole('link', { name: /Permit monitoring/ }).click()
    await page.getByLabel('County FIPS codes').fill('53033, 53061')
    await page.getByLabel('Lookback (days)').fill('14')
    await page.getByLabel('Maximum results').fill('3')
    await page.getByLabel('Status', { exact: true }).fill('Issued')
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByRole('alert')).toContainText('Request failed')
    await page.getByLabel('Title', { exact: true }).fill('Edited Seattle permits')
    await page.route('**/api/v1/me', route => route.fulfill({ status: 503, body: '' }), { times: 1 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('alert')).toContainText('your session')
    await expect(page.getByRole('heading', { name: 'Permit monitoring' })).toBeHidden()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Edited Seattle permits')
    const pendingSave = page.waitForRequest(req => req.method() === 'PATCH' && req.url().endsWith('/campaigns/' + id))
    await page.getByRole('button', { name: 'Save draft' }).click()
    await pendingSave
    const verify = Promise.withResolvers()
    await page.route('**/api/v1/me', async route => { await verify.promise; await route.fallback() }, { times: 1 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('Verifying access…')).toBeVisible()
    const created = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().endsWith('/campaigns/' + id))
    saveResponse.resolve()
    await (await created).finished()
    await expect(page).toHaveURL(/template=permit_monitoring/)
    verify.resolve()
    await expect(page).toHaveURL(origin + '/campaigns?draft=' + id)
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
    assert.equal(creations.size, 1)
    assert.equal(draft.title, 'Edited Seattle permits')
    assert.equal(version, 2)
    await expect(page.getByLabel('County FIPS codes')).toHaveValue('53033, 53061')
    assert.deepEqual(draft.criteria, { windowDays: 14, maxResults: 3, status: 'Issued' })
    await expect(page.getByLabel('Lookback (days)')).toHaveValue('14')
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText('Synthetic permit feed')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Coverage preview' })).toContainText(permit.permitNumber)
    await expect(page.getByText('No municipal coverage for county 53061.')).toBeVisible()
    assert.deepEqual(lastPreview, draft)
    sampleVisible = false
    const renewed = page.waitForResponse('**/api/v1/me')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await renewed
    await expect(page.getByRole('button', { name: 'Preview coverage' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Coverage preview' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText('No matching stored sample is available.')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Coverage preview' })).not.toContainText(permit.permitNumber)
    await page.getByLabel('Title', { exact: true }).fill('Unsaved local title')
    failCampaignRefresh = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('alert')).toContainText('Couldn’t load campaigns')
    const title = page.getByLabel('Title', { exact: true })
    await expect(title).toHaveValue('Unsaved local title')
    failCampaignRefresh = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(title).toHaveValue('Unsaved local title')
    await page.getByLabel('Frequency').selectOption('daily')
    await expect(page.getByRole('region', { name: 'Coverage preview' })).toHaveCount(0)
    await page.getByLabel('Time zone').fill('America/Chicago')
    await page.getByRole('button', { name: 'Save draft' }).click()
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText(/2027-01-01 08:00.*14:00:00Z/)).toBeVisible()
    const previewVersion = version
    draft = { ...draft, limits: { ...draft.limits, maxPages: 9 } }
    version++
    const stale = page.waitForResponse('**/schedule')
    await page.getByRole('button', { name: 'Activate schedule' }).click()
    const conflict = await stale
    assert.equal(conflict.request().postDataJSON().version, previewVersion)
    assert.equal(conflict.status(), 409)
    await expect(page.getByRole('alert')).toContainText('saved campaign changed')
    assert.equal(campaignState, 'draft')
    await page.reload()
    await expect(page.getByLabel('Maximum pages')).toHaveValue('9')
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await expect(page.getByText(/Maximum work · 9 pages/)).toBeVisible()
    await page.getByRole('button', { name: 'Activate schedule' }).click()
    await expect(page.getByText(/Schedule active/)).toBeVisible()
    assert.equal(scheduled.frequency, 'daily')
    await expect(page.getByLabel('Maximum pages')).toBeDisabled()
    await page.getByRole('link', { name: 'Campaign templates' }).click()
    await page.getByRole('button', { name: 'More campaigns' }).click()
    await page.getByRole('region', { name: 'Saved campaigns' }).getByRole('link', { name: draft.title }).click()
    history = [{ id: scheduledRun, state: 'running', createdAt: '2027-01-01T14:00:00Z' }]
    await page.getByRole('button', { name: 'Refresh runs' }).click()
    await page.getByRole('link', { name: /Running · 2027/ }).click()
    await expect(page).toHaveURL(origin + '/runs/' + scheduledRun)
    await page.getByRole('link', { name: 'Open saved campaign' }).click()
    await expect(page.getByLabel('Maximum pages')).toBeDisabled()
    await page.getByRole('button', { name: 'Pause schedule' }).click()
    await expect(page.getByLabel('Maximum pages')).toBeEnabled()
    await page.getByLabel('Frequency').selectOption('once')
    await page.getByLabel('Start date and time (UTC)').fill('2027-01-01T14:00')
    await page.getByRole('button', { name: 'Save draft' }).click()
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await page.getByRole('button', { name: 'Activate schedule' }).click()
    await expect(page.getByText(/Schedule active/)).toBeVisible()
    campaignState = 'draft'
    await page.getByRole('button', { name: 'Refresh runs' }).click()
    await expect(page.getByLabel('Maximum pages')).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Pause schedule' })).toHaveCount(0)
    await page.getByLabel('Frequency').selectOption('instant')
    await page.getByRole('button', { name: 'Save draft' }).click()
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    rejectCoverage = true
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page.getByRole('alert')).toContainText('Preview coverage again')
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0)
    rejectCoverage = false
    await page.getByRole('button', { name: 'Preview coverage' }).click()
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page.getByRole('alert')).toContainText('Request failed')
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page).toHaveURL(origin + '/runs/' + runId)
    assert.ok(keys[0]); assert.deepEqual(keys, [keys[0], keys[0]])
    await expect(page.getByText('Running', { exact: true })).toBeVisible()
    const retryTasks = page.getByRole('button', { name: 'Retry failed tasks' })
    await page.getByRole('button', { name: 'Inspect evidence' }).click()
    await expect(page.getByRole('complementary', { name: 'Result evidence' })).toContainText('fixture-partial')
    await page.getByRole('button', { name: 'Create CSV' }).click()
    await expect(page.getByText(createHash('sha256').update(partialCsv).digest('hex'))).toBeVisible()
    await retryTasks.click()
    await expect(page.getByRole('alert')).toContainText('Request failed')
    await retryTasks.click()
    await expect(page.getByRole('status').filter({ hasText: /^Completed$/ })).toBeVisible()
    assert.ok(taskRetryKeys[0])
    assert.deepEqual(taskRetryKeys, [taskRetryKeys[0], taskRetryKeys[0]])
    await expect(retryTasks).toHaveCount(0)
    await expect(page.getByText('SYN-RETRIED', { exact: true })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Result evidence' })).toContainText('fixture-parser')
    await expect(page.getByRole('complementary', { name: 'Result evidence' })).toContainText('permitnum')
    await page.getByRole('button', { name: 'Create fresh CSV' }).click()
    await expect(page.getByText(createHash('sha256').update(csv).digest('hex'))).toBeVisible()
    await page.getByRole('button', { name: 'Download CSV' }).click()
    await expect(page.getByRole('alert')).toContainText('Access denied')
    denyDownload = false
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download CSV' }).click()
    const contents = []
    for await (const chunk of await (await downloaded).createReadStream()) contents.push(chunk)
    assert.equal(Buffer.concat(contents).toString(), csv)
    holdDownload = true
    const pendingCsv = page.waitForRequest('**/download')
    const cancelled = page.waitForEvent('requestfailed', req => req.url().endsWith('/download'))
    let staleDownloads = 0
    page.on('download', () => staleDownloads++)
    await page.getByRole('button', { name: 'Download CSV' }).click()
    await pendingCsv
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
    const otherWindow = await ctx.newPage()
    await mount(otherWindow, { sharedState: state })
    await otherWindow.goto(origin + '/records')
    await otherWindow.getByRole('button', { name: 'Sign out' }).click()
    await expect(otherWindow.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    csvResponse.resolve()
    await cancelled
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    state.scopesOverride = ['runs:read', 'records:read', 'evidence:read']
    await page.getByLabel('Email').fill('viewer@example.test')
    await page.getByLabel('Password').fill('Synthetic valid password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Viewer', { exact: true })).toBeVisible()
    failedTasks = true
    await page.goto(origin + '/runs/' + runId)
    await expect(page.getByRole('button', { name: 'Inspect evidence' })).toBeVisible()
    await expect(retryTasks).toHaveCount(0)
    await expect(page.getByRole('button', { name: /CSV/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'Open saved campaign' }).click()
    await expect(page.getByRole('link', { name: /Running · 2027/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0)
    assert.equal(staleDownloads, 0)
    assert.equal(exportRequests, 2)
    assert.equal(state.pageError, undefined)
    console.log('Synthetic campaign workflow passed: draft, preview, schedule, run retry, evidence, CSV and viewer access.')
  } finally {
    await ctx.close()
  }
}
