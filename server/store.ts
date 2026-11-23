import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Application, Stage, TimelineEvent } from '../shared/model.ts'

type Request = Application & { permit: string | null; signature: string | null }
type Tx = { hash: string; raw: string }
type BankAttempt = { id: string; status: 'refused' | 'unknown' | 'paid'; result: 'refused' | 'paid' }

export function openStore(directory: string) {
  const db = new DatabaseSync(join(directory, 'demo.sqlite'))
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, issuer TEXT NOT NULL, account TEXT NOT NULL,
      amount TEXT NOT NULL, units TEXT NOT NULL, kopecks INTEGER NOT NULL CHECK (kopecks > 0),
      scenario TEXT NOT NULL, stage TEXT NOT NULL, kyt TEXT NOT NULL, debtId TEXT UNIQUE,
      permit TEXT, signature TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_request ON requests(owner)
      WHERE stage NOT IN ('paid', 'denied', 'cancelled');
    CREATE TABLE IF NOT EXISTS journal (
      request_id TEXT NOT NULL REFERENCES requests(id), at TEXT NOT NULL, actor TEXT NOT NULL,
      text TEXT NOT NULL, ref TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      request_id TEXT NOT NULL REFERENCES requests(id), kind TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      raw TEXT NOT NULL, PRIMARY KEY (request_id, kind)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      status TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transfers (
      debt_id TEXT PRIMARY KEY REFERENCES requests(debtId), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
      kopecks INTEGER NOT NULL CHECK (kopecks > 0)
    );
  `)

  function atomic<T>(action: () => T) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function latest() {
    return db.prepare('SELECT * FROM requests ORDER BY rowid DESC LIMIT 1').get() as Request | undefined
  }

  function log(id: string, actor: string, text: string, ref: string | null = null) {
    db.prepare('INSERT INTO journal VALUES (?, ?, ?, ?, ?)').run(id, new Date().toISOString(), actor, text, ref)
  }

  function update(id: string, stage: Stage, actor: string, text: string, ref?: string) {
    db.prepare('UPDATE requests SET stage = ? WHERE id = ?').run(stage, id)
    log(id, actor, text, ref)
  }

  function attempts(id: string) {
    return db.prepare('SELECT id, status, result FROM attempts WHERE request_id = ? ORDER BY rowid')
      .all(id) as BankAttempt[]
  }

  function sum(confirmed: boolean) {
    const condition = confirmed ? " WHERE attempts.status = 'paid'" : ''
    return Number(db.prepare('SELECT COALESCE(SUM(kopecks), 0) AS total FROM transfers JOIN attempts ON attempts.id = transfers.attempt_id' + condition).get()?.total)
  }

  return {
    db, atomic, latest, log, update, attempts, sum,
    journal(id: string) {
      return db.prepare('SELECT at, actor, text, ref FROM journal WHERE request_id = ? ORDER BY rowid DESC')
        .all(id) as TimelineEvent[]
    },
    tx(id: string, kind: string) {
      return db.prepare('SELECT raw, hash FROM transactions WHERE request_id = ? AND kind = ?')
        .get(id, kind) as Tx | undefined
    },
  }
}
