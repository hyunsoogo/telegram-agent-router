type JsonRpcId = number | string

type ClientMessage = {
  id?: JsonRpcId
  method?: string
  params?: unknown
  [key: string]: unknown
}

export type CodexThreadStatus = {
  type: 'notLoaded' | 'idle' | 'systemError' | 'active'
  activeFlags?: string[]
}

export type CodexThread = {
  id: string
  name?: string | null
  preview: string
  cwd: string
  createdAt: number
  parentThreadId?: string | null
  gitInfo?: { branch?: string | null } | null
  status: CodexThreadStatus
  turns?: Array<{
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    error?: { message?: string } | null
  }>
}

// Interactive Codex clients create blank threads as ephemeral. A second App
// Server connection cannot resume those threads until their first local turn,
// so make them persistent at creation while preserving the client's thread ID.
export function persistentCodexClientMessage(raw: string): string {
  let message: ClientMessage
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    message = parsed as ClientMessage
  } catch {
    return raw
  }
  if (message.method !== 'thread/start') return raw
  if (
    message.params !== undefined
    && (message.params === null || typeof message.params !== 'object' || Array.isArray(message.params))
  ) {
    return raw
  }
  return JSON.stringify({
    ...message,
    params: {
      ...(message.params as Record<string, unknown> | undefined),
      ephemeral: false,
    },
  })
}

function rootThread(value: unknown): CodexThread | undefined {
  if (!value || typeof value !== 'object') return undefined
  const thread = value as Partial<CodexThread>
  if (
    typeof thread.id !== 'string'
    || typeof thread.cwd !== 'string'
    || typeof thread.preview !== 'string'
    || typeof thread.createdAt !== 'number'
    || !thread.status
    || typeof thread.status.type !== 'string'
    || thread.parentThreadId
  ) return undefined
  return thread as CodexThread
}

export class CodexClientObserver {
  private readonly threadRequests = new Set<JsonRpcId>()

  observeClientMessage(raw: string): void {
    let message: { id?: JsonRpcId; method?: string }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    if (
      message.id !== undefined
      && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method ?? '')
    ) {
      this.threadRequests.add(message.id)
    }
  }

  observeServerMessage(raw: string): CodexThread | undefined {
    let message: {
      id?: JsonRpcId
      method?: string
      params?: { thread?: unknown }
      result?: { thread?: unknown }
      error?: unknown
    }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return undefined
    }

    if (message.method === 'thread/started' && this.threadRequests.size) {
      return rootThread(message.params?.thread)
    }
    if (message.id === undefined || !this.threadRequests.delete(message.id) || message.error) {
      return undefined
    }
    return rootThread(message.result?.thread)
  }
}
