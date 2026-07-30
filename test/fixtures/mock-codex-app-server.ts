const url = new URL(process.argv[2]!)
const mode = process.argv[3] ?? 'ready'

const server = Bun.serve({
  hostname: url.hostname,
  port: Number(url.port),
  fetch(request, bunServer) {
    return bunServer.upgrade(request)
      ? undefined
      : new Response('upgrade required', { status: 426 })
  },
  websocket: {
    message(socket, raw) {
      const message = JSON.parse(String(raw)) as {
        id?: number | string
        method?: string
      }
      if (message.id === undefined) return
      if (message.method === 'initialize' && mode === 'reject') {
        socket.send(JSON.stringify({
          id: message.id,
          error: { code: -32000, message: 'mock candidate rejected initialization' },
        }))
        return
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      if (message.method === 'initialize' && mode === 'exit-after-initialize') {
        setTimeout(() => process.exit(17), 10)
      }
    },
  },
})

function shutdown(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
