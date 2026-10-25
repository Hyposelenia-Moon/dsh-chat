import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** A small synchronous SQLite store. All timestamps are Unix milliseconds. */
export class Store {
  constructor(options = {}) {
    const path = typeof options === 'string' ? options : options.path ?? ':memory:';
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.database.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.database.close(); throw new Error(`Database schema ${version} is newer than supported version 2`); }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      if (!this.database.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'self_id')) this.database.exec('ALTER TABLE jobs ADD COLUMN self_id TEXT');
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); this.database.close(); throw error; }
    this.fts = false;
    try {
      this.database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content,subject,content='memories',content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid,content,subject) VALUES(new.id,new.content,new.subject);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts,rowid,content,subject) VALUES('delete',old.id,old.content,old.subject);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content,subject ON memories BEGIN
          INSERT INTO memories_fts(memories_fts,rowid,content,subject) VALUES('delete',old.id,old.content,old.subject);
          INSERT INTO memories_fts(rowid,content,subject) VALUES(new.id,new.content,new.subject);
        END;
        INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
      `);
      this.fts = true;
    } catch (error) {
      if (!/no such module.*fts5/i.test(error.message)) { this.database.close(); throw error; }
    }
  }
  prepare(sql) { return this.database.prepare(sql); }
  exec(sql) { return this.database.exec(sql); }
  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      if (value && typeof value.then === 'function') throw new TypeError('SQLite transactions must be synchronous');
      this.database.exec('COMMIT');
      return value;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  audit(event, context = {}, detail = {}) {
    this.prepare('INSERT INTO audit(event,actor_id,chat_id,turn_id,detail,created_at) VALUES(?,?,?,?,?,?)')
      .run(event, context.senderId ?? null, context.chatId ?? null, context.turnId ?? null, JSON.stringify(detail), Date.now());
  }
  close() { if (!this.closed) { this.database.close(); this.closed = true; } }
}
export function openDatabase(path) { return new Store({ path }); }
export default Store;
