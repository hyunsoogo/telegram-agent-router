import { basename } from 'node:path'
import {
  clientBinaryIdentity,
  resolveCodexRuntimeBinary,
  sameClientBinary,
  type ClientBinaryIdentity,
} from './client-binary.js'
import type { RouterConfig } from './paths.js'
import type { InboundEvent, SessionDescriptor } from './protocol.js'
import { VERSION } from './version.js'
import type { CodexThread, CodexThreadStatus } from './codex-client-observer.js'
import { MAX_STDERR_TAIL_BYTES } from './diagnostics.js'

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
  stderr: 'pipe',
} as const

type CodexAppServerProcess = ReturnType<typeof Bun.spawn>
export type CodexAppServerSpawner = (
  argv: string[],
  options: typeof CODEX_APP_SERVER_STDIO,
) => CodexAppServerProcess

export type CodexBinaryPreparation =
  | { status: 'ready'; changed: boolean }
  | { status: 'busy'; sessions: number }

export function codexBinaryPreparationDecision(
  current: ClientBinaryIdentity | undefined,
  requested: ClientBinaryIdentity,
  busy: boolean,
): 'ready' | 'replace' | 'busy' {
  if (sameClientBinary(current, requested)) return 'ready'
  return busy ? 'busy' : 'replace'
}

export function spawnCodexAppServer(
  binary: string,
  url: string,
  spawn: CodexAppServerSpawner = Bun.spawn,
): CodexAppServerProcess {
  return spawn([binary, 'app-server', '--listen', url], CODEX_APP_SERVER_STDIO)
}

export async function readStderrTail(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes = MAX_STDERR_TAIL_BYTES,
): Promise<string> {
  if (!stream || typeof stream === 'number') return ''
  const limit = Math.max(0, maxBytes)
  const reader = stream.getReader()
  let tail = new Uint8Array(0)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || limit === 0) continue
      if (value.byteLength >= limit) {
        tail = value.slice(value.byteLength - limit)
        continue
      }
      const retained = Math.min(tail.byteLength, limit - value.byteLength)
      const next = new Uint8Array(retained + value.byteLength)
      next.set(tail.slice(tail.byteLength - retained))
      next.set(value, retained)
      tail = next
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(tail).trim()
}

export class CodexAppServerExitError extends Error {
  constructor(readonly exitCode: number | null, readonly stderrTail: string) {
    super(`Codex App Server exited during startup with code ${exitCode}${stderrTail ? `: ${stderrTail}` : ''}`)
  }
}

// Rust prints bind failures as a locale-dependent message followed by a stable
// "(os error N)" suffix: EADDRINUSE is 10048 on Windows, 98 on Linux, 48 on
// macOS. 10013 (WSAEACCES) is Windows refusing a port inside an excluded range.
const PORT_CONFLICT_PATTERN = /os error (?:10048|10013|98|48)\b|EADDRINUSE|address already in use/i

export function isPortConflictExit(error: unknown): boolean {
  return error instanceof CodexAppServerExitError && PORT_CONFLICT_PATTERN.test(error.stderrTail)
}

export function isPortBindable(port: number, hostname = '127.0.0.1'): boolean {
  try {
    const listener = Bun.listen({ hostname, port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}

export function findBindablePort(start: number, attempts = 20, hostname = '127.0.0.1'): number {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset
    if (candidate > 65535) break
    if (isPortBindable(candidate, hostname)) return candidate
  }
  throw new Error(`no bindable port found between ${start} and ${Math.min(start + attempts - 1, 65535)}`)
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
  private startupStderrTail: Promise<string> = Promise.resolve('')
  private currentBinary: ClientBinaryIdentity | undefined
  private spawnedBinary: ClientBinaryIdentity | undefined
  private binaryReplacement: Promise<void> | null = null
  private replacingBinary = false
  private ownsAppServer = false
  private readonly expectedProcessExits = new WeakSet<object>()

  constructor(
    private readonly config: RouterConfig,
    private readonly onOutput: (output: CodexOutput) => Promise<void>,
    private readonly onDiagnostic: (event: string, details?: Record<string, unknown>) => void = () => {},
    private readonly onPortChange: (port: number) => void = () => {},
    private readonly onBinaryChange: (binary: string, port: number) => void = () => {},
    private readonly spawn: CodexAppServerSpawner = Bun.spawn,
  ) {}

  async start(): Promise<void> {
    if (this.config.profile !== 'codex') throw new Error('Codex App Server requires the codex profile')
    if (!this.config.appServerPort) throw new Error('Codex App Server port is missing from the codex profile')
    await this.connectOrSpawn()
    await this.initialize()
    this.commitSpawnedBinary()
    await this.refreshThreads()
    this.pollTimer = setInterval(() => {
      if (this.binaryReplacement || this.replacingBinary) return
      void this.refreshThreads().catch(error => {
      process.stderr.write(`telegram-agent-router[codex]: thread refresh failed: ${String(error)}\n`)
      })
    }, 2_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    await this.binaryReplacement?.catch(() => {})
    await this.stopRuntime(new Error('Codex App Server adapter stopped'))
  }

  binaryIdentity(): ClientBinaryIdentity | undefined {
    return this.currentBinary ? { ...this.currentBinary } : undefined
  }

  async prepareBinary(binaryPath: string, connectedProxies = 0): Promise<CodexBinaryPreparation> {
    const requested = clientBinaryIdentity(binaryPath, 'codex')
    if (this.binaryReplacement || this.replacingBinary || this.recovering) {
      return {
        status: 'busy',
        sessions: Math.max(connectedProxies, this.threadClients.size, 1),
      }
    }
    if (!this.ownsAppServer && this.socket?.readyState === WebSocket.OPEN) {
      const previousConfiguredBinary = this.config.codexBinary
      this.config.codexBinary = requested.path
      try {
        this.onBinaryChange(requested.path, this.config.appServerPort!)
      } catch (error) {
        this.config.codexBinary = previousConfiguredBinary
        this.diagnose('codex_binary_persist_failed', {
          binary: requested.path,
          app_server_port: this.config.appServerPort,
          error: String(error),
        })
        throw error
      }
      this.diagnose('codex_binary_replacement_deferred_unowned', {
        binary: requested.path,
        app_server_port: this.config.appServerPort,
      })
      return { status: 'ready', changed: false }
    }
    const busy = connectedProxies > 0
      || this.threadClients.size > 0
      || this.activeTurns.size > 0
      || this.deliveryQueues.size > 0
    const decision = codexBinaryPreparationDecision(this.currentBinary, requested, busy)
    if (decision === 'ready') return { status: 'ready', changed: false }
    if (decision === 'busy') {
      return {
        status: 'busy',
        sessions: Math.max(connectedProxies, this.threadClients.size, 1),
      }
    }
    const replacement = this.replaceBinary(requested)
    this.binaryReplacement = replacement
    try {
      await replacement
    } finally {
      if (this.binaryReplacement === replacement) this.binaryReplacement = null
    }
    return { status: 'ready', changed: true }
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
    try {
      await this.connect(this.url(), 750)
      this.ownsAppServer = this.process?.exitCode === null
      if (!this.ownsAppServer) {
        this.diagnose('app_server_attached_unowned', {
          app_server_port: this.config.appServerPort,
        })
      }
      return
    } catch {}

    try {
      await this.spawnAndConnect()
    } catch (error) {
      const previous = this.config.appServerPort
      if (previous === undefined || !isPortConflictExit(error)) throw error
      // A dead App Server's listening socket can outlive it on Windows when a
      // process spawned inside a Codex session inherited the handle. The port
      // stays bound until that process dies, so move to one that binds.
      const port = findBindablePort(previous + 1)
      this.config.appServerPort = port
      this.diagnose('app_server_port_failover', {
        previous_port: previous,
        app_server_port: port,
        stderr_tail: (error as CodexAppServerExitError).stderrTail,
      })
      process.stderr.write(`telegram-agent-router[codex]: port ${previous} is stuck; moving App Server to ${port}\n`)
      this.onPortChange(port)
      await this.spawnAndConnect()
    }
  }

  private async spawnAndConnect(binaryOverride?: string): Promise<void> {
    const url = this.url()
    if (!this.process || this.process.exitCode !== null) {
      const binary = binaryOverride ?? resolveCodexRuntimeBinary(this.config.codexBinary)
      if (!binary) throw new Error('Codex CLI not found; configure the codex profile with --codex-binary')
      const identity = clientBinaryIdentity(binary, 'codex')
      const { child, stderrTail } = this.startProcess(identity, url)
      this.process = child
      this.spawnedBinary = identity
      this.startupStderrTail = stderrTail
    }

    await this.waitForProcessConnection(this.process, this.startupStderrTail, url)
    this.ownsAppServer = true
  }

  private startProcess(
    identity: ClientBinaryIdentity,
    url: string,
  ): { child: CodexAppServerProcess; stderrTail: Promise<string> } {
    const child = spawnCodexAppServer(identity.path, url, this.spawn)
    const startedAt = Date.now()
    const stderrTail = readStderrTail(child.stderr).catch(() => '')
    this.diagnose('app_server_spawned', {
      app_server_pid: child.pid,
      app_server_port: new URL(url).port,
      binary: identity.path,
    })
    void child.exited.then(async code => {
      const expected = this.stopped || this.expectedProcessExits.has(child)
      this.diagnose('app_server_exited', {
        app_server_pid: child.pid,
        exit_code: code,
        signal_code: child.signalCode,
        killed: child.killed,
        expected,
        uptime_ms: Date.now() - startedAt,
        tracked_sessions: this.threadClients.size,
        stderr_tail: await stderrTail,
      })
      if (!expected) process.stderr.write(`telegram-agent-router[codex]: App Server exited with code ${code}\n`)
    })
    return { child, stderrTail }
  }

  private async waitForProcessConnection(
    child: CodexAppServerProcess,
    stderrTail: Promise<string>,
    url: string,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (child.exitCode !== null) {
        const tail = await Promise.race([stderrTail, Bun.sleep(1_000).then(() => '')])
        throw new CodexAppServerExitError(child.exitCode, tail)
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

  private commitSpawnedBinary(failOnPersistError = false): void {
    const identity = this.spawnedBinary
    if (!identity) return
    const port = this.config.appServerPort
    if (!port) throw new Error('Codex App Server port is missing')
    this.currentBinary = identity
    this.spawnedBinary = undefined
    this.config.codexBinary = identity.path
    try {
      this.onBinaryChange(identity.path, port)
    } catch (error) {
      this.diagnose('codex_binary_persist_failed', {
        binary: identity.path,
        app_server_port: port,
        error: String(error),
      })
      if (failOnPersistError) throw error
      process.stderr.write(`telegram-agent-router[codex]: could not persist Codex binary ${identity.path}: ${String(error)}\n`)
    }
  }

  private async stopRuntime(error: Error): Promise<void> {
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.rejectPending(error)
    const child = this.process
    this.process = null
    this.spawnedBinary = undefined
    this.ownsAppServer = false
    if (!child) return
    this.expectedProcessExits.add(child)
    child.kill()
    await child.exited.catch(() => {})
  }

  private async replaceBinary(requested: ClientBinaryIdentity): Promise<void> {
    const previous = this.currentBinary
    const previousPort = this.config.appServerPort
    const previousConfiguredBinary = this.config.codexBinary
    if (!previousPort) throw new Error('Codex App Server port is missing')
    const previousUrl = this.url()
    const previousSocket = this.socket
    const previousProcess = this.process
    const previousOwnership = this.ownsAppServer
    const candidatePort = findBindablePort(previousPort === 65535 ? previousPort - 19 : previousPort + 1)
    const candidateUrl = `ws://127.0.0.1:${candidatePort}`
    let candidateProcess: CodexAppServerProcess | null = null
    let candidateSocket: WebSocket | null = null
    this.replacingBinary = true
    this.diagnose('codex_binary_replacement_started', {
      previous_binary: previous?.path,
      binary: requested.path,
      previous_port: previousPort,
      candidate_port: candidatePort,
    })
    try {
      const candidate = this.startProcess(requested, candidateUrl)
      candidateProcess = candidate.child
      await this.waitForProcessConnection(candidate.child, candidate.stderrTail, candidateUrl)
      const connectedCandidateSocket = this.socket
      if (!connectedCandidateSocket) throw new Error('updated Codex App Server did not open a socket')
      candidateSocket = connectedCandidateSocket
      await this.initialize()
      await Bun.sleep(100)
      if (candidate.child.exitCode !== null) {
        const tail = await Promise.race([candidate.stderrTail, Bun.sleep(1_000).then(() => '')])
        throw new CodexAppServerExitError(candidate.child.exitCode, tail)
      }
      if (this.socket !== connectedCandidateSocket || connectedCandidateSocket.readyState !== WebSocket.OPEN) {
        throw new Error('updated Codex App Server disconnected during validation')
      }

      this.config.appServerPort = candidatePort
      this.process = candidate.child
      this.startupStderrTail = candidate.stderrTail
      this.spawnedBinary = requested
      this.currentBinary = undefined
      this.commitSpawnedBinary(true)
      this.ownsAppServer = true
      try {
        if (previousSocket && previousSocket !== connectedCandidateSocket) previousSocket.close()
      } catch (error) {
        this.diagnose('previous_app_server_socket_close_failed', {
          error: String(error),
        })
      }
      if (previousProcess && previousProcess !== candidate.child) {
        this.expectedProcessExits.add(previousProcess)
        try {
          previousProcess.kill()
          void previousProcess.exited.catch(() => {})
        } catch (error) {
          this.diagnose('previous_app_server_stop_failed', {
            app_server_pid: previousProcess.pid,
            error: String(error),
          })
        }
      }
      // Once the old server is detached, candidate failures use normal recovery.
      // Keep this transition synchronous so no close event is suppressed.
      this.replacingBinary = false
      this.threads.clear()
      this.activeTurns.clear()
      this.routedTurns.clear()
      this.deliveryQueues.clear()
      this.subscribedThreads.clear()
      this.subscribingThreads.clear()
      this.clientThreads.clear()
      this.threadClients.clear()
      await this.refreshThreads()
      this.diagnose('codex_binary_replacement_completed', {
        binary: requested.path,
        app_server_port: candidatePort,
      })
    } catch (replacementError) {
      if (candidateSocket && candidateSocket !== previousSocket) {
        this.socket = previousSocket?.readyState === WebSocket.OPEN ? previousSocket : null
        candidateSocket.close()
      }
      if (candidateProcess) {
        this.expectedProcessExits.add(candidateProcess)
        candidateProcess.kill()
        await candidateProcess.exited.catch(() => {})
      }
      this.config.appServerPort = previousPort
      this.config.codexBinary = previous?.path ?? previousConfiguredBinary
      this.process = previousProcess
      this.currentBinary = previous
      this.spawnedBinary = undefined
      this.ownsAppServer = previousOwnership
      if (!this.socket && previousProcess?.exitCode === null) {
        await this.connect(previousUrl, 2_000)
        await this.initialize()
      }
      this.diagnose('codex_binary_replacement_rolled_back', {
        binary: requested.path,
        restored_binary: previous?.path,
        error: String(replacementError),
      })
      throw new Error(`updated Codex App Server failed validation; kept the previous server running: ${String(replacementError)}`)
    } finally {
      this.replacingBinary = false
    }
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
      if (!this.stopped && !this.replacingBinary) {
        this.diagnose('app_server_disconnected', {
          app_server_pid: this.process?.pid,
          app_server_exit_code: this.process?.exitCode,
          tracked_sessions: this.threadClients.size,
        })
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

  private diagnose(event: string, details: Record<string, unknown> = {}): void {
    try {
      this.onDiagnostic(event, details)
    } catch {}
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
          this.commitSpawnedBinary()
          await this.refreshThreads()
          this.diagnose('app_server_reconnected', { attempt })
          process.stderr.write('telegram-agent-router[codex]: App Server reconnected\n')
          return
        } catch (error) {
          const delay = Math.min(1000 * attempt, 10_000)
          this.diagnose('app_server_recovery_failed', {
            attempt,
            retry_delay_ms: delay,
            error: String(error),
          })
          process.stderr.write(`telegram-agent-router[codex]: recovery failed: ${String(error)}; retrying in ${delay / 1000}s\n`)
          await Bun.sleep(delay)
        }
      }
    } finally {
      this.recovering = false
    }
  }
}
