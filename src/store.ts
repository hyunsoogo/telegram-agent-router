import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export type PendingPairing = {
  code: string
  userId: string
  chatId: string
  username: string | null
  expiresAt: number
}

export class RouterStore {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_pairings (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        username TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_grants (
        user_id TEXT NOT NULL REFERENCES allowed_users(user_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS user_routes (
        user_id TEXT PRIMARY KEY REFERENCES allowed_users(user_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        detail TEXT
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  isAllowed(userId: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM allowed_users WHERE user_id = ?').get(userId))
  }

  listAllowedUsers(): Array<{ userId: string; username: string | null }> {
    return this.db.query('SELECT user_id AS userId, username FROM allowed_users ORDER BY created_at').all() as Array<{ userId: string; username: string | null }>
  }

  allowUser(userId: string, username: string | null = null, sessionId = '*'): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO allowed_users (user_id, username, created_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET username = COALESCE(excluded.username, username)
      `).run(userId, username, now)
      this.db.query(`
        INSERT OR IGNORE INTO session_grants (user_id, session_id, created_at) VALUES (?, ?, ?)
      `).run(userId, sessionId, now)
      this.audit('user_allowed', userId, sessionId, null)
    })()
  }

  grantSession(userId: string, sessionId: string): void {
    if (!this.isAllowed(userId)) throw new Error(`user ${userId} is not allowed`)
    this.db.query(`INSERT OR IGNORE INTO session_grants (user_id, session_id, created_at) VALUES (?, ?, ?)`)
      .run(userId, sessionId, Date.now())
    this.audit('session_granted', userId, sessionId, null)
  }

  visibleSession(userId: string, sessionId: string): boolean {
    return Boolean(this.db.query(`
      SELECT 1 FROM session_grants WHERE user_id = ? AND session_id IN ('*', ?)
    `).get(userId, sessionId))
  }

  createOrReusePairing(input: { userId: string; chatId: string; username?: string | null }): PendingPairing {
    this.pruneExpiredPairings()
    const existing = this.db.query(`
      SELECT code, user_id AS userId, chat_id AS chatId, username, expires_at AS expiresAt
      FROM pending_pairings WHERE user_id = ?
    `).get(input.userId) as PendingPairing | null
    if (existing) return existing

    const now = Date.now()
    const pairing: PendingPairing = {
      code: randomBytes(4).toString('base64url').slice(0, 6).toUpperCase(),
      userId: input.userId,
      chatId: input.chatId,
      username: input.username ?? null,
      expiresAt: now + 60 * 60 * 1000,
    }
    this.db.query(`
      INSERT INTO pending_pairings (code, user_id, chat_id, username, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pairing.code, pairing.userId, pairing.chatId, pairing.username, now, pairing.expiresAt)
    this.audit('pairing_created', pairing.userId, null, null)
    return pairing
  }

  approvePairing(code: string, sessionId = '*'): PendingPairing {
    this.pruneExpiredPairings()
    const pairing = this.db.query(`
      SELECT code, user_id AS userId, chat_id AS chatId, username, expires_at AS expiresAt
      FROM pending_pairings WHERE code = ?
    `).get(code.toUpperCase()) as PendingPairing | null
    if (!pairing) throw new Error('pairing code not found or expired')
    this.db.transaction(() => {
      this.allowUser(pairing.userId, pairing.username, sessionId)
      this.db.query('DELETE FROM pending_pairings WHERE code = ?').run(pairing.code)
      this.audit('pairing_approved', pairing.userId, sessionId, null)
    })()
    return pairing
  }

  getRoute(userId: string): string | null {
    const row = this.db.query('SELECT session_id AS sessionId FROM user_routes WHERE user_id = ?').get(userId) as { sessionId: string } | null
    return row?.sessionId ?? null
  }

  setRoute(userId: string, sessionId: string): void {
    if (!this.visibleSession(userId, sessionId)) throw new Error('session is not granted to this user')
    this.db.query(`
      INSERT INTO user_routes (user_id, session_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(userId, sessionId, Date.now())
    this.audit('route_selected', userId, sessionId, null)
  }

  audit(event: string, userId: string | null, sessionId: string | null, detail: string | null): void {
    this.db.query(`INSERT INTO audit_events (created_at, event, user_id, session_id, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), event, userId, sessionId, detail)
  }

  pruneExpiredPairings(): void {
    this.db.query('DELETE FROM pending_pairings WHERE expires_at < ?').run(Date.now())
  }
}
