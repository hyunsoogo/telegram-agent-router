import { Bot, GrammyError, HttpError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { ServerWebSocket } from 'bun'
import { loadBotToken, loadConfig, statePaths } from './paths.js'
import { parseBridgeMessage, type InboundEvent, type RouterAction, type RouterToBridge, type SessionDescriptor } from './protocol.js'
import { SessionRegistry } from './session-registry.js'
import { acquireDaemonLock } from './lock.js'
import { RouterStore } from './store.js'

type SocketData = {
  sessionId?: string
}

type BridgeSocket = ServerWebSocket<SocketData>

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
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid Telegram message id: ${value}`)
  return parsed
}

async function performAction(bot: Bot, action: RouterAction): Promise<unknown> {
  const chatId = action.chat_id
  switch (action.kind) {
    case 'reply': {
      const result = await bot.api.sendMessage(chatId, action.text, action.reply_to
        ? { reply_parameters: { message_id: parseMessageId(action.reply_to) } }
        : undefined)
      return { message_id: result.message_id }
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
    `telegram-agent-router access pair ${pairing.code}\n\n` +
    `This code expires in one hour. Your Telegram user ID is ${identity.userId}.`,
  )
  return null
}

async function runOwnedDaemon(paths: ReturnType<typeof statePaths>): Promise<void> {
  const config = loadConfig(paths)
  const token = loadBotToken(paths)
  const store = new RouterStore(paths.database)
  const registry = new SessionRegistry<BridgeSocket>()
  const bot = new Bot(token)
  await bot.init()

  const server = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          sessions: registry.list(),
          uptime_s: Math.round(process.uptime()),
        })
      }
      if (url.pathname === '/bridge') {
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
            ws.data.sessionId = message.session.id
            const role = registry.register(ws, message.session)
            ws.send(json({ type: 'registered', role, sessionId: message.session.id }))
            store.audit('session_connected', null, message.session.id, JSON.stringify({ client: message.session.client, role }))
            return
          }
          if (message.type === 'action') {
            void performAction(bot, message.action)
              .then(result => ws.send(json({ type: 'action_result', requestId: message.requestId, ok: true, result })))
              .catch(error => ws.send(json({ type: 'action_result', requestId: message.requestId, ok: false, error: String(error) })))
          }
        } catch (error) {
          ws.send(json({ type: 'error', error: String(error) }))
        }
      },
      close(ws) {
        const result = registry.unregister(ws)
        if (result.removedSessionId) store.audit('session_disconnected', null, result.removedSessionId, null)
        if (result.promoted) {
          result.promoted.socket.send(json({ type: 'promoted', sessionId: result.promoted.session.id }))
          store.audit('session_promoted', null, result.promoted.session.id, null)
        }
      },
    },
  })

  async function visibleSessions(userId: string): Promise<SessionDescriptor[]> {
    return registry.list().filter(session => store.visibleSession(userId, session.id))
  }

  bot.command('start', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    await ctx.reply(
      `Telegram Agent Router is connected.\n\n` +
      `/sessions - list available coding sessions\n` +
      `/use <session> - select a session\n` +
      `/status - show the current route`,
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
    await ctx.reply(sessions.map(session => `${session.id === current ? '•' : ' '} ${session.id} | ${session.client} | ${session.label}`).join('\n'))
  })

  bot.command('use', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const sessionId = ctx.match.trim()
    const session = registry.get(sessionId)
    if (!session || !store.visibleSession(identity.userId, sessionId)) {
      await ctx.reply(`Session '${sessionId}' is offline or not permitted. Use /sessions.`)
      return
    }
    store.setRoute(identity.userId, sessionId)
    await ctx.reply(`Now routing messages to ${session.session.label} (${sessionId}).`)
  })

  bot.command('status', async ctx => {
    const identity = await requireAllowed(ctx, store)
    if (!identity) return
    const selected = store.getRoute(identity.userId)
    const online = selected ? registry.get(selected) : undefined
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
    let target = sessionId ? registry.get(sessionId) : undefined
    if (!target || !store.visibleSession(identity.userId, target.session.id)) {
      if (visible.length === 1) {
        sessionId = visible[0]!.id
        store.setRoute(identity.userId, sessionId)
        target = registry.get(sessionId)
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
    target!.socket.send(json({ type: 'inbound', event }))
    store.audit('message_delivered', identity.userId, target!.session.id, String(ctx.message.message_id))
    void ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {})
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
  const stop = () => {
    if (stopping) return
    stopping = true
    process.stderr.write('telegram-agent-router: shutting down\n')
    server.stop(true)
    store.close()
    void bot.stop()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  process.stderr.write(`telegram-agent-router: local bridge ws://${config.host}:${config.port}/bridge\n`)
  await bot.start({ onStart: info => { process.stderr.write(`telegram-agent-router: polling as @${info.username}\n`) } })
}
export async function runDaemon(): Promise<void> {
  const paths = statePaths()
  const release = acquireDaemonLock(paths.pid)
  try {
    await runOwnedDaemon(paths)
  } finally {
    release()
  }
}