import { constants } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { digest, manifest, profiles, project } from './profiles.mjs'

const usage = `node scripts/campaign-intake/intake.mjs COMMAND PROFILE [arguments]
Profiles: cook-sales | nyc-permits
url       PROFILE                    print a bounded publisher download URL
inspect   PROFILE FILE               validate the local JSON and print its SHA-256
register  PROFILE                    approve the documented source and field grant locally
import    PROFILE FILE UTC SHA256    import the reviewed download at its original retrieval instant
suppress  PROFILE                    withdraw the source from campaigns`

function publisherUrl(p, id) {
  const url = new URL(p.dataset)
  url.searchParams.set('$select', p.columns.join(','))
  if (id) url.searchParams.set(p.identity, id)
  else if (p.kind === 'permit') url.searchParams.set('permit_si_no', '3790014')
  else url.searchParams.set('doc_no', '2606427006')
  url.searchParams.set('$order', p.identity)
  url.searchParams.set('$limit', id || p.kind === 'permit' ? '1' : '5')
  return url.href
}

async function readBounded(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 65536) throw Error('Expected a regular file of at most 64 KiB')
    const buffer = Buffer.alloc(65537)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used !== stat.size) throw Error('File changed while reading')
    return buffer.subarray(0, used)
  } finally { await file.close() }
}

async function retain(directory, bytes, sha) {
  await mkdir(directory, { mode: 0o700, recursive: true })
  const pending = join(directory, '.pending-' + randomUUID())
  const target = join(directory, sha)
  const file = await open(pending, 'wx', 0o600)
  try {
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    try { await link(pending, target) } catch (error) {
      if (error.code !== 'EEXIST' || digest(await readBounded(target)) !== sha) throw Error('Evidence store conflict')
    }
    const dir = await open(directory, 'r')
    try { await dir.sync() } finally { await dir.close() }
  } finally { await unlink(pending) }
}

async function registry(db, command, name) {
  const p = profiles[name]
  const grant = manifest(name)
  const registryName = 'campaign-intake/' + name
  if (command === 'register')
    await db.query('INSERT INTO sources(name) VALUES($1) ON CONFLICT DO NOTHING', [registryName])
  const { rows: [source] } = await db.query('SELECT id FROM sources WHERE name=$1 FOR UPDATE', [registryName])
  if (!source) throw Error('Register the assessed source first')
  const { rows: [current] } = await db.query(`
    SELECT id, version, eligibility, manifest=$2::jsonb AND method='import' AS matches
    FROM source_versions WHERE source_id=$1 ORDER BY version DESC LIMIT 1`, [source.id, grant])
  if (command === 'suppress' && current?.eligibility === 'blocked') return
  if (current && (!current.matches || current.eligibility !== 'qualified'))
    throw Error('Registry assessment changed or source is blocked. Review the current policy.')
  if (command === 'suppress' || (!current && command === 'register')) {
    const state = command === 'suppress' ? 'blocked' : 'qualified'
    const { rows: [version] } = await db.query(`
      INSERT INTO source_versions(source_id,version,manifest,eligibility,method,coverage,policy_evidence)
      VALUES($1,$2,$3,$4,'import',$5,$6) RETURNING id`,
    [source.id, (current?.version ?? 0) + 1, grant, state, p.coverage, p.license + ' ' + p.termsUrl])
    await db.query('INSERT INTO audit_events(action,subject_id) VALUES($1,$2)', ['intake.' + state, version.id])
    return
  }
  if (!current) throw Error('Source has no current assessment')
  return { sourceId: source.id, versionId: current.id }
}

async function ingest(db, source, p, bytes, rows, sha, fetched, directory) {
  await db.query(`INSERT INTO artifacts(sha256,store_key,mime,size_bytes,access_class)
    VALUES($1,$1,'application/json',$2,'restricted') ON CONFLICT(sha256) DO NOTHING`, [sha, bytes.length])
  const { rows: [artifact] } = await db.query(`SELECT id FROM artifacts WHERE sha256=$1 AND store_key=$1
    AND mime='application/json' AND size_bytes=$2 AND access_class='restricted' AND purged_at IS NULL FOR SHARE`, [sha, bytes.length])
  if (!artifact) throw Error('Artifact metadata conflicts with the reviewed file')
  let inserted = 0
  for (const r of rows) {
    const revision = digest(source.versionId + ':' + r.revision)
    const { rows: [latest] } = await db.query(`SELECT revision_hash, fetched_at >= $3::timestamptz AS newer
      FROM observations WHERE source_id=$1 AND source_record_id=$2 ORDER BY fetched_at DESC LIMIT 1`, [source.sourceId, r.id, fetched])
    if (latest?.revision_hash === revision) continue
    const { rows: [seen] } = await db.query(`SELECT fetched_at >= $4::timestamptz AS replay FROM observations
      WHERE source_id=$1 AND source_record_id=$2 AND revision_hash=$3`, [source.sourceId, r.id, revision, fetched])
    if (seen?.replay) continue
    if (latest?.newer || seen) throw Error('Conflicting revision or retrieval order. Review the source history.')
    const { rows: [obs] } = await db.query(`
      INSERT INTO observations(source_id,source_version_id,source_record_id,source_url,revision_hash,event_date,
        fetched_at,artifact_id,extractor_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'campaign-intake-v1') RETURNING id`,
    [source.sourceId, source.versionId, r.id, publisherUrl(p, r.id), revision, r.date, fetched, artifact.id])
    await db.query(`INSERT INTO campaign_import_facts(observation_id,county_fips,acceptance,facts)
      VALUES($1,$2,'verified',$3)`, [obs.id, r.county, r.facts])
    await db.query("INSERT INTO audit_events(action,subject_id) VALUES('intake.observation',$1)", [obs.id])
    inserted++
  }
  await retain(directory, bytes, sha)
  return { inserted, unchanged: rows.length - inserted, sha256: sha }
}

export async function intake([command, name, ...args]) {
  if (command === '--help' || !command) return usage
  const arity = { url: 0, register: 0, inspect: 1, import: 3, suppress: 0 }
  if (!Object.hasOwn(profiles, name) || !Object.hasOwn(arity, command) || args.length !== arity[command]) throw Error(usage)
  const p = profiles[name]
  if (command === 'url') return publisherUrl(p)
  const [path, fetched, expected] = args
  let bytes, rows, sha
  const directory = process.env.EVIDENCE_STORE_DIR
  if (command === 'inspect' || command === 'import') {
    bytes = await readBounded(path)
    rows = project(p, bytes)
    sha = digest(bytes)
    if (command === 'inspect') return { rows: rows.length, counties: [...new Set(rows.map(r => r.county))], sha256: sha }
    if (expected !== sha) throw Error('Reviewed SHA-256 does not match')
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(fetched) || !Number.isFinite(Date.parse(fetched)) ||
        !new Date(fetched).toISOString().startsWith(fetched.replace(/Z$/, '')) || Date.parse(fetched) > Date.now() ||
        rows.some(r => r.date > fetched.slice(0, 10))) throw Error('Supply the actual UTC retrieval instant after the event')
    if (!directory || !isAbsolute(directory)) throw Error('Set EVIDENCE_STORE_DIR to the private absolute evidence-store path')
  }
  const raw = process.env.MIGRATOR_DATABASE_URL
  if (!URL.canParse(raw)) throw Error('Set MIGRATOR_DATABASE_URL for the local operator database')
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.search || url.hash || url.username !== 'skyscrape_migrator' || !url.pathname.slice(1)) throw Error('Expected a loopback migrator URL without options')
  const { openDatabase, transaction } = await import('../../packages/db/src/index.ts')
  const pool = openDatabase(raw)
  try {
    const result = await transaction(pool, async db => {
      const source = await registry(db, command, name)
      if (command === 'import') return ingest(db, source, p, bytes, rows, sha, fetched, directory)
      return { source: name, state: command === 'register' ? 'qualified' : 'blocked' }
    })
    return result
  } finally { await pool.end() }
}

if (import.meta.main) intake(process.argv.slice(2)).then(result => {
  console.log(typeof result === 'string' ? result : JSON.stringify(result))
}).catch(error => {
  // Database, filesystem and parser diagnostics may contain private values or paths.
  const safe = error.constructor === Error && !error.code && !error.message.includes('package') && !error.message.includes('module')
  console.error(safe ? error.message : 'Intake failed. Check the local database, workspace dependencies and private file permissions.')
  process.exitCode = 1
})
