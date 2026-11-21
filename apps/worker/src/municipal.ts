import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, link, unlink } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { CollectionServiceError, createCollectionClient } from '../../../packages/connectors/src/collection-client/index.ts'
import { SEATTLE_PERMITS_SOURCE_ID, normalizeSeattlePermit } from '../../../packages/connectors/src/municipal/index.ts'
import { buildMunicipalTask } from '../../../packages/connectors/src/campaign-sources/index.ts'
import type { TaskResult } from '../../../packages/contracts/src/collection/index.ts'
import type { SourcePlan } from '../../../packages/db/src/campaigns.ts'
import { rowRevision } from './ingest.ts'
import type { PermitPage } from './ingest.ts'

export const pageSize = 6
export const pageBytes = 5_000_000
export const runBytes = 200_000_000

export type PageRequest = {
  runId: string; taskId: string; attemptId: string; offset: number; bytes: number; deadline: Date; source: SourcePlan
  asOf: string; countyFips: string[]; windowDays: number; status: string; remainingResults: number
}
export type PageOutcome =
  | { kind: 'page'; page: PermitPage; partialCode?: string }
  | { kind: 'failed'; code: string; retryable: boolean; bytes?: number }
  | { kind: 'stopped'; reason: 'cancel' | 'policy' | 'lost' | 'deadline' }
export type CollectPage = {
  execute(request: PageRequest, permit: () => Promise<'continue' | 'cancel' | 'policy' | 'lost' | 'deadline'>): Promise<PageOutcome>
  cancel(taskId: string, attemptId: string): Promise<void>
}

function failure(code: string, retryable = false, bytes?: number): PageOutcome {
  return { kind: 'failed', code, retryable, bytes }
}

function hasCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function readArtifact(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw Error('Invalid artifact size')
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw Error('Artifact became shorter')
      offset += bytesRead
    }
    if ((await file.stat()).size !== stat.size) throw Error('Artifact size changed')
    return buffer
  } finally {
    await file.close()
  }
}

function digest(body: Buffer) {
  return createHash('sha256').update(body).digest('hex')
}

async function retainArtifact(directory: string, body: Buffer, sha256: string, storeKey: string) {
  if (storeKey !== sha256 && !(storeKey.startsWith(sha256 + '.') && /^[0-9a-f-]{36}$/.test(storeKey.slice(65))))
    throw Error('Invalid artifact storage key')
  const destination = resolve(directory, storeKey)
  const pending = resolve(directory, `.pending-${randomUUID()}`)
  const file = await open(pending, 'wx', 0o600)
  try {
    try {
      await file.writeFile(body)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(pending, destination)
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || digest(await readArtifact(destination, body.length)) !== sha256) throw error
    }
    const directoryHandle = await open(directory, 'r')
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally {
    await unlink(pending)
  }
}

export function collectionPlan(request: PageRequest) {
  const sourceId = SEATTLE_PERMITS_SOURCE_ID
  const allowedFields = ['permitnum', 'issueddate', 'statuscurrent', 'permittypemapped', 'applieddate']
  const countyFips = request.source.synthetic && request.countyFips.includes('00000') ? ['53033'] : request.countyFips
  const task = buildMunicipalTask({ asOf: request.asOf, windowDays: request.windowDays,
    countyFips, limit: pageSize, eligibleSourceIds: [sourceId], kinds: ['permit'] }, sourceId, {
    ...request, correlationId: request.runId, deadline: request.deadline.toISOString(),
    assessmentId: request.source.assessmentId, allowedFields, byteLimit: request.bytes,
  })
  if (!task || task.mode !== 'structured') throw Error('Municipal source outside campaign scope')
  // Applied dates are also part of the campaign evidence contract.
  task.recipe.fields.push({ field: 'applieddate', key: 'applieddate' })
  const url = new URL(task.url)
  url.searchParams.set('$select', task.recipe.fields.map(field => field.key).join(','))
  // Arbitrary status text is compared locally; simple publisher labels can also narrow the request.
  if (/^[a-z0-9][a-z0-9 /_-]{0,79}$/i.test(request.status)) {
    url.searchParams.set('$where', url.searchParams.get('$where') + ` AND lower(statuscurrent) = '${request.status.toLowerCase()}'`)
  }
  task.url = url.href
  return task
}

export async function readPageResult(result: TaskResult, request: PageRequest, stagingDir: string, artifactDir: string): Promise<PageOutcome> {
  const { counters } = result
  if (counters.requests > 1 || counters.bytes > request.bytes || counters.quotaUnits > 1 || counters.browserSeconds !== 0) {
    return failure('BUDGET_EXCEEDED')
  }
  if (result.taskId !== request.taskId || result.attemptId !== request.attemptId) return failure('INVALID_ARTIFACT')
  const reportedEmpty = result.classification !== 'success' && result.error.code === 'EMPTY_CONTENT'
  if (result.classification !== 'success' && (!result.evidence.length || (result.classification === 'failed' && !reportedEmpty))) {
    return failure(result.error.code, result.error.retryable, counters.bytes)
  }
  const [artifact] = result.evidence
  if (result.evidence.length !== 1 || !/^[a-f0-9]{32}$/.test(artifact.artifactId)
      || artifact.mediaType !== 'application/json' || artifact.bytes > counters.bytes || !result.finalUrl) {
    return failure('INVALID_ARTIFACT', false, counters.bytes)
  }
  const actual = new URL(result.finalUrl)
  const plan = collectionPlan(request)
  const requested = new URL(plan.url)
  if (result.redirects.length || actual.origin + actual.pathname !== requested.origin + requested.pathname ||
      actual.searchParams.toString() !== requested.searchParams.toString() || actual.hash || actual.username || actual.password ||
      result.httpStatus !== 200 || result.responseMediaType !== 'application/json') return failure('POLICY_BLOCKED', false, counters.bytes)
  let bytes: Buffer
  let payload: unknown
  try {
    bytes = await readArtifact(resolve(stagingDir, artifact.artifactId), request.bytes)
    if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) return failure('INVALID_ARTIFACT', false, counters.bytes)
    payload = JSON.parse(bytes.toString('utf8'))
  } catch {
    return failure('INVALID_ARTIFACT', false, counters.bytes)
  }
  if (!Array.isArray(payload) || payload.length > pageSize) return failure('SCHEMA_MISMATCH', false, counters.bytes)
  if ((!payload.length && result.classification !== 'success' && !reportedEmpty) || (payload.length && reportedEmpty))
    return failure('UNCONFIRMED_EMPTY', false, counters.bytes)
  const projected = new Set(plan.recipe.fields.map(field => field.key))
  if (payload.some(row => row && typeof row === 'object' && Object.keys(row).some(key => !projected.has(key))))
    return failure('POLICY_BLOCKED', false, counters.bytes)
  const start = new Date(Date.parse(request.asOf) - (request.windowDays - 1) * 86400000).toISOString().slice(0, 10)
  let incomplete = false
  const records = payload.flatMap((row: unknown) => {
    const permit = normalizeSeattlePermit(row, {
      fetchedAt: result.retrievedAt, evidenceRef: artifact.sha256, evidenceDigest: artifact.sha256,
    })
    if (!permit?.eventDate || !row || typeof row !== 'object') { incomplete = true; return [] }
    const day = permit.eventDate.slice(0, 10)
    if (day < start || day > request.asOf) return []
    if (request.status) {
      const status = permit.assertions.find(assertion => assertion.field === 'permitStatus')?.value
      if (typeof status !== 'string') { incomplete = true; return [] }
      if (status.trim().toLowerCase() !== request.status.toLowerCase()) return []
    }
    return [{ permit, revision: rowRevision(row) }]
  })
  return {
    kind: 'page',
    partialCode: result.classification !== 'success' && !reportedEmpty ? result.error.code
      : incomplete ? 'PARTIAL_CONTENT' : records.length > request.remainingResults ? 'RESULT_LIMIT' : undefined,
    page: {
      records: records.slice(0, request.remainingResults), resultSize: payload.length, bytes: counters.bytes, fetchedAt: result.retrievedAt,
      finalUrl: actual.href, httpStatus: result.httpStatus,
      artifact: { digest: artifact.sha256, bytes: artifact.bytes, promote: key => retainArtifact(artifactDir, bytes, artifact.sha256, key) },
    },
  }
}

export async function createMunicipalAction(options: {
  socketPath: string; token: string; stagingDir: string; artifactDir: string; synthetic?: boolean; pollMs?: number
}): Promise<CollectPage> {
  const { stagingDir, artifactDir, synthetic = false, pollMs = 750 } = options
  if (![options.socketPath, stagingDir, artifactDir].every(isAbsolute) || resolve(stagingDir) === resolve(artifactDir)) {
    throw Error('Set separate absolute collector and artifact paths')
  }
  if (options.token.length < 32) throw Error('Set a collector token')
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const client = createCollectionClient(options)

  async function cancel(taskId: string, attemptId: string) {
    try {
      const ack = await client.cancel(taskId, attemptId)
      if (ack.cancellation !== 'requested') return
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const status = await client.status(taskId, attemptId)
        if (status.state === 'cancelled' || status.state === 'finished') return
        await setTimeout(pollMs)
      }
      throw Error('Collector cancellation still pending')
    } catch (error) {
      if (!(error instanceof CollectionServiceError && error.detail.code === 'UNKNOWN_TASK')) throw error
    }
  }


  return {
    cancel,
    async execute(request, permit) {
      if (request.source.synthetic !== synthetic) return failure('COLLECTION_MODE_MISMATCH')
      const initial = await permit()
      if (initial !== 'continue') return { kind: 'stopped', reason: initial }
      try {
        await client.submit(collectionPlan(request))
        for (;;) {
          const reason = await permit()
          if (reason !== 'continue') {
            if (reason !== 'lost') await cancel(request.taskId, request.attemptId)
            return { kind: 'stopped', reason }
          }
          const status = await client.status(request.taskId, request.attemptId)
          if (status.state === 'cancelled') return failure('COLLECTOR_CANCELLED', true, status.counters.bytes)
          if (status.state === 'finished') return await readPageResult(status.result, request, stagingDir, artifactDir)
          await setTimeout(pollMs)
        }
      } catch (error) {
        if (error instanceof CollectionServiceError) return failure(error.detail.code, error.detail.retryable || error.detail.code === 'UNKNOWN_TASK')
        return failure('COLLECTION_UNAVAILABLE', true)
      }
    },
  }
}
