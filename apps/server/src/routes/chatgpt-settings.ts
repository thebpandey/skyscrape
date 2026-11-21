import { userInfo } from 'node:os'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod'
import { authenticatedOf } from '../middleware/access.ts'
import { fail } from '../middleware/errors.ts'
import type { ChatGPT } from '../chatgpt/provider.ts'

export function registerChatGPT(app: FastifyInstance, owner: string | undefined, provider: ChatGPT | undefined) {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const base = '/api/v1/settings/chatgpt'
  function access(req: FastifyRequest) {
    const { principal, proof } = authenticatedOf(req)
    if (!provider || !owner || principal.id !== owner || proof.kind !== 'session')
      return fail(403, 'FORBIDDEN', 'Workspace owner session required')
    return { provider, session: proof.id }
  }
  const schema = { hide: true } as const
  routes.get(base, { schema }, async req => {
    const { provider, session } = access(req)
    const status = await provider.status(session)
    const login = process.env.CHATGPT_SSH_USER ?? userInfo().username
    return { ...status, sshUser: /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(login) ? login : 'YOUR_SSH_USER' }
  })
  routes.post(base + '/connect', { schema: { ...schema, body: z.strictObject({ id: z.uuid().optional(), retryNew: z.literal(true).optional() }) } }, req => {
    const { provider, session } = access(req)
    return provider.start(session, req.body.id, req.body.retryNew)
  })
  routes.post(base + '/finish', { schema }, async req => {
    const { provider, session } = access(req)
    return provider.finish(session)
  })
  routes.post(base + '/preferences', { schema: { ...schema, body: z.strictObject({
    id: z.uuid(), model: z.string().min(1).max(160), effort: z.string().min(1).max(160).optional(),
  }) } }, async (req, reply) => {
    await access(req).provider.choose(req.body.id, req.body.model, req.body.effort)
    return reply.code(204).send()
  })
  routes.post(base + '/disconnect', { schema: { ...schema, body: z.strictObject({ id: z.uuid() }) } },
    req => access(req).provider.disconnect(req.body.id))
}
