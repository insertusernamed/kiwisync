import { blobId } from '../shared/blob';
import { isSyncPath } from '../shared/paths';
import { Api, ApiError } from './api';

export interface LocalFile {
  path: string;
  size: number;
  mtime: number;
}

export interface LocalVault {
  list(): Promise<LocalFile[]>;
  stat(path: string): Promise<LocalFile | null>;
  read(path: string): Promise<(LocalFile & { bytes: Uint8Array }) | null>;
  // Writes only while the file still holds the `expected` version (null: the file must not
  // exist), so an edit made in the meantime is never overwritten. Returns whether it wrote.
  write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean>;
  // Same rule as write. A file that is already gone counts as removed.
  remove(path: string, expected: string): Promise<boolean>;
}

export interface SyncState {
  serverId: string | null;
  cursor: number;
  offset: number;
  // The server version each local file was last in step with, and its size and time then.
  files: Record<string, LocalFile & { blob: string }>;
  // Files with local changes not yet uploaded, and when they were edited (server clock).
  dirty: Record<string, number>;
}

export interface SyncListener {
  // Part or all of a local edit was replaced by a newer edit from another device.
  replaced(path: string, by: string): void;
  disconnected(message: string): void;
}

export type JoinMode = 'hub' | 'merge';

export function emptyState(): SyncState {
  return { serverId: null, cursor: 0, offset: 0, files: {}, dirty: {} };
}

// Client errors that retrying will not fix. The file is skipped until it is edited again.
const PERMANENT = new Set([400, 409, 413]);

export class SyncEngine {
  readonly errors = new Map<string, string>();
  lastSync: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private vault: LocalVault,
    private api: Api,
    readonly state: SyncState,
    private save: (state: SyncState) => Promise<void>,
    private listener: SyncListener,
  ) {
    api.offset = state.offset;
    api.pending = this.pending();
  }

  pending(): number {
    return Object.keys(this.state.dirty).length + this.errors.size;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  noteEdit(path: string): void {
    if (!isSyncPath(path)) return;
    this.state.dirty[path] = Math.max(this.state.dirty[path] ?? 0, this.api.now());
    this.errors.delete(path);
  }

  // Runs one sync, or if one is already running, one more right after it.
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // Prepares a device that already has notes the first time it connects.
  // 'hub' saves this device's files on a history branch and then takes the hub's copy.
  // 'merge' uploads everything, keeping the newer version of files that exist on both sides.
  async join(mode: JoinMode, label: string): Promise<string | null> {
    const local = await this.vault.list();
    if (mode === 'merge') {
      for (const f of local) this.state.dirty[f.path] = f.mtime + this.api.offset;
      await this.save(this.state);
      return null;
    }
    const remote = new Map<string, string>();
    for (let since = 0, more = true; more;) {
      const page = await this.api.changes(since, null);
      for (const c of page.changes) {
        if (c.blob) remote.set(c.path, c.blob);
        else remote.delete(c.path);
      }
      since = page.changes.at(-1)?.seq ?? page.latest;
      more = page.more;
    }
    const snapshot: { path: string; blob: string }[] = [];
    const differing: { path: string; blob: string }[] = [];
    for (const f of local) {
      const file = await this.vault.read(f.path);
      if (!file) continue;
      const blob = await blobId(file.bytes);
      snapshot.push({ path: f.path, blob });
      if (remote.get(f.path) === blob) {
        this.state.files[f.path] = { path: f.path, size: file.size, mtime: file.mtime, blob };
      } else {
        await this.api.uploadBlob(file.bytes);
        differing.push({ path: f.path, blob });
      }
    }
    const branch = differing.length ? await this.api.snapshot(label, snapshot) : null;
    for (const f of differing) await this.vault.remove(f.path, f.blob);
    await this.save(this.state);
    return branch;
  }

  private async cycle(): Promise<void> {
    try {
      await this.scan();
      await this.push();
      await this.pull();
      this.lastSync = Date.now();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.listener.disconnected(e.message);
      throw e;
    } finally {
      this.state.offset = this.api.offset;
      this.api.pending = this.pending();
      await this.save(this.state);
    }
  }

  // Catches changes made while the app was closed or that no file event reported.
  private async scan(): Promise<void> {
    const { files, dirty } = this.state;
    const present = new Set<string>();
    for (const f of await this.vault.list()) {
      present.add(f.path);
      const known = files[f.path];
      if (f.path in dirty || this.errors.has(f.path)) continue;
      if (!known || known.size !== f.size || known.mtime !== f.mtime)
        dirty[f.path] = f.mtime + this.api.offset;
    }
    for (const path of Object.keys(files))
      if (!present.has(path) && !(path in dirty) && !this.errors.has(path))
        dirty[path] = this.api.now();
  }

  private async push(): Promise<void> {
    for (const [path, edited] of Object.entries(this.state.dirty)) {
      try {
        const done = await this.upload(path, edited);
        // An edit made while uploading leaves a newer time, so the file is uploaded again.
        if (done && this.state.dirty[path] === edited) delete this.state.dirty[path];
      } catch (e) {
        if (!(e instanceof ApiError) || !PERMANENT.has(e.status)) throw e;
        this.errors.set(path, e.message);
        delete this.state.dirty[path];
      }
    }
  }

  private async upload(path: string, edited: number): Promise<boolean> {
    const { files } = this.state;
    const known = files[path];
    const file = await this.vault.read(path);

    if (!file) {
      if (!known) return true;
      const result = await this.api.remove(path, known.blob, edited);
      if (result.outcome === 'deleted') {
        delete files[path];
        return true;
      }
      return this.download(path, result.blob!, null);
    }

    const blob = await blobId(file.bytes);
    if (blob === known?.blob) {
      files[path] = { path, size: file.size, mtime: file.mtime, blob };
      return true;
    }
    const result = await this.api.put(path, known?.blob ?? null, edited, file.bytes);
    if (result.lostTo) this.listener.replaced(path, result.lostTo);
    if (result.blob === null) {
      if (!(await this.vault.remove(path, blob))) return false;
      delete files[path];
      return true;
    }
    if (result.blob === blob) {
      files[path] = { path, size: file.size, mtime: file.mtime, blob };
      return true;
    }
    if (await this.download(path, result.blob, blob)) return true;
    // Edited again during the upload. The server has this upload, so it becomes the base the
    // next upload is merged against.
    files[path] = { path, size: file.size, mtime: file.mtime, blob };
    return false;
  }

  private async pull(): Promise<void> {
    const { files, dirty } = this.state;
    for (let more = true; more;) {
      const page = await this.api.changes(this.state.cursor, this.state.serverId);
      this.state.serverId = page.serverId;
      for (const r of page.replaced) this.listener.replaced(r.path, r.by);
      for (const change of page.changes) {
        const { path, blob } = change;
        // Local edits go up first on the next push, where the server combines them.
        if (path in dirty || this.errors.has(path) || !isSyncPath(path)) continue;
        const known = files[path];
        if (blob === null) {
          if (known && (await this.vault.remove(path, known.blob))) delete files[path];
          else if (known) dirty[path] = this.api.now();
        } else if (
          blob !== known?.blob &&
          !(await this.download(path, blob, known?.blob ?? null))
        ) {
          const local = await this.vault.stat(path);
          dirty[path] = local ? local.mtime + this.api.offset : this.api.now();
        }
      }
      this.state.cursor = page.changes.at(-1)?.seq ?? page.latest;
      more = page.more;
      await this.save(this.state);
    }
  }

  private async download(path: string, blob: string, expected: string | null): Promise<boolean> {
    const bytes = await this.api.blob(blob);
    if (!(await this.vault.write(path, bytes, expected))) return false;
    const written = await this.vault.stat(path);
    if (written) this.state.files[path] = { ...written, blob };
    return true;
  }
}
