type JsonRpcId = number | string

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
