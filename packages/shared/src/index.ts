import pino from 'pino'

export const logger = pino({
  base: null,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      'password', 'token', 'secret', 'key', '*.password', '*.token', '*.secret', '*.key',
    ],
    remove: true,
  },
})
