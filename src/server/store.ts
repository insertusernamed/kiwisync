import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Change, Device, Platform, Replacement } from '../shared/protocol';

export interface FileRow {
  path: string;
  blob: string | null;
  lastBlob: string | null;
  size: number;
  mtime: number;
  editedAt: number;
  device: string;
  seq: number;
}

export interface DeviceRow extends Device {
  removed: boolean;
}

export const HUB_ID = 'hub';
const INVITE_MINUTES = 15;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Row = Record<string, string | number | null>;

export class Store {
  private db: DatabaseSync;
  readonly serverId: string;

  constructor(file: string, hubName: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        blob TEXT,
        last_blob TEXT,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        edited_at INTEGER NOT NULL,
        device TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_seq ON files (seq);
      CREATE INDEX IF NOT EXISTS files_key ON files (key);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        pending INTEGER NOT NULL DEFAULT 0,
        removed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS replacements (
        device TEXT NOT NULL,
        path TEXT NOT NULL,
        by_device TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
    const id = this.db.prepare(`SELECT value FROM meta WHERE key = 'server_id'`).get() as
      Row | undefined;
    this.serverId = id ? String(id.value) : randomUUID();
    this.db
      .prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('server_id', ?), ('seq', '0')`)
      .run(this.serverId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO devices (id, name, platform, created_at) VALUES (?, ?, 'hub', ?)`,
      )
      .run(HUB_ID, hubName, Date.now());
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  latest(): number {
    return Number((this.db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get() as Row).value);
  }

  file(path: string): FileRow | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as Row | undefined;
    return row && toFile(row);
  }

  liveFileByKey(key: string): FileRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM files WHERE key = ? AND blob IS NOT NULL')
      .get(key) as Row | undefined;
    return row && toFile(row);
  }

  liveFiles(): FileRow[] {
    return (this.db.prepare('SELECT * FROM files WHERE blob IS NOT NULL').all() as Row[]).map(
      toFile,
    );
  }

  // Records a new current version and gives it the next change number.
  saveFile(file: Omit<FileRow, 'seq' | 'lastBlob'>, key: string): number {
    return this.transaction(() => {
      const seq = this.latest() + 1;
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'seq'`).run(String(seq));
      this.db
        .prepare(
          `INSERT INTO files (path, key, blob, last_blob, size, mtime, edited_at, device, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET
             blob = excluded.blob,
             last_blob = COALESCE(excluded.blob, files.blob, files.last_blob),
             size = excluded.size, mtime = excluded.mtime, edited_at = excluded.edited_at,
             device = excluded.device, seq = excluded.seq`,
        )
        .run(
          file.path,
          key,
          file.blob,
          file.blob,
          file.size,
          file.mtime,
          file.editedAt,
          file.device,
          seq,
        );
      return seq;
    });
  }

  // Remembers the file's size and time on disk after the hub wrote it, so the next disk scan
  // knows the file is unchanged without reading it.
  touchFile(path: string, size: number, mtime: number): void {
    this.db.prepare('UPDATE files SET size = ?, mtime = ? WHERE path = ?').run(size, mtime, path);
  }

  changes(since: number, limit: number): Change[] {
    return (
      this.db
        .prepare('SELECT path, blob, seq FROM files WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(since, limit) as Row[]
    ).map((r) => ({ path: String(r.path), blob: r.blob as string | null, seq: Number(r.seq) }));
  }

  deletedFiles(limit: number): FileRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM files WHERE blob IS NULL AND last_blob IS NOT NULL ORDER BY edited_at DESC LIMIT ?',
        )
        .all(limit) as Row[]
    ).map(toFile);
  }

  // Remembers to tell a device that its edit was replaced, the next time it syncs.
  addReplacement(device: string, path: string, byDevice: string): void {
    this.db
      .prepare('INSERT INTO replacements (device, path, by_device) VALUES (?, ?, ?)')
      .run(device, path, byDevice);
  }

  takeReplacements(device: string): Replacement[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare('SELECT path, by_device FROM replacements WHERE device = ?')
        .all(device) as Row[];
      this.db.prepare('DELETE FROM replacements WHERE device = ?').run(device);
      return rows.map((r) => ({
        path: String(r.path),
        by: this.device(String(r.by_device))?.name ?? 'another device',
      }));
    });
  }

  devices(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Row[]).map(
      toDevice,
    );
  }

  device(id: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    return row && toDevice(row);
  }

  deviceByToken(token: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash(token)) as
      Row | undefined;
    return row && toDevice(row);
  }

  findDevice(nameOrId: string): DeviceRow | undefined {
    const wanted = nameOrId.toLowerCase();
    return this.devices().find(
      (d) => !d.removed && (d.id === nameOrId || d.name.toLowerCase() === wanted),
    );
  }

  addDevice(name: string, platform: Platform): { device: DeviceRow; token: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO devices (id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, this.uniqueName(name, id), platform, hash(token), Date.now());
    return { device: this.device(id)!, token };
  }

  renameDevice(id: string, name: string): void {
    this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(this.uniqueName(name, id), id);
  }

  // The device's row stays so history keeps showing its name.
  removeDevice(id: string): void {
    this.db
      .prepare('UPDATE devices SET token_hash = NULL, removed_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  seen(id: string, pending: number): void {
    this.db
      .prepare('UPDATE devices SET last_seen = ?, pending = ? WHERE id = ?')
      .run(Date.now(), pending, id);
  }

  createInvite(createdBy: string): { code: string; expiresAt: number } {
    const bytes = randomBytes(12);
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
    const expiresAt = Date.now() + INVITE_MINUTES * 60_000;
    this.db.prepare('DELETE FROM invites WHERE expires_at < ?').run(Date.now());
    this.db
      .prepare('INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)')
      .run(hash(raw), createdBy, expiresAt);
    return { code: raw.match(/.{4}/g)!.join('-'), expiresAt };
  }

  // Marks the invite used and returns whether it was valid, in one step so a code works once.
  claimInvite(code: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      )
      .run(Date.now(), hash(normalizeCode(code)), Date.now());
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }

  private uniqueName(name: string, id: string): string {
    const base = name.trim().slice(0, 60) || 'Device';
    const taken = new Set(
      this.devices()
        .filter((d) => d.id !== id && !d.removed)
        .map((d) => d.name.toLowerCase()),
    );
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    return candidate;
  }
}

// Codes are read aloud and typed on phones, so ambiguous letters map to the digits they resemble.
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toFile(r: Row): FileRow {
  return {
    path: String(r.path),
    blob: r.blob as string | null,
    lastBlob: r.last_blob as string | null,
    size: Number(r.size),
    mtime: Number(r.mtime),
    editedAt: Number(r.edited_at),
    device: String(r.device),
    seq: Number(r.seq),
  };
}

function toDevice(r: Row): DeviceRow {
  return {
    id: String(r.id),
    name: String(r.name),
    platform: r.platform as Platform,
    lastSeen: r.last_seen === null ? null : Number(r.last_seen),
    pending: Number(r.pending),
    removed: r.removed_at !== null,
  };
}
