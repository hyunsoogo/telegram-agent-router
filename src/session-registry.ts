import type { SessionDescriptor } from './protocol.js'

export type SessionSocket = {
  send(data: string): number | void
  close(code?: number, reason?: string): void
}

type Entry<T extends SessionSocket> = {
  socket: T
  session: SessionDescriptor
  connectedAt: number
}

export class SessionRegistry<T extends SessionSocket> {
  private readonly primary = new Map<string, Entry<T>>()
  private readonly standby = new Map<string, Entry<T>[]>()

  register(socket: T, session: SessionDescriptor): 'primary' | 'standby' {
    const entry = { socket, session, connectedAt: Date.now() }
    if (!this.primary.has(session.id)) {
      this.primary.set(session.id, entry)
      return 'primary'
    }
    const queue = this.standby.get(session.id) ?? []
    queue.push(entry)
    this.standby.set(session.id, queue)
    return 'standby'
  }

  unregister(socket: T): { promoted?: Entry<T>; removedSessionId?: string } {
    for (const [sessionId, entry] of this.primary) {
      if (entry.socket !== socket) continue
      this.primary.delete(sessionId)
      const queue = this.standby.get(sessionId) ?? []
      const promoted = queue.shift()
      if (queue.length) this.standby.set(sessionId, queue)
      else this.standby.delete(sessionId)
      if (promoted) this.primary.set(sessionId, promoted)
      return { promoted, removedSessionId: sessionId }
    }
    for (const [sessionId, queue] of this.standby) {
      const next = queue.filter(entry => entry.socket !== socket)
      if (next.length !== queue.length) {
        if (next.length) this.standby.set(sessionId, next)
        else this.standby.delete(sessionId)
        return { removedSessionId: sessionId }
      }
    }
    return {}
  }

  get(sessionId: string): Entry<T> | undefined {
    return this.primary.get(sessionId)
  }

  list(): SessionDescriptor[] {
    return [...this.primary.values()]
      .map(entry => entry.session)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  role(socket: T): 'primary' | 'standby' | null {
    for (const entry of this.primary.values()) if (entry.socket === socket) return 'primary'
    for (const entries of this.standby.values()) {
      if (entries.some(entry => entry.socket === socket)) return 'standby'
    }
    return null
  }
}
