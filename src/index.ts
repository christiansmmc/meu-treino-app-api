import { app } from './app.ts'
import { env } from './env.ts'

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
})

console.log(`workout-sheet-api-v2 ouvindo em http://localhost:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop()
    process.exit(0)
  })
}
