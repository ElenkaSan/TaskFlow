import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import sqlite3 from 'sqlite3'

type Parameters = unknown[]

export class SqliteDatabase {
  private constructor(private readonly connection: sqlite3.Database) {}

  static open(path: string): Promise<SqliteDatabase> {
    return new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(new SqliteDatabase(connection)))
    })
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.connection.exec(sql, (error) => error ? reject(error) : resolve()))
  }

  run(sql: string, parameters: Parameters = []): Promise<number> {
    return new Promise((resolve, reject) => this.connection.run(sql, parameters, function (error) { error ? reject(error) : resolve(this.changes) }))
  }

  get<T>(sql: string, parameters: Parameters = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => this.connection.get(sql, parameters, (error, row) => error ? reject(error) : resolve(row as T | undefined)))
  }

  all<T>(sql: string, parameters: Parameters = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.connection.all(sql, parameters, (error, rows) => error ? reject(error) : resolve(rows as T[])))
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.connection.close((error) => error ? reject(error) : resolve()))
  }
}

const contributors = [
  ['contributor-ada', 'Ada Lovelace', 'frontend'],
  ['contributor-grace', 'Grace Hopper', 'backend'],
  ['contributor-margaret', 'Margaret Hamilton', 'qa'],
  ['contributor-don', 'Don Norman', 'design'],
]

export async function initializeDatabase(path: string): Promise<SqliteDatabase> {
  mkdirSync(dirname(path), { recursive: true })
  const db = await SqliteDatabase.open(path)
  await db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS contributors (id TEXT PRIMARY KEY, name TEXT NOT NULL, expertise TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', required_expertise TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('routing','no_response_warning','offered','accepted','pre_work_failed','recovery_required')), version INTEGER NOT NULL DEFAULT 1, active_assignment_id TEXT, accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), contributor_id TEXT NOT NULL REFERENCES contributors(id), source TEXT NOT NULL CHECK(source IN ('automation','human')), status TEXT NOT NULL CHECK(status IN ('offered','accepted','declined','pre_work_failed','superseded')), offered_at TEXT NOT NULL, responded_at TEXT, response_note TEXT);
    CREATE TABLE IF NOT EXISTS routing_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL CHECK(status IN ('pending','completed','no_response','superseded','cancelled')), outcome TEXT NOT NULL CHECK(outcome IN ('success','no_response')), due_at TEXT NOT NULL, warning_at TEXT, selected_contributor_id TEXT REFERENCES contributors(id), task_version_at_creation INTEGER NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), event_type TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor IN ('system','operator','contributor')), details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS routing_attempts_due_idx ON routing_attempts(status, due_at);
    CREATE INDEX IF NOT EXISTS assignments_task_idx ON assignments(task_id, offered_at);
    CREATE INDEX IF NOT EXISTS audit_events_task_idx ON audit_events(task_id, created_at);`)
  const now = new Date().toISOString()
  await withTransaction(db, async () => {
    for (const [id, name, expertise] of contributors) {
      await db.run('INSERT OR IGNORE INTO contributors (id, name, expertise, active, created_at) VALUES (?, ?, ?, 1, ?)', [id, name, expertise, now])
    }
  })
  return db
}

export async function withTransaction<T>(db: SqliteDatabase, operation: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN IMMEDIATE')
  try {
    const result = await operation()
    await db.exec('COMMIT')
    return result
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}
