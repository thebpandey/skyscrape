import { createHash } from 'node:crypto'

export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const boroughs = { MANHATTAN: '36061', BRONX: '36005', BROOKLYN: '36047', QUEENS: '36081', 'STATEN ISLAND': '36085' }

export const profiles = {
  'cook-sales': {
    dataset: 'https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json',
    publisher: "Cook County Assessor's Office",
    attribution: "Cook County Assessor's Office, Assessor - Parcel Sales",
    termsUrl: 'https://datacatalog.cookcountyil.gov/stories/s/About-Open-Data/pvqg-z4sc/',
    license: 'Cook County Open Data principles',
    countyFips: ['17031'], coverage: 'Selected Cook County recorded parcel sales. Reporting lags.',
    kind: 'transfer', allowedFields: ['instrumentId', 'apn'],
    columns: ['row_id', 'pin', 'doc_no', 'sale_date'], identity: 'row_id', date: 'sale_date',
    map(row) {
      if (!/^\d{14}$/.test(row.pin) || !/^\d{1,16}$/.test(row.doc_no) || /^0+$/.test(row.doc_no))
        throw Error('Invalid PIN or document number')
      return { county: '17031', facts: { kind: 'transfer', instrumentId: row.doc_no, apn: row.pin } }
    },
  },
  'nyc-permits': {
    dataset: 'https://data.cityofnewyork.us/resource/ipu4-2q9a.json',
    publisher: 'NYC Department of Buildings', attribution: 'NYC Department of Buildings, DOB Permit Issuance',
    termsUrl: 'https://www.nyc.gov/opendata/get-started/FAQs', license: 'NYC Open Data use policy',
    countyFips: Object.values(boroughs), coverage: 'Selected DOB Permit Issuance records, county from permit borough.',
    kind: 'permit', allowedFields: ['jurisdiction', 'permitNumber', 'rawStatus', 'status', 'rawType'],
    columns: ['permit_si_no', 'borough', 'issuance_date', 'permit_type', 'permit_status'],
    identity: 'permit_si_no', date: 'issuance_date',
    map(row) {
      if (!Object.hasOwn(boroughs, row.borough) || !/^[A-Z]{1,4}$/.test(row.permit_type) || row.permit_status !== 'ISSUED')
        throw Error('Expected an ISSUED permit with a known borough and type code')
      return { county: boroughs[row.borough], facts: { kind: 'permit', jurisdiction: 'New York City',
        permitNumber: row.permit_si_no, rawStatus: row.permit_status, status: 'issued', rawType: row.permit_type } }
    },
  },
}

export function manifest(name) {
  const p = profiles[name]
  return { countyFips: p.countyFips, synthetic: false, columns: p.columns, identity: p.identity,
    eventDateColumn: p.date, extractorVersion: 'campaign-intake-v1',
    campaignImport: { kind: p.kind, allowedFields: p.allowedFields, publisher: p.publisher, attribution: p.attribution,
      sourceUrl: p.dataset, license: p.license, termsUrl: p.termsUrl, freeOnly: true, assessmentId: name + '-2026-11-21' } }
}

export function project(p, bytes) {
  let input
  try { input = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) }
  catch { throw Error('Expected a UTF-8 JSON array') }
  if (!Array.isArray(input) || !input.length || input.length > 100) throw Error('Expected 1 to 100 projected rows')
  // JSON.parse keeps the last duplicate key. Reject hidden fields before archiving the raw bytes.
  if ((bytes.toString('utf8').match(/"\s*:/g) ?? []).length !== input.length * p.columns.length)
    throw Error('Unexpected or duplicate JSON columns')
  const ids = new Set()
  return input.map((row, index) => {
    try {
      if (!row || typeof row !== 'object' || Object.keys(row).length !== p.columns.length ||
          !p.columns.every(key => typeof row[key] === 'string')) throw Error('Use only the exact published projection')
      const id = row[p.identity]
      if (!/^\d{1,16}$/.test(id) || ids.has(id)) throw Error('Invalid or duplicate source record identity')
      ids.add(id)
      const date = row[p.date].slice(0, 10)
      if (!/^\d{4}-\d\d-\d\d(?:T00:00:00(?:\.000)?)?$/.test(row[p.date]) ||
          !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error('Invalid event date')
      return { ...p.map(row), id, date, revision: digest(JSON.stringify(p.columns.map(key => row[key]))) }
    } catch (err) { throw Error('Row ' + (index + 1) + '. ' + err.message) }
  })
}
