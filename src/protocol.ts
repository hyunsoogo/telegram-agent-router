export type ClientKind = 'claude' | 'codex' | 'other'

export type SessionDescriptor = {
  id: string
  label: string
  client: ClientKind
  workspace: string
  branch?: string
  summary?: string
  status?: 'active' | 'idle' | 'offline' | 'error'
  startedAt: string
}

export type InboundMeta = {
  chat_id: string
  message_id?: string
  user: string
  user_id: string
  ts: string
  attachment_file_id?: string
  attachment_kind?: string
  attachment_name?: string
  attachment_mime?: string
}

export type InboundEvent = {
  content: string
  meta: InboundMeta
}

export type RouterAction =
  | { kind: 'reply'; chat_id: string; text: string; reply_to?: string }
  | { kind: 'react'; chat_id: string; message_id: string; emoji: string }
  | { kind: 'edit_message'; chat_id: string; message_id: string; text: string }

export type BridgeToRouter =
  | { type: 'register'; session: SessionDescriptor }
  | { type: 'update_session'; patch: { label?: string; summary?: string; branch?: string } }
  | { type: 'heartbeat' }
  | { type: 'action'; requestId: string; action: RouterAction }
  | { type: 'inbound_result'; deliveryId: string; ok: true }
  | { type: 'inbound_result'; deliveryId: string; ok: false; error: string }

export type RouterToBridge =
  | { type: 'registered'; role: 'primary' | 'standby'; sessionId: string }
  | { type: 'promoted'; sessionId: string }
  | { type: 'inbound'; deliveryId: string; event: InboundEvent }
  | { type: 'action_result'; requestId: string; ok: true; result: unknown }
  | { type: 'action_result'; requestId: string; ok: false; error: string }
  | { type: 'error'; error: string }

function validRouterAction(action: unknown): action is RouterAction {
  if (!action || typeof action !== 'object') return false
  const value = action as Record<string, unknown>
  if (typeof value.chat_id !== 'string') return false
  if (value.kind === 'reply') {
    return typeof value.text === 'string'
      && (value.reply_to === undefined || typeof value.reply_to === 'string')
  }
  if (value.kind === 'react') {
    return typeof value.message_id === 'string' && typeof value.emoji === 'string'
  }
  if (value.kind === 'edit_message') {
    return typeof value.message_id === 'string' && typeof value.text === 'string'
  }
  return false
}

export function parseBridgeMessage(raw: string): BridgeToRouter {
  const value = JSON.parse(raw) as Partial<BridgeToRouter>
  if (value.type === 'heartbeat') return { type: 'heartbeat' }
  if (value.type === 'register' && value.session) {
    const session = value.session as Partial<SessionDescriptor>
    const validId = typeof session.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(session.id)
    const validClient = session.client === 'claude' || session.client === 'codex' || session.client === 'other'
    if (validId && validClient && typeof session.label === 'string' && typeof session.workspace === 'string' && typeof session.startedAt === 'string') {
      return value as BridgeToRouter
    }
  }
  if (value.type === 'update_session' && value.patch && typeof value.patch === 'object') {
    const patch = value.patch as { label?: unknown; summary?: unknown; branch?: unknown }
    const values = [patch.label, patch.summary, patch.branch].filter(item => item !== undefined)
    if (values.length && values.every(item => typeof item === 'string' && item.length <= 160)) {
      return value as BridgeToRouter
    }
  }
  if (value.type === 'action' && typeof value.requestId === 'string' && validRouterAction(value.action)) {
    return value as BridgeToRouter
  }
  if (value.type === 'inbound_result' && typeof value.deliveryId === 'string' && typeof value.ok === 'boolean') {
    if (value.ok || typeof (value as { error?: unknown }).error === 'string') return value as BridgeToRouter
  }
  throw new Error('invalid bridge message')
}
