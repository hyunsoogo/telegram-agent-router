export type ClientKind = 'claude' | 'codex' | 'other'

export type SessionDescriptor = {
  id: string
  label: string
  client: ClientKind
  workspace: string
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
  | { type: 'heartbeat' }
  | { type: 'action'; requestId: string; action: RouterAction }

export type RouterToBridge =
  | { type: 'registered'; role: 'primary' | 'standby'; sessionId: string }
  | { type: 'promoted'; sessionId: string }
  | { type: 'inbound'; event: InboundEvent }
  | { type: 'action_result'; requestId: string; ok: true; result: unknown }
  | { type: 'action_result'; requestId: string; ok: false; error: string }
  | { type: 'error'; error: string }

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
  if (value.type === 'action' && typeof value.requestId === 'string' && value.action) {
    return value as BridgeToRouter
  }
  throw new Error('invalid bridge message')
}
