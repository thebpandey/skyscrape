import {
  BookUser, Building2, ChartNoAxesColumnIncreasing, FileSearch, Files, House,
  MapPinned, NotebookPen, SearchCheck, Telescope, Warehouse,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const icons: Record<string, LucideIcon> = {
  land_buyer_discovery: MapPinned,
  builder_activity: Building2,
  institutional_sfr_acquisition_research: Warehouse,
  permit_monitoring: Files,
  ownership_transfer_lookup: FileSearch,
  land_sfr_listing_watch: House,
  market_snapshot: ChartNoAxesColumnIncreasing,
  contact_enrichment: BookUser,
  source_gap_investigation: Telescope,
  custom_research: NotebookPen,
}

export function TemplateIcon({ template }: { template: string }) {
  const Icon = icons[template] ?? SearchCheck
  return <span className="template-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.65} /></span>
}
