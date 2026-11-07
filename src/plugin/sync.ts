import { blobId } from '../shared/blob';
import {
  FOLDER,
  PLUGIN_LIST,
  configCategory,
  isFolderPath,
  isSyncPath,
  mergePluginLists,
} from '../shared/paths';
import { Api, ApiError } from './api';

export interface LocalFile {
  path: string;
  size: number;
  mtime: number;
}

// Paths are as the hub names them; settings live under `.obsidian/` whatever the device calls
// its settings folder. Folders are listed with a trailing slash and a size and time of 0.
export interface LocalVault {
  list(): Promise<LocalFile[]>;
  stat(path: string): Promise<LocalFile | null>;
  read(path: string): Promise<(LocalFile & { bytes: Uint8Array }) | null>;
  // Writes only while the file still holds the `expected` version (null: the file must not
  // exist), so an edit made in the meantime is never overwritten. Returns whether it wrote.
  write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean>;
  // Same rule as write. A file that is already gone counts as removed.
  remove(path: string, expected: string): Promise<boolean>;
  // Moves a file that still holds `expected` to a path that is free. Returns whether it moved.
  rename(from: string, to: string, expected: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  // Removes a folder only if it is empty. A folder that is already gone counts as removed.
  removeFolder(path: string): Promise<boolean>;
}

export interface SyncState {
  serverId: string | null;
  cursor: number;
  offset: number;
  // The server version each local file was last in step with, and its size and time then.
  files: Record<string, LocalFile & { blob: string }>;
  // Files with local changes not yet uploaded, and when they were edited (server clock).
  dirty: Record<string, number>;
  // Local renames not yet sent, from new path to old path.
  renames: Record<string, string>;
}

export interface SyncListener {
  // Part or all of a local edit was replaced by a newer edit from another device.
  replaced(path: string, by: string): void;
  disconnected(message: string): void;
  // Plugins, themes, or settings were changed on disk; Obsidian applies them after a reload.
  settingsChanged(): void;
}

export type JoinMode = 'hub' | 'merge';

export function emptyState(): SyncState {
  return { serverId: null, cursor: 0, offset: 0, files: {}, dirty: {}, renames: {} };
}

// Client errors that retrying will not fix. The file is skipped until it is edited again.
const PERMANENT = new Set([400, 409, 413]);

export class SyncEngine {
  readonly errors = new Map<string, string>();
  lastSync: number | null = null;
  // Which paths this device syncs: notes always, settings only for the groups turned on.
  wanted: (path: string) => boolean = (path) => isSyncPath(path) || isFolderPath(path);
  private running: Promise<void> | null = null;
  private again = false;
  private settingsTouched = false;

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
    if (!this.wanted(path)) return;
    this.state.dirty[path] = Math.max(this.state.dirty[path] ?? 0, this.api.now());
    this.errors.delete(path);
  }

  noteRename(from: string, to: string): void {
    const { renames } = this.state;
    if (this.wanted(from) && this.wanted(to)) {
      // A file renamed twice before syncing is one rename from its original path.
      const origin = renames[from] ?? from;
      delete renames[from];
      if (origin !== to) renames[to] = origin;
    }
    this.noteEdit(from);
    this.noteEdit(to);
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
    const local = (await this.vault.list()).filter((f) => this.wanted(f.path));
    if (mode === 'merge') {
      for (const f of local) this.state.dirty[f.path] = f.mtime + this.api.offset;
      await this.save(this.state);
      return null;
    }
    const remote = await this.remoteFiles();
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

  // Starts syncing a group of settings on this device. Files the hub also has take the hub's
  // version, after this device's copies are saved on a history branch. Files only here are
  // uploaded, and the lists of enabled plugins are combined. Call after widening `wanted`.
  async adopt(group: (path: string) => boolean, label: string): Promise<string | null> {
    const remote = new Map([...(await this.remoteFiles())].filter(([path]) => group(path)));
    const local = (await this.vault.list()).filter((f) => group(f.path));
    const backup: { path: string; blob: string }[] = [];
    const replace: { path: string; blob: string; theirs: string; bytes: Uint8Array }[] = [];
    for (const f of local) {
      const file = await this.vault.read(f.path);
      if (!file) continue;
      const blob = await blobId(file.bytes);
      const theirs = remote.get(f.path);
      remote.delete(f.path);
      if (!theirs) this.state.dirty[f.path] = f.mtime + this.api.offset;
      else if (theirs === blob) this.state.files[f.path] = { ...f, blob };
      else {
        await this.api.uploadBlob(file.bytes);
        backup.push({ path: f.path, blob });
        replace.push({ path: f.path, blob, theirs, bytes: file.bytes });
      }
    }
    const branch = backup.length ? await this.api.snapshot(label, backup) : null;
    const decoder = new TextDecoder();
    for (const r of replace) {
      let bytes = await this.api.blob(r.theirs);
      const combined =
        r.path === PLUGIN_LIST
          ? mergePluginLists(decoder.decode(bytes), decoder.decode(r.bytes))
          : null;
      if (combined !== null) bytes = new TextEncoder().encode(combined);
      if (!(await this.vault.write(r.path, bytes, r.blob))) continue;
      const stat = await this.vault.stat(r.path);
      if (stat) this.state.files[r.path] = { ...stat, blob: r.theirs };
      if (combined !== null) this.state.dirty[r.path] = this.api.now();
    }
    for (const [path, blob] of remote) await this.download(path, blob, null);
    if (replace.length || remote.size) this.settingsTouched = true;
    await this.save(this.state);
    this.reportSettings();
    return branch;
  }

  // Stops syncing paths in a group. The files stay on this device.
  forget(group: (path: string) => boolean): void {
    for (const path of Object.keys(this.state.files))
      if (group(path)) delete this.state.files[path];
    for (const path of Object.keys(this.state.dirty))
      if (group(path)) delete this.state.dirty[path];
  }

  private async remoteFiles(): Promise<Map<string, string>> {
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
    return remote;
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
      this.reportSettings();
    }
  }

  // Catches changes made while the app was closed or that no file event reported.
  private async scan(): Promise<void> {
    const { files, dirty } = this.state;
    const present = new Set<string>();
    for (const f of await this.vault.list()) {
      if (!this.wanted(f.path)) continue;
      present.add(f.path);
      const known = files[f.path];
      if (f.path in dirty || this.errors.has(f.path)) continue;
      if (!known || known.size !== f.size || known.mtime !== f.mtime)
        dirty[f.path] = f.mtime + this.api.offset;
    }
    for (const path of Object.keys(files))
      if (this.wanted(path) && !present.has(path) && !(path in dirty) && !this.errors.has(path))
        dirty[path] = this.api.now();
  }

  private async push(): Promise<void> {
    await this.sendRenames();
    for (const [path, edited] of await this.uploadOrder()) {
      try {
        const done = isFolderPath(path)
          ? await this.uploadFolder(path)
          : await this.upload(path, edited);
        // An edit made while uploading leaves a newer time, so the file is uploaded again.
        if (done && this.state.dirty[path] === edited) delete this.state.dirty[path];
      } catch (e) {
        if (!(e instanceof ApiError) || !PERMANENT.has(e.status)) throw e;
        this.errors.set(path, e.message);
        delete this.state.dirty[path];
      }
    }
  }

  // Files go first, so a deleted folder is already empty when its deletion arrives. Folders
  // are then created outermost first and deleted innermost first.
  private async uploadOrder(): Promise<[string, number][]> {
    const entries = Object.entries(this.state.dirty);
    const folders: [string, number, boolean][] = [];
    for (const [path, edited] of entries)
      if (isFolderPath(path)) folders.push([path, edited, !!(await this.vault.stat(path))]);
    folders.sort(([a, , aExists], [b, , bExists]) =>
      aExists !== bExists
        ? aExists
          ? -1
          : 1
        : aExists
          ? depth(a) - depth(b)
          : depth(b) - depth(a),
    );
    return [
      ...entries.filter(([path]) => !isFolderPath(path)),
      ...folders.map(([path, edited]): [string, number] => [path, edited]),
    ];
  }

  private async uploadFolder(path: string): Promise<boolean> {
    const { files } = this.state;
    const exists = !!(await this.vault.stat(path));
    if (exists === !!files[path]) return true;
    if (exists) {
      await this.api.createFolder(path);
      files[path] = { path, size: 0, mtime: 0, blob: FOLDER };
      return true;
    }
    const result = await this.api.removeFolder(path);
    if (result.outcome === 'deleted') delete files[path];
    // Another device added something here this device has not seen yet; it arrives next pull.
    else await this.vault.createFolder(path);
    return true;
  }

  // A rename moves the file and its history on the hub. Anything that makes it impossible,
  // such as the old file being gone there, falls back to a deletion and a new file.
  private async sendRenames(): Promise<void> {
    const { files, renames } = this.state;
    for (const [to, from] of Object.entries(renames)) {
      delete renames[to];
      const known = files[from];
      if (!known || files[to] || (await this.vault.stat(from)) || !(await this.vault.stat(to)))
        continue;
      try {
        await this.api.rename(from, to);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) continue;
        throw e;
      }
      // The local file still derives from the version known under the old name. Uploading it
      // against that base combines it with anything changed on the hub meanwhile.
      files[to] = { ...known, path: to, size: -1 };
      delete files[from];
      delete this.state.dirty[from];
      this.state.dirty[to] ??= this.api.now();
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
    if (result.lostTo) this.listener.replaced(result.movedTo ?? path, result.lostTo);

    if (result.movedTo) {
      // Another device renamed this file; the edit was applied at its new path.
      const target = result.movedTo;
      delete files[path];
      if (!(await this.vault.rename(path, target, blob))) return this.vault.remove(path, blob);
      if (result.blob === blob) {
        const stat = await this.vault.stat(target);
        if (stat) files[target] = { ...stat, blob };
        return true;
      }
      return this.download(target, result.blob!, blob);
    }
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
        const { path, blob, from } = change;
        // Local edits go up first on the next push, where the server combines them.
        if (path in dirty || this.errors.has(path) || !this.wanted(path)) continue;
        if (isFolderPath(path)) {
          await this.applyFolder(path, blob);
          continue;
        }
        // Renamed on another device: move the local file so an open note stays open. The old
        // path's deletion comes next and finds nothing left to delete.
        const source = from ? files[from] : undefined;
        if (from && source && !files[path] && !(from in dirty)) {
          if (await this.vault.rename(from, path, source.blob)) {
            files[path] = { ...source, path };
            delete files[from];
            if (configCategory(path)) this.settingsTouched = true;
          }
        }
        const known = files[path];
        if (blob === null) {
          if (known && (await this.vault.remove(path, known.blob))) {
            delete files[path];
            if (configCategory(path)) this.settingsTouched = true;
          } else if (known) dirty[path] = this.api.now();
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

  private async applyFolder(path: string, blob: string | null): Promise<void> {
    const { files, dirty } = this.state;
    if (blob) {
      await this.vault.createFolder(path);
      files[path] = { path, size: 0, mtime: 0, blob: FOLDER };
    } else if (await this.vault.removeFolder(path)) delete files[path];
    // Still holds files not uploaded yet, so this device puts the folder back on the hub.
    else dirty[path] = this.api.now();
  }

  private async download(path: string, blob: string, expected: string | null): Promise<boolean> {
    const bytes = await this.api.blob(blob);
    if (!(await this.vault.write(path, bytes, expected))) return false;
    const written = await this.vault.stat(path);
    if (written) this.state.files[path] = { ...written, blob };
    if (configCategory(path)) this.settingsTouched = true;
    return true;
  }

  private reportSettings(): void {
    if (!this.settingsTouched) return;
    this.settingsTouched = false;
    this.listener.settingsChanged();
  }
}

function depth(folder: string): number {
  return folder.split('/').length;
}
