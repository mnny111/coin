import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs (mint TEXT PRIMARY KEY, creator TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, created INTEGER NOT NULL, signature TEXT NOT NULL, pool TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, mint TEXT NOT NULL REFERENCES pairs(mint), time INTEGER NOT NULL, amount TEXT NOT NULL, trader TEXT NOT NULL, signature TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trades_time ON trades(time, mint);
      CREATE TABLE IF NOT EXISTS fees (id TEXT PRIMARY KEY, time INTEGER NOT NULL, amount TEXT NOT NULL, buyback TEXT NOT NULL, rewards TEXT NOT NULL, treasury TEXT NOT NULL, signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (start INTEGER PRIMARY KEY, end INTEGER NOT NULL, pot TEXT NOT NULL, winners TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount TEXT NOT NULL, recipient TEXT, round INTEGER, status TEXT NOT NULL DEFAULT 'planned', signature TEXT, wire TEXT, expiry INTEGER, details TEXT NOT NULL DEFAULT '{}', error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    `);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key, value) {
    if (value === undefined) return this.get('SELECT value FROM settings WHERE key=?', key)?.value ?? null;
    this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  }
  audit(action, detail) { this.run('INSERT INTO audit(time,action,detail) VALUES (?,?,?)', Math.floor(Date.now()/1000), action, JSON.stringify(detail)); }
  acquire(owner, now, seconds = 300) {
    return this.transaction(() => {
      const old = this.get('SELECT * FROM lease WHERE id=1');
      if (old && old.owner !== owner && old.expires > now) return false;
      this.run('INSERT INTO lease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires', owner, now + seconds);
      return true;
    });
  }
  close() { this.db.close(); }
}
