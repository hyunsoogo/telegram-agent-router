import { basename } from 'node:path'
import type { RouterConfig } from './paths.js'
import type { InboundEvent, SessionDescriptor } from './protocol.js'
import { VERSION } from './version.js'
import type { CodexThread, CodexThreadStatus } from './codex-client-observer.js'

type JsonRpcId = number | string

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type RoutedTurn = {
  sessionId: string
  text: string
  destinations: Map<string, string | undefined>
}

export type CodexOutput = {
  chatId: string
  sessionId: string
  text: string
  replyTo?: string
}

export const CODEX_APP_SERVER_STDIO = {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
} as const

type CodexAppServerProcess = ReturnType<typeof Bun.spawn>
type CodexAppServerSpawner = (
  argv: string[],
  options: typeof CODEX_APP_SERVER_STDIO,
) => CodexAppServerProcess

export function spawnCodexAppServer(
  binary: string,
  url: string,
  spawn: CodexAppServerSpawner = Bun.spawn,
): CodexAppServerProcess {
  return spawn([binary, 'app-server', '--listen', url], CODEX_APP_SERVER_STDIO)
}

function channelAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function channelBody(value: string): string {
  return value.replace(/<(\/?channel)(?=[\s>])/gi, '&lt;$1')
}

export function codexTelegramInputText(event: InboundEvent): string {
  const attributes: Array<[string, string | undefined]> = [
    ['source', 'telegram'],
    ['chat_id', event.meta.chat_id],
    ['message_id', event.meta.message_id],
    ['user', event.meta.user],
    ['user_id', event.meta.user_id],
    ['ts', event.meta.ts],
    ['attachment_file_id', event.meta.attachment_file_id],
    ['attachment_kind', event.meta.attachment_kind],
    ['attachment_name', event.meta.attachment_name],
    ['attachment_mime', event.meta.attachment_mime],
  ]
  const rendered = attributes
    .filter((attribute): attribute is [string, string] => attribute[1] !== undefined)
    .map(([name, value]) => `${name}="${channelAttribute(value)}"`)
    .join(' ')
  return `<channel ${rendered}>\n${channelBody(event.content)}\n</channel>`
}

export class CodexAppServer {
  private socket: WebSocket | null = null
  private process: ReturnType<typeof Bun.spawn> | null = null
  private stopped = false
  private nextRequestId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly threads = new Map<string, CodexThread>()
  private readonly activeTurns = new Map<string, string>()
  private readonly routedTurns = new Map<string, RoutedTurn>()
  private readonly deliveryQueues = new Map<string, Promise<void>>()
  private readonly subscribedThreads = new Set<string>()
  private readonly clientThreads = new Map<string, string>()
  private readonly threadClients = new Map<string, Set<string>>()
  private readonly subscribingThreads = new Map<string, Promise<void>>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private recovering = false

  constructor(
    private readonly config: RouterConfig,
    private readonly onOutput: (output: CodexOutput) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.config.profile !== 'codex') throw new Error('Codex App Server requires the codex profile')
    if (!this.config.appServerPort) throw new Error('Codex App Server port is missing from the codex profile')
    await this.connectOrSpawn()
    await this.initialize()
    await this.refreshThreads()
    this.pollTimer = setInterval(() => void this.refreshThreads().catch(error => {
      process.stderr.write(`telegram-agent-router[codex]: thread refresh failed: ${String(error)}\n`)
    }), 2_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.socket?.close()
    this.socket = null
    this.rejectPending(new Error('Codex App Server adapter stopped'))
    if (this.process) {
      this.process.kill()
      await this.process.exited.catch(() => {})
      this.process = null
    }
  }

  list(): SessionDescriptor[] {
    return [...this.threads.values()]
      .filter(thread => this.threadClients.has(thread.id) && !thread.parentThreadId && thread.status.type !== 'notLoaded')
      .map(thread => this.toSession(thread))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  get(sessionId: string): SessionDescriptor | undefined {
    const thread = this.threads.get(sessionId)
    if (!this.threadClients.has(sessionId) || !thread || thread.parentThreadId || thread.status.type === 'notLoaded') {
      return undefined
    }
    return this.toSession(thread)
  }

  clientAttached(clientId: string, thread: CodexThread): void {
    if (thread.parentThreadId) return
    const previousThreadId = this.clientThreads.get(clientId)
    if (previousThreadId === thread.id) {
      this.threads.set(thread.id, thread)
      return
    }
    if (previousThreadId) this.removeClientFromThread(clientId, previousThreadId)
    this.clientThreads.set(clientId, thread.id)
    const clients = this.threadClients.get(thread.id) ?? new Set<string>()
    clients.add(clientId)
    this.threadClients.set(thread.id, clients)
    this.threads.set(thread.id, thread)
  }

  clientDetached(clientId: string): void {
    const threadId = this.clientThreads.get(clientId)
    if (!threadId) return
    this.clientThreads.delete(clientId)
    this.removeClientFromThread(clientId, threadId)
  }

  async deliver(sessionId: string, event: InboundEvent): Promise<void> {
    const previous = this.deliveryQueues.get(sessionId) ?? Promise.resolve()
    const delivery = previous.catch(() => {}).then(() => this.deliverNow(sessionId, event))
    this.deliveryQueues.set(sessionId, delivery)
    try {
      await delivery
    } finally {
      if (this.deliveryQueues.get(sessionId) === delivery) this.deliveryQueues.delete(sessionId)
    }
  }

  private async deliverNow(sessionId: string, event: InboundEvent): Promise<void> {
    const thread = this.threads.get(sessionId)
    if (!this.threadClients.has(sessionId) || !thread) throw new Error('Codex session is no longer connected')
    await this.ensureSubscribed(sessionId)
    const input = [{ type: 'text', text: codexTelegramInputText(event) }]
    let turnId = this.activeTurns.get(sessionId)

    if (!turnId && thread.status.type === 'active') {
      const response = await this.request('thread/read', { threadId: sessionId, includeTurns: true }) as { thread?: CodexThread }
      const active = [...(response.thread?.turns ?? [])].reverse().find(turn => turn.status === 'inProgress')
      turnId = active?.id
    }

    if (turnId) {
      const response = await this.request('turn/steer', {
        threadId: sessionId,
        expectedTurnId: turnId,
        input,
      }) as { turnId?: string }
      turnId = response.turnId ?? turnId
    } else {
      const response = await this.request('turn/start', { threadId: sessionId, input }) as {
        turn?: { id?: string }
      }
      turnId = response.turn?.id
    }

    if (!turnId) throw new Error('Codex accepted the input without returning a turn ID')
    this.activeTurns.set(sessionId, turnId)
    const routed = this.routedTurns.get(turnId) ?? { sessionId, text: '', destinations: new Map() }
    routed.destinations.set(event.meta.chat_id, event.meta.message_id)
    this.routedTurns.set(turnId, routed)
  }

  private toSession(thread: CodexThread): SessionDescriptor {
    const status = thread.status.type === 'systemError'
      ? 'error'
      : thread.status.type === 'active'
        ? 'active'
        : 'idle'
    return {
      id: thread.id,
      client: 'codex',
      label: thread.name?.trim() || basename(thread.cwd) || 'Codex',
      workspace: thread.cwd,
      branch: thread.gitInfo?.branch ?? undefined,
      summary: thread.preview.trim().slice(0, 120) || thread.name?.trim() || undefined,
      status,
      startedAt: new Date(thread.createdAt * 1000).toISOString(),
    }
  }

  private async connectOrSpawn(): Promise<void> {
    const url = this.url()
    try {
      await this.connect(url, 750)
      return
    } catch {}

    if (!this.process || this.process.exitCode !== null) {
      const binary = this.config.codexBinary ?? Bun.which('codex')
      if (!binary) throw new Error('Codex CLI not found; configure the codex profile with --codex-binary')
      this.process = spawnCodexAppServer(binary, url)
      void this.process.exited.then(code => {
        if (!this.stopped) process.stderr.write(`telegram-agent-router[codex]: App Server exited with code ${code}\n`)
      })
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (this.process.exitCode !== null) {
        throw new Error(`Codex App Server exited during startup with code ${this.process.exitCode}`)
      }
      try {
        await this.connect(url, 750)
        return
      } catch (error) {
        lastError = error
        await Bun.sleep(200)
      }
    }
    throw new Error(`could not connect to Codex App Server at ${url}: ${String(lastError)}`)
  }

  private url(): string {
    return `ws://127.0.0.1:${this.config.appServerPort}`
  }

  private async connect(url: string, timeoutMs: number): Promise<void> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('connection timed out'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('connection failed'))
      }, { once: true })
    })
    socket.addEventListener('message', event => this.handleMessage(String(event.data)))
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.rejectPending(new Error('Codex App Server disconnected'))
      if (!this.stopped) {
        process.stderr.write('telegram-agent-router[codex]: App Server disconnected\n')
        void this.recover()
      }
    })
    this.socket = socket
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'telegram-agent-router',
        title: 'Telegram Agent Router',
        version: VERSION,
      },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
  }

  private async refreshThreads(): Promise<void> {
    if (!this.socket) return
    for (const id of this.threadClients.keys()) {
      try {
        await this.ensureSubscribed(id)
        const result = await this.request('thread/read', { threadId: id, includeTurns: false }) as { thread?: CodexThread }
        if (result.thread) this.threads.set(id, result.thread)
      } catch (error) {
        if (!String(error).includes('no rollout found for thread id')) {
          process.stderr.write(`telegram-agent-router[codex]: cannot read thread ${id}: ${String(error)}\n`)
        }
      }
    }
  }

  private ensureSubscribed(threadId: string): Promise<void> {
    if (this.subscribedThreads.has(threadId)) return Promise.resolve()
    const existing = this.subscribingThreads.get(threadId)
    if (existing) return existing
    const subscription = (async () => {
      const result = await this.request('thread/resume', { threadId }) as { thread?: CodexThread }
      if (!this.threadClients.has(threadId)) {
        await this.request('thread/unsubscribe', { threadId }).catch(() => {})
        return
      }
      this.subscribedThreads.add(threadId)
      if (result.thread) this.threads.set(threadId, result.thread)
    })()
    this.subscribingThreads.set(threadId, subscription)
    return subscription.finally(() => {
      if (this.subscribingThreads.get(threadId) === subscription) this.subscribingThreads.delete(threadId)
    })
  }

  private removeClientFromThread(clientId: string, threadId: string): void {
    const clients = this.threadClients.get(threadId)
    clients?.delete(clientId)
    if (clients?.size) return
    this.threadClients.delete(threadId)
    this.threads.delete(threadId)
    this.activeTurns.delete(threadId)
    if (!this.subscribedThreads.delete(threadId)) return
    void this.request('thread/unsubscribe', { threadId }).catch(error => {
      if (this.socket) {
        process.stderr.write(`telegram-agent-router[codex]: cannot unsubscribe thread ${threadId}: ${String(error)}\n`)
      }
    })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Codex App Server is offline')
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  private notify(method: string, params?: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(params === undefined ? { method } : { method, params }))
  }

  private handleMessage(raw: string): void {
    let message: {
      id?: JsonRpcId
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string; code?: number }
    }
    try {
      message = JSON.parse(raw) as typeof message
    } catch (error) {
      process.stderr.write(`telegram-agent-router[codex]: invalid App Server message: ${String(error)}\n`)
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? `JSON-RPC ${message.error.code}`))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this.socket?.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: `${message.method} requires approval in the attached Codex terminal`,
        },
      }))
      void this.notifyRejectedRequest(message.method, message.params ?? {})
      return
    }
    if (message.method) {
      void this.handleNotification(message.method, message.params ?? {}).catch(error => {
        process.stderr.write(`telegram-agent-router[codex]: notification ${message.method} failed: ${String(error)}\n`)
      })
    }
  }

  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (method === 'thread/started') {
      const thread = params.thread as CodexThread | undefined
      if (thread && this.threadClients.has(thread.id)) this.threads.set(thread.id, thread)
      return
    }
    if (method === 'thread/status/changed' && threadId) {
      const thread = this.threads.get(threadId)
      if (thread && params.status) thread.status = params.status as CodexThreadStatus
      return
    }
    if (method === 'turn/started' && threadId) {
      const turn = params.turn as { id?: string } | undefined
      if (turn?.id) this.activeTurns.set(threadId, turn.id)
      return
    }
    if (method === 'item/agentMessage/delta') {
      const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const routed = turnId ? this.routedTurns.get(turnId) : undefined
      if (routed) routed.text += delta
      return
    }
    if (method === 'turn/completed' && threadId) {
      const turn = params.turn as {
        id?: string
        status?: string
        error?: { message?: string } | null
        items?: Array<{ type?: string; text?: string; phase?: string | null }>
      } | undefined
      if (!turn?.id) return
      this.activeTurns.delete(threadId)
      const routed = this.routedTurns.get(turn.id)
      this.routedTurns.delete(turn.id)
      if (!routed) return
      const agentMessages = (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.text?.trim())
      const finalMessages = agentMessages.filter(item => item.phase === 'final_answer')
      const completedText = (finalMessages.length ? finalMessages : agentMessages.slice(-1))
        .map(item => item.text!.trim())
        .join('\n\n')
      const text = completedText
        || routed.text.trim()
        || (turn.status === 'failed' ? `Codex turn failed: ${turn.error?.message ?? 'unknown error'}` : 'Codex completed without a text response.')
      for (const [chatId, replyTo] of routed.destinations) {
        await this.onOutput({ chatId, sessionId: routed.sessionId, text, ...(replyTo ? { replyTo } : {}) })
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async notifyRejectedRequest(method: string, params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const turnId = typeof params.turnId === 'string'
      ? params.turnId
      : threadId
        ? this.activeTurns.get(threadId)
        : undefined
    const routed = turnId ? this.routedTurns.get(turnId) : undefined
    if (!routed) return
    for (const [chatId, replyTo] of routed.destinations) {
      await this.onOutput({
        chatId,
        sessionId: routed.sessionId,
        text: `Codex requested ${method}. This remote bridge does not approve privileged actions; use the attached terminal for interactive approval.`,
        ...(replyTo ? { replyTo } : {}),
      })
    }
  }

  private async recover(): Promise<void> {
    if (this.recovering || this.stopped) return
    this.recovering = true
    this.threads.clear()
    this.activeTurns.clear()
    this.subscribedThreads.clear()
    this.subscribingThreads.clear()
    try {
      for (let attempt = 1; !this.stopped; attempt += 1) {
        try {
          await this.connectOrSpawn()
          await this.initialize()
          await this.refreshThreads()
          process.stderr.write('telegram-agent-router[codex]: App Server reconnected\n')
          return
        } catch (error) {
          const delay = Math.min(1000 * attempt, 10_000)
          process.stderr.write(`telegram-agent-router[codex]: recovery failed: ${String(error)}; retrying in ${delay / 1000}s\n`)
          await Bun.sleep(delay)
        }
      }
    } finally {
      this.recovering = false
    }
  }
}
