import { Bot, GrammyError, HttpError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { ServerWebSocket } from 'bun'
import { randomUUID } from 'node:crypto'
import { CodexAppServer } from './codex-app-server.js'
import { CodexClientObserver, persistentCodexClientMessage } from './codex-client-observer.js'
import { loadBotToken, loadConfig, persistAppServerPort, statePaths, type RouterProfile } from './paths.js'
import { parseBridgeMessage, type InboundEvent, type RouterAction, type RouterToBridge, type SessionDescriptor } from './protocol.js'
import { SessionRegistry } from './session-registry.js'
import { acquireDaemonLock } from './lock.js'
import { RouterStore } from './store.js'
import { VERSION } from './version.js'
import { DaemonDiagnostics, diagnosticError } from './diagnostics.js'

type SocketData = {
  sessionId?: string
}

type CodexProxySocketData = {
  clientId: string
  upstream: WebSocket
  observer: CodexClientObserver
}

type StoppableServer = {
  port?: number
  stop(closeActiveConnections?: boolean): void
}

type BridgeSocket = ServerWebSocket<SocketData>

type RouteTarget = {
  session: SessionDescriptor
  deliver(event: InboundEvent): Promise<void>
}

type PendingDelivery = {
  socket: BridgeSocket
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function json(message: RouterToBridge): string {
  return JSON.stringify(message)
}

function userIdentity(ctx: Context): { userId: string; chatId: string; username: string | null } | null {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return null
  return {
    userId: String(ctx.from.id),
    chatId: String(ctx.chat.id),
    username: ctx.from.username ?? null,
  }
}

function parseMessageId(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid Telegram message id: ${value}`)
  return parsed
}

export function telegramTextChunks(text: string): string[] {
  return text.match(/[\s\S]{1,4000}/g) ?? []
}

async function performAction(bot: Bot, store: RouterStore, action: RouterAction): Promise<unknown> {
  const chatId = action.chat_id
  if (!store.isAllowed(chatId)) throw new Error('Telegram chat is not paired with this router')
  switch (action.kind) {
    case 'reply': {
      const chunks = telegramTextChunks(action.text)
      if (!chunks.length) throw new Error('Telegram reply text cannot be empty')
      const messageIds: number[] = []
      for (let index = 0; index < chunks.length; index += 1) {
        const replyOptions = index === 0 && action.reply_to
          ? { reply_parameters: { message_id: parseMessageId(action.reply_to) } }
          : undefined
        try {
          const result = await bot.api.sendMessage(chatId, chunks[index]!, replyOptions)
          messageIds.push(result.message_id)
        } catch (error) {
          if (!replyOptions) throw error
          const result = await bot.api.sendMessage(chatId, chunks[index]!)
          messageIds.push(result.message_id)
        }
      }
      return { message_id: messageIds[0], message_ids: messageIds }
    }
    case 'react': {
      await bot.api.setMessageReaction(chatId, parseMessageId(action.message_id), [
        { type: 'emoji', emoji: action.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { ok: true }
    }
    case 'edit_message': {
      const result = await bot.api.editMessageText(chatId, parseMessageId(action.message_id), action.text)
      return typeof result === 'boolean' ? { ok: result } : { message_id: result.message_id }
    }
  }
}

async function requireAllowed(ctx: Context, store: RouterStore): Promise<{ userId: string; chatId: string; username: string | null } | null> {
  const identity = userIdentity(ctx)
  if (!identity) return null
  if (store.isAllowed(identity.userId)) return identity

  const pairing = store.createOrReusePairing(identity)
  await ctx.reply(
    `Pairing required. Run this in a trusted terminal:\n\n` +
    `telegram-agent-router access pair ${pairing.code} --profile ${store.profile}\n\n` +
    `This code expires in one hour. Your Telegram user ID is ${identity.userId}.`,
  )
  return null
}

async function runOwnedDaemon(
  paths: ReturnType<typeof statePaths>,
  diagnostics?: DaemonDiagnostics,
): Promise<void> {
  const config = loadConfig(paths)
  const token = loadBotToken(paths)
  const store = new RouterStore(paths.database, paths.profile)
  const registry = new SessionRegistry<BridgeSocket>()
  const pendingDeliveries = new Map<string, PendingDelivery>()
  const codexClientProxies = new Set<StoppableServer>()
  const bot = new Bot(token)
  const rememberBotMessage = (chatId: string, messageId: string, sessionId: string): void => {
    try {
      store.rememberBotMessage(chatId, messageId, sessionId)
    } catch (error) {
      process.stderr.write(`telegram-agent-router: could not remember answer route: ${String(error)}\n`)
    }
  }
  await bot.init()
  const codex = paths.profile === 'codex'
    ? new CodexAppServer(config, async output => {
        const chunks = output.text.match(/[\s\S]{1,4000}/g) ?? ['(empty response)']
        for (let index = 0; index < chunks.length; index += 1) {
          const replyOptions = index === 0 && output.replyTo
            ? { reply_parameters: { message_id: parseMessageId(output.replyTo) } }
            : undefined
          let sent: Awaited<ReturnType<typeof bot.api.sendMessage>>
          try {
            sent = await bot.api.sendMessage(output.chatId, chunks[index]!, replyOptions)
          } catch (error) {
            if (!replyOptions) throw error
            sent = await bot.api.sendMessage(output.chatId, chunks[index]!)
          }
          rememberBotMessage(output.chatId, String(sent.message_id), output.sessionId)
        }
      }, (event, details) => diagnostics?.log(event, details), port => {
        try {
          persistAppServerPort(port, paths)
        } catch (error) {
          process.stderr.write(`telegram-agent-router[codex]: could not persist App Server port ${port}: ${String(error)}\n`)
        }
      })
    : null
  if (codex) {
    try {
      await codex.start()
    } catch (error) {
      await codex.stop()
      store.close()
      throw error
    }
  }

  function allSessions(): SessionDescriptor[] {
    return codex ? codex.list() : registry.list()
  }

  async function connectCodexClientUpstream(): Promise<WebSocket> {
    const upstream = new WebSocket(`ws://127.0.0.1:${config.appServerPort}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        upstream.close()
        reject(new Error('Codex App Server connection timed out'))
      }, 2_000)
      upstream.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      upstream.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('Codex App Server connection failed'))
      }, { once: true })
    })
    return upstream
  }

  function createCodexClientProxy(): string {
    let claimed = false
    let expiryTimer: ReturnType<typeof setTimeout>
    let proxy: StoppableServer
    proxy = Bun.serve<CodexProxySocketData>({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, proxyServer) {
        if (claimed) return new Response('client proxy already claimed', { status: 409 })
        claimed = true
        let upstream: WebSocket
        try {
          upstream = await connectCodexClientUpstream()
        } catch (error) {
          claimed = false
          return new Response(String(error), { status: 503 })
        }
        const upgraded = proxyServer.upgrade(request, {
          data: {
            clientId: randomUUID(),
            upstream,
            observer: new CodexClientObserver(),
          },
        })
        if (!upgraded) {
          claimed = false
          upstream.close()
          return new Response('upgrade failed', { status: 400 })
        }
        clearTimeout(expiryTimer)
        return undefined
      },
      websocket: {
        open(ws) {
          const { clientId, observer, upstream } = ws.data
          upstream.addEventListener('message', event => {
            const raw = String(event.data)
            const thread = observer.observeServerMessage(raw)
            if (thread) codex?.clientAttached(clientId, thread)
            try {
              ws.send(raw)
            } catch {}
          })
          upstream.addEventListener('close', () => ws.close())
          upstream.addEventListener('error', () => ws.close())
        },
        message(ws, raw) {
          const message = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
          const forwarded = persistentCodexClientMessage(message)
          ws.data.observer.observeClientMessage(forwarded)
          try {
            ws.data.upstream.send(forwarded)
          } catch {
            ws.close()
          }
        },
        close(ws) {
          codex?.clientDetached(ws.data.clientId)
          ws.data.upstream.close()
          codexClientProxies.delete(proxy)
          proxy.stop()
        },
      },
    })
    codexClientProxies.add(proxy)
    expiryTimer = setTimeout(() => {
      codexClientProxies.delete(proxy)
      proxy.stop(true)
    }, 30_000)
    if (!proxy.port) {
      clearTimeout(expiryTimer)
      codexClientProxies.delete(proxy)
      proxy.stop(true)
      throw new Error('Codex client proxy did not receive a loopback port')
    }
    return `ws://127.0.0.1:${proxy.port}`
  }

  const createServer = () => Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    async fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/health') {
        if (url.searchParams.get('secret') !== config.secret) return new Response('unauthorized', { status: 401 })
        return Response.json({
          ok: true,
          version: VERSION,
          pid: process.pid,
          profile: paths.profile,
          sessions: allSessions(),
          codex_app_server: codex ? `127.0.0.1:${config.appServerPort}` : undefined,
          uptime_s: Math.round(process.uptime()),
        })
      }
      if (url.pathname === '/codex-client/register') {
        if (!codex) return new Response('Codex profile required', { status: 404 })
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        if (request.headers.get('authorization') !== `Bearer ${config.secret}`) {
          return new Response('unauthorized', { status: 401 })
        }
        return Response.json({ url: createCodexClientProxy() })
      }
      if (url.pathname === '/bridge') {
        if (paths.profile !== 'claude') return new Response('bridge is Claude-only', { status: 404 })
        if (url.searchParams.get('secret') !== config.secret) return new Response('unauthorized', { status: 401 })
        return bunServer.upgrade(request, { data: {} })
          ? undefined
          : new Response('upgrade failed', { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, raw) {
        try {
          const message = parseBridgeMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
          if (message.type === 'heartbeat') return
          if (message.type === 'register') {
            if (ws.data.sessionId) throw new Error('bridge already registered')
            if (paths.profile !== 'claude' || message.session.client !== 'claude') {
              throw new Error('this profile accepts Claude MCP sessions only')
            }
            ws.data.sessionId = message.session.id
            const role = registry.register(ws, message.session)
            ws.send(json({ type: 'registered', role, sessionId: message.session.id }))
            store.audit('session_connected', null, message.session.id, JSON.stringify({ client: message.session.client, role }))
            return
          }
          if (message.type === 'update_session') {
            const updated = registry.update(ws, message.patch)
            if (!updated) throw new Error('bridge must register before updating session info')
            store.audit('session_updated', null, updated.id, JSON.stringify(message.patch))
            return
          }
          if (message.type === 'action') {
            const sessionId = ws.data.sessionId
            void performAction(bot, store, message.action)
              .then(result => {
                if (message.action.kind === 'reply' && sessionId) {
                  const messageIds = (result as { message_ids?: number[] }).message_ids ?? []
                  for (const messageId of messageIds) {
                    rememberBotMessage(message.action.chat_id, String(messageId), sessionId)
                  }
                }
                ws.send(json({ type: 'action_result', requestId: message.requestId, ok: true, result }))
              })
              .catch(error => ws.send(json({ type: 'action_result', requestId: message.requestId, ok: false, error: String(error) })))
            return
          }
          if (message.type === 'inbound_result') {
            const pending = pendingDeliveries.get(message.deliveryId)
            if (!pending || pending.socket !== ws) return
            clearTimeout(pending.timer)
            pendingDeliveries.delete(message.deliveryId)
            if (message.ok) pending.resolve()
            else pending.reject(new Error(message.error))
          }
        } catch (error) {
          ws.send(json({ type: 'error', error: String(error) }))
        }
      },
      close(ws) {
        for (const [deliveryId, pending] of pendingDeliveries) {
          if (pending.socket !== ws) continue
          clearTimeout(pending.timer)
          pendingDeliveries.delete(deliveryId)
          pending.reject(new Error('session disconnected before accepting the message'))
        }
        const result = registry.unregister(ws)
        if (result.removedSessionId) store.audit('session_disconnected', null, result.removedSessionId, null)
        if (result.promoted) {
          result.promoted.socket.send(json({ type: 'promoted', sessionId: result.promoted.session.id }))
          store.audit('session_promoted', null, result.promoted.session.id, null)
        }
      },
    },
  })
  let server: ReturnType<typeof createServer>
  try {
    server = createServer()
  } catch (error) {
    await codex?.stop()
    store.close()
    throw error
  }

  function targetFor(sessionId: string): RouteTarget | undefined {
    if (codex) {
      const session = codex.get(sessionId)
      return session
        ? { session, deliver: event => codex.deliver(sessionId, event) }
        : undefined
    }
    const entry = registry.get(sessionId)
    return entry
      ? { session: entry.session, deliver: event => deliverBridge(entry.socket, event) }
      : undefined
  }

  async function visibleSessions(userId: string): Promise<SessionDescriptor[]> {
    return allSessions().filter(session => store.visibleSession(userId, session.id))
  }

  function sessionLine(session: SessionDescriptor, index: number, selected: string | null): string {
    const agent = session.client === 'claude' ? 'Claude' : session.client === 'codex' ? 'Codex' : session.client
    const selector = session.id.slice(-8)
    const started = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const context = [
      agent,
      selector,
      session.label,
      session.branch,
      session.summary ?? `started ${started}`,
    ].filter(Boolean).join(' · ')
    return `${session.id === selected ? '•' : ' '} ${index + 1}. ${context} [${session.status ?? 'active'}]`
  }

  function resolveSession(input: string, sessions: SessionDescriptor[]): {
    session?: SessionDescriptor
    ambiguous?: SessionDescriptor[]
  } {
    const query = input.trim()
    const numeric = Number.parseInt(query, 10)
    if (/^\d+$/.test(query) && numeric >= 1 && numeric <= sessions.length) {
      return { session: sessions[numeric - 1] }
    }
    const exact = sessions.find(session => session.id === query)
    if (exact) return { session: exact }
    const lowered = query.toLowerCase()
    const matches = sessions.filter(session =>
      session.id.toLowerCase().startsWith(lowered)
      || session.id.toLowerCase().endsWith(lowered)
      || session.label.toLowerCase().startsWith(lowered))
    return matches.length === 1 ? { session: matches[0] } : { ambiguous: matches }
  }

  async function deliverBridge(socket: BridgeSocket, event: InboundEvent): Promise<void> {
    const deliveryId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDeliveries.delete(deliveryId)
        reject(new Error('session did not accept the message within 15 seconds'))
      }, 15_000)
      pendingDeliveries.set(deliveryId, { socket, resolve, reject, timer })
      try {
        socket.send(json({ type: 'inbound', deliveryId, event }))
      } catch (error) {
        clearTimeout(timer)
        pendingDeliveries.delete(deliveryId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  bot.command('start', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    await ctx.reply(
      `Telegram Agent Router is connected.\n\n` +
      `/sessions - list available coding sessions\n` +
      `/use <session> - select a session\n` +
      `/status - show the current route\n\n` +
      `Reply to any agent answer to route your message back to that answer's session.`,
    )
  })

  bot.command('sessions', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const sessions = await visibleSessions(identity.userId)
    if (!sessions.length) {
      await ctx.reply('No permitted coding sessions are online.')
      return
    }
    const current = store.getRoute(identity.userId)
    await ctx.reply(
      `${sessions.map((session, index) => sessionLine(session, index, current)).join('\n')}\n\n` +
      `Select with /use <number-or-selector>.`,
    )
  })

  bot.command('use', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const sessions = await visibleSessions(identity.userId)
    const result = resolveSession(ctx.match.trim(), sessions)
    if (!result.session) {
      if (result.ambiguous?.length) {
        await ctx.reply(`That selector is ambiguous:\n${result.ambiguous.map((session, index) => sessionLine(session, index, null)).join('\n')}`)
      } else {
        await ctx.reply(`Session '${ctx.match.trim()}' is offline or not permitted. Use /sessions.`)
      }
      return
    }
    const sessionId = result.session.id
    const session = targetFor(sessionId)!
    store.setRoute(identity.userId, sessionId)
    await ctx.reply(`Now routing messages to ${session.session.label} (${sessionId}).`)
  })

  bot.command('status', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const selected = store.getRoute(identity.userId)
    const online = selected ? targetFor(selected) : undefined
    await ctx.reply(
      selected
        ? `Selected session: ${selected}\nStatus: ${online ? 'online' : 'offline'}\nRouter: ${config.host}:${config.port}`
        : `No session selected. Use /sessions and /use <session>.`,
    )
  })

  bot.on('message:text', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const visible = await visibleSessions(identity.userId)
    let sessionId = store.getRoute(identity.userId)
    let target = sessionId ? targetFor(sessionId) : undefined
    const repliedMessageId = ctx.message.reply_to_message?.message_id
    const repliedSessionId = repliedMessageId === undefined
      ? null
      : store.sessionForBotMessage(identity.chatId, String(repliedMessageId))
    if (repliedSessionId) {
      const repliedTarget = targetFor(repliedSessionId)
      if (!repliedTarget || !store.visibleSession(identity.userId, repliedSessionId)) {
        await ctx.reply('That answer belongs to a session that is offline or not permitted. Use /sessions.')
        return
      }
      sessionId = repliedSessionId
      target = repliedTarget
      if (store.getRoute(identity.userId) !== repliedSessionId) store.setRoute(identity.userId, repliedSessionId)
    }
    if (!target || !store.visibleSession(identity.userId, target.session.id)) {
      if (visible.length === 1) {
        sessionId = visible[0]!.id
        store.setRoute(identity.userId, sessionId)
        target = targetFor(sessionId)
      } else {
        await ctx.reply(visible.length ? 'Choose a destination with /sessions and /use <session>.' : 'No permitted coding sessions are online.')
        return
      }
    }

    const event: InboundEvent = {
      content: ctx.message.text,
      meta: {
        chat_id: identity.chatId,
        message_id: String(ctx.message.message_id),
        user: identity.username ?? identity.userId,
        user_id: identity.userId,
        ts: new Date(ctx.message.date * 1000).toISOString(),
      },
    }
    void ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {})
    try {
      await target!.deliver(event)
      store.audit('message_delivered', identity.userId, target!.session.id, String(ctx.message.message_id))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      store.audit('message_failed', identity.userId, target!.session.id, detail)
      await ctx.reply(`Message was not accepted by ${target!.session.label}: ${detail}`)
    }
  })

  bot.catch(error => {
    const detail = error.error instanceof GrammyError
      ? `${error.error.error_code} ${error.error.description}`
      : error.error instanceof HttpError
        ? `network error: ${error.error.message}`
        : String(error.error)
    process.stderr.write(`telegram router handler error: ${detail}\n`)
  })

  await bot.api.setMyCommands([
    { command: 'start', description: 'Setup and help' },
    { command: 'sessions', description: 'List online coding sessions' },
    { command: 'use', description: 'Select a coding session' },
    { command: 'status', description: 'Show current route' },
  ]).catch(() => {})

  let stopping = false
  const stopCodexClientProxies = () => {
    for (const proxy of codexClientProxies) proxy.stop(true)
    codexClientProxies.clear()
  }
  const stop = (reason: 'SIGINT' | 'SIGTERM') => {
    if (stopping) return
    stopping = true
    diagnostics?.log('daemon_shutdown_requested', { reason })
    process.stderr.write('telegram-agent-router: shutting down\n')
    stopCodexClientProxies()
    server.stop(true)
    void bot.stop()
  }
  const onSigint = () => stop('SIGINT')
  const onSigterm = () => stop('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  process.stderr.write(`telegram-agent-router[${paths.profile}]: local bridge ws://${config.host}:${config.port}/bridge\n`)
  try {
    await bot.start({ onStart: info => { process.stderr.write(`telegram-agent-router: polling as @${info.username}\n`) } })
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (!stopping) {
      stopping = true
      stopCodexClientProxies()
      server.stop(true)
    }
    await codex?.stop()
    store.close()
  }
}
export async function runDaemon(profile: RouterProfile = 'codex'): Promise<void> {
  const paths = statePaths(profile)
  const release = acquireDaemonLock(paths.pid)
  const diagnostics = profile === 'codex' ? new DaemonDiagnostics(paths, VERSION) : undefined
  diagnostics?.start()
  try {
    await runOwnedDaemon(paths, diagnostics)
    diagnostics?.finish('stopped')
  } catch (error) {
    diagnostics?.finish('failed', { error: diagnosticError(error) })
    throw error
  } finally {
    release()
  }
}
