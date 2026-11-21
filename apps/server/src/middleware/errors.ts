import type { FastifyInstance, FastifyRequest } from 'fastify'

class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message)
}

function errorBody(req: FastifyRequest, code: string, message: string, retryable = false) {
  return { error: { code, message, retryable, requestId: req.id } }
}

export function registerErrors(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody(req, 'NOT_FOUND', 'Resource not found'))
  })
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send(errorBody(req, error.code, error.message, error.status === 429))
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      if (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415) {
        return reply.code(error.statusCode).send(errorBody(req, 'INVALID_INPUT', 'Invalid request'))
      }
    }
    req.log.error({ code: 'INTERNAL_ERROR' }, 'Request failed')
    return reply.code(500).send(errorBody(req, 'INTERNAL_ERROR', 'Request failed'))
  })
}
