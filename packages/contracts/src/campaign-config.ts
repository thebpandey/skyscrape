import { z } from 'zod'
import { campaignDraft } from './index.ts'
import { validateCriteria } from '../../domain/src/templates/index.ts'

export const campaignConfig = campaignDraft.extend({
  criteria: z.record(z.string(), z.union([z.string().max(128), z.number()])).optional(),
})
export type CampaignConfig = z.infer<typeof campaignConfig>

export const campaignInput = campaignConfig.superRefine((draft, context) => {
  try { validateCriteria(draft.template, draft.criteria) }
  catch { context.addIssue({ code: 'custom', message: 'Unknown template or invalid template criteria' }) }
})
