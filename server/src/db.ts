import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, pin TEXT NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  saveGame(g: { id: string; pin: string; createdAt: number }, active: boolean, state: unknown) {
    this.db.prepare(`INSERT INTO games (id, pin, active, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pin=excluded.pin, active=excluded.active, updated_at=excluded.updated_at, state=excluded.state`)
      .run(g.id, g.pin, active ? 1 : 0, g.createdAt, Date.now(), JSON.stringify(state));
  }
  deactivateAll() { this.db.prepare('UPDATE games SET active = 0').run(); }
  activeGame<T>(): T | null {
    const r = this.db.prepare('SELECT state FROM games WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get() as { state: string } | undefined;
    return r ? JSON.parse(r.state) : null;
  }
  game<T>(id: string): T | null {
    const r = this.db.prepare('SELECT state FROM games WHERE id = ?').get(id) as { state: string } | undefined;
    return r ? JSON.parse(r.state) : null;
  }
  listGames(): { id: string; pin: string; created_at: number; active: number; state: string }[] {
    return this.db.prepare('SELECT id, pin, created_at, active, state FROM games ORDER BY created_at DESC LIMIT 20').all() as any;
  }
  addSession(token: string) { this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(token, Date.now()); }
  hasSession(token: string) { return !!this.db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token); }
  get(key: string) { return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value; }
  set(key: string, value: string) { this.db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
}
