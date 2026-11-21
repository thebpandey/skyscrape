export type SourceEntry = {
  id: string; name: string; version: number; eligibility: string; method: string; coverage: string | null
  assessedAt: string; assessment: string | null; fields: string[]; counties: string[]; synthetic: boolean
}
export type RunEntry = { id: string; state: string; createdAt: string; title: string; code: string | null; synthetic: boolean }
export type IssueRegister = {
  incidents: { id: string; source: string; briefCount: number; version: number; state: string; synthetic: boolean }[]
  runs: RunEntry[]
}
export type ExportRegister = {
  history: { id: string; runId: string; title: string; expiresAt: string; expired: boolean; rowCount: number | null; sha256: string | null }[]
  runs: RunEntry[]
}
