import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONFIG_DIR,
  FOLDER,
  PLUGIN_LIST,
  configCategory,
  isFolderPath,
  isHubPath,
  isMergeable,
  normalizePluginList,
  parentFolders,
  pathKey,
} from '../shared/paths';
import type {
  DeleteResponse,
  DeletedFile,
  FolderResponse,
  HistoryEntry,
  HistoryKind,
  PutResponse,
  RenameResponse,
} from '../shared/protocol';
import { REPLACED_BRANCH, type Author, type FileChange, type Repo } from './repo';
import { HUB_ID, type FileRow, type RenameLink, type Store } from './store';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface DiskFile {
  size: number;
  mtime: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
// Devices upload about a second after typing pauses. Uploads of one note from one device that
// follow each other closely become a single history entry, covering at most ten minutes.
const EDIT_SESSION_GAP_MS = 2 * 60_000;
const EDIT_SESSION_MAX_MS = 10 * 60_000;
const VERBS: Record<HistoryKind, string> = {
  edit: 'Edit',
  delete: 'Delete',
  merge: 'Merge edits to',
  replaced: 'Replaced edit to',
  restore: 'Restore',
  import: 'Import',
  rename: 'Rename',
};

// Owns the vault folder. Every change, whether uploaded by a device or made directly on this
// machine, goes through here one at a time, is written to disk, and is committed to git.
export class Hub {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private oversized = new Set<string>();
  // Every folder seen by the last full scan, including hidden settings folders, for watching.
  folders: string[] = [];
  private session: {
    commit: string;
    path: string;
    device: string;
    started: number;
    last: number;
  } | null = null;

  constructor(
    readonly store: Store,
    readonly repo: Repo,
    readonly vault: string,
    readonly maxFileBytes: number,
  ) {}

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  put(path: string, base: string | null, editedAt: number, bytes: Uint8Array, deviceId: string) {
    return this.exclusive(() => this.putNow(path, base, editedAt, bytes, deviceId));
  }

  remove(path: string, base: string | null, editedAt: number, deviceId: string) {
    return this.exclusive(() => this.removeNow(path, base, editedAt, deviceId));
  }

  restore(path: string, blob: string, deviceId: string): Promise<PutResponse> {
    return this.exclusive(async () => {
      checkPath(path);
      const bytes = await this.repo.readBlob(blob);
      if (!bytes) throw new HttpError(404, 'That version is not in the history.');
      await this.scanNow([path]);
      const current = this.store.file(path);
      if (current?.blob === blob)
        return { outcome: 'unchanged', blob, seq: current.seq, lostTo: null };
      this.checkCase(path);
      const seq = await this.write(path, blob, bytes, Date.now(), deviceId, 'restore');
      return { outcome: 'saved', blob, seq, lostTo: null };
    });
  }

  // Finds edits made to the vault folder on this machine and commits them as the hub's own.
  scan(): Promise<number> {
    return this.exclusive(() => this.scanNow());
  }

  async history(path: string): Promise<HistoryEntry[]> {
    const [main, replaced] = await Promise.all([
      this.repo.log(path, 'HEAD', 200),
      this.repo.log(path, REPLACED_BRANCH, 200),
    ]);
    return [...main, ...replaced.map((e) => ({ ...e, kind: 'replaced' as const }))]
      .sort((a, b) => b.time - a.time)
      .map((e) => ({
        commit: e.commit,
        blob: e.blob,
        time: e.time,
        kind: e.kind,
        device: this.store.device(e.deviceId)?.name ?? e.author,
        ...(e.from ? { from: e.from } : {}),
      }));
  }

  deleted(): DeletedFile[] {
    return this.store.deletedFiles(200).map((f) => ({
      path: f.path,
      blob: f.lastBlob!,
      time: f.editedAt,
      device: this.deviceName(f.device),
    }));
  }

  // Moves a file and its history to a new path. The hub's current contents move, including
  // edits the renaming device has not seen; it uploads its own edits to the new path after.
  rename(from: string, to: string, deviceId: string): Promise<RenameResponse> {
    return this.exclusive(async () => {
      checkPath(from);
      checkPath(to);
      await this.scanNow([from, to]);
      const source = this.store.file(from);
      if (!source?.blob) throw new HttpError(404, `${from} is no longer on the hub.`);
      if (this.store.file(to)?.blob) throw new HttpError(409, `${to} already exists.`);
      const clash = this.store.liveFileByKey(pathKey(to));
      if (clash && clash.path !== from)
        throw new HttpError(409, `"${clash.path}" already exists with different capitalization.`);
      await mkdir(dirname(this.full(to)), { recursive: true });
      await rename(this.full(from), this.full(to));
      if (configCategory(from)) await pruneEmptyFolders(this.vault, from);
      const s = await lstat(this.full(to));
      this.session = null;
      await this.repo.commit(
        [
          { path: to, blob: source.blob },
          { path: from, blob: null },
        ],
        this.author(deviceId, Date.now()),
        'rename',
        `Rename ${from} to ${to}`,
      );
      // The rename keeps the file's edit time and author, so it does not count as a newer edit.
      const kept = { editedAt: source.editedAt, device: source.device };
      this.recordFolders(to, deviceId);
      const seq = this.store.saveFile(
        { path: to, blob: source.blob, size: s.size, mtime: s.mtimeMs, ...kept },
        pathKey(to),
        { renamedFrom: from },
      );
      this.store.saveFile({ path: from, blob: null, size: 0, mtime: 0, ...kept }, pathKey(from), {
        movedTo: to,
      });
      this.notify();
      return { blob: source.blob, seq };
    });
  }

  createFolder(path: string, deviceId: string): Promise<FolderResponse> {
    return this.exclusive(async () => {
      checkFolder(path);
      await mkdir(this.full(path), { recursive: true });
      const seq = this.recordFolders(path, deviceId);
      if (seq) this.notify();
      return { outcome: 'created', seq: seq || this.store.file(path)!.seq };
    });
  }

  // Removes an empty folder. A folder that still holds synced files or folders, or anything
  // on disk that is not hidden, is kept: the device asking has not seen those yet.
  removeFolder(path: string, deviceId: string): Promise<FolderResponse> {
    return this.exclusive(async () => {
      checkFolder(path);
      const row = this.store.file(path);
      const entries = await readdir(this.full(path)).catch(() => []);
      if (this.store.hasLiveInside(path) || entries.some((name) => !name.startsWith('.')))
        return { outcome: 'kept', seq: row?.seq ?? 0 };
      await rm(this.full(path), { recursive: true, force: true });
      if (!row?.blob) return { outcome: 'deleted', seq: row?.seq ?? 0 };
      const seq = this.saveFolder(path, null, deviceId);
      this.notify();
      return { outcome: 'deleted', seq };
    });
  }

  // Saves files on a branch of their own without changing the vault, such as a device's notes
  // before it takes the hub's copy.
  async snapshot(
    branch: string,
    subject: string,
    files: FileChange[],
    deviceId: string,
  ): Promise<void> {
    for (const f of files) {
      checkPath(f.path);
      if (!f.blob || !(await this.repo.hasBlob(f.blob)))
        throw new HttpError(400, `${f.path} was not uploaded.`);
    }
    const ref = `refs/heads/${branch}`;
    if (await this.repo.head(ref)) throw new HttpError(409, `The branch ${branch} already exists.`);
    const index = join(this.repo.dir, '.git', `kiwisync-${randomUUID()}.index`);
    try {
      await this.exclusive(() =>
        this.repo.commit(files, this.author(deviceId, Date.now()), 'import', subject, {
          ref,
          index,
          fresh: true,
        }),
      );
    } finally {
      await rm(index, { force: true });
    }
  }

  private async putNow(
    path: string,
    base: string | null,
    editedAt: number,
    bytes: Uint8Array,
    deviceId: string,
  ): Promise<PutResponse> {
    checkPath(path);
    if (bytes.length > this.maxFileBytes) throw new HttpError(413, `${path} is too large to sync.`);
    await this.scanNow([path]);
    const current = this.store.file(path);
    // An edit to a file another device has since renamed belongs at the new path.
    const target = current && !current.blob && base ? this.renamedTo(path) : null;
    if (target)
      return { ...(await this.putNow(target, base, editedAt, bytes, deviceId)), movedTo: target };
    bytes = normalized(path, bytes);
    const currentBlob = current?.blob ?? null;
    const blob = await this.repo.writeBlob(bytes);
    if (blob === currentBlob)
      return { outcome: 'unchanged', blob, seq: current!.seq, lostTo: null };
    if (!currentBlob) this.checkCase(path);

    if (base === currentBlob || !current) {
      const seq = await this.write(path, blob, bytes, editedAt, deviceId, 'edit');
      return { outcome: 'saved', blob, seq, lostTo: null };
    }

    // The file changed here after the device last synced it. The newer edit decides any part
    // both sides changed; the other version is kept on the replaced branch.
    const newer = editedAt > current.editedAt;
    const winner = this.deviceName(current.device);

    if (!currentBlob) {
      if (newer) {
        const seq = await this.write(path, blob, bytes, editedAt, deviceId, 'edit');
        return { outcome: 'saved', blob, seq, lostTo: null };
      }
      await this.keepReplaced(path, blob, editedAt, deviceId);
      return { outcome: 'deleted', blob: null, seq: current.seq, lostTo: winner };
    }

    const merged = base ? await this.tryMerge(path, base, current, blob, bytes, newer) : null;
    if (merged) {
      if (merged.conflicts && !newer) await this.keepReplaced(path, blob, editedAt, deviceId);
      if (merged.conflicts && newer) this.tellReplaced(current, path, deviceId);
      const result = (await this.repo.readBlob(merged.blob))!;
      const seq =
        merged.blob === currentBlob
          ? current.seq
          : await this.write(
              path,
              merged.blob,
              result,
              Math.max(editedAt, current.editedAt),
              deviceId,
              'merge',
            );
      return {
        outcome: 'merged',
        blob: merged.blob,
        seq,
        lostTo: merged.conflicts && !newer ? winner : null,
      };
    }

    if (newer) {
      this.tellReplaced(current, path, deviceId);
      const seq = await this.write(path, blob, bytes, editedAt, deviceId, 'edit');
      return { outcome: 'saved', blob, seq, lostTo: null };
    }
    await this.keepReplaced(path, blob, editedAt, deviceId);
    return { outcome: 'outdated', blob: currentBlob, seq: current.seq, lostTo: winner };
  }

  private async tryMerge(
    path: string,
    base: string,
    current: FileRow,
    blob: string,
    bytes: Uint8Array,
    newer: boolean,
  ): Promise<{ blob: string; conflicts: number } | null> {
    const currentBytes = await this.repo.readBlob(current.blob!);
    if (!currentBytes || !(await this.repo.hasBlob(base))) return null;
    const incoming = decode(bytes);
    const existing = decode(currentBytes);
    if (incoming === null || existing === null) return null;
    if (!isMergeable(path, incoming) || !isMergeable(path, existing)) return null;
    const plain = await this.repo.merge(base, current.blob!, blob);
    if (!plain.conflicts) return plain;
    const resolved = await this.repo.merge(base, current.blob!, blob, newer ? 'theirs' : 'ours');
    return { blob: resolved.blob, conflicts: plain.conflicts };
  }

  private async removeNow(
    path: string,
    base: string | null,
    editedAt: number,
    deviceId: string,
  ): Promise<DeleteResponse> {
    checkPath(path);
    await this.scanNow([path]);
    const current = this.store.file(path);
    if (!current?.blob) return { outcome: 'deleted', blob: null, seq: current?.seq ?? 0 };
    if (base !== current.blob) {
      if (editedAt <= current.editedAt)
        return { outcome: 'kept', blob: current.blob, seq: current.seq };
      this.tellReplaced(current, path, deviceId);
    }
    const seq = await this.write(path, null, null, editedAt, deviceId, 'delete');
    return { outcome: 'deleted', blob: null, seq };
  }

  // The replaced version is already in the main history, since it was current until now.
  private tellReplaced(current: FileRow, path: string, byDevice: string): void {
    if (current.device !== HUB_ID && current.device !== byDevice)
      this.store.addReplacement(current.device, path, byDevice);
  }

  private renamedTo(path: string): string | null {
    const seen = new Set<string>();
    let row = this.store.file(path);
    while (row && !row.blob && row.movedTo && !seen.has(row.path)) {
      seen.add(row.path);
      row = this.store.file(row.movedTo);
    }
    return row?.blob && row.path !== path ? row.path : null;
  }

  private async keepReplaced(path: string, blob: string, editedAt: number, deviceId: string) {
    await this.repo.commit(
      [{ path, blob }],
      this.author(deviceId, editedAt),
      'replaced',
      `${VERBS.replaced} ${path}`,
      {
        ref: `refs/heads/${REPLACED_BRANCH}`,
        index: join(this.repo.dir, '.git', 'kiwisync-replaced.index'),
      },
    );
  }

  private async write(
    path: string,
    blob: string | null,
    bytes: Uint8Array | null,
    editedAt: number,
    deviceId: string,
    kind: HistoryKind,
  ): Promise<number> {
    let disk: DiskFile = { size: 0, mtime: 0 };
    if (bytes) {
      disk = await this.writeDisk(path, bytes);
      this.recordFolders(path, deviceId);
    } else {
      await unlink(this.full(path)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      // A plugin's folder goes with its last file. Note folders are synced in their own right.
      if (configCategory(path)) await pruneEmptyFolders(this.vault, path);
    }
    const now = Date.now();
    const session = this.session;
    const fold =
      kind === 'edit' &&
      session?.path === path &&
      session.device === deviceId &&
      now - session.last < EDIT_SESSION_GAP_MS &&
      now - session.started < EDIT_SESSION_MAX_MS
        ? session
        : null;
    const commit = await this.repo.commit(
      [{ path, blob }],
      this.author(deviceId, editedAt),
      kind,
      `${VERBS[kind]} ${path}`,
      undefined,
      fold?.commit,
    );
    this.session =
      kind === 'edit'
        ? { commit, path, device: deviceId, started: fold?.started ?? now, last: now }
        : null;
    const seq = this.store.saveFile(
      { path, blob, ...disk, editedAt, device: deviceId },
      pathKey(path),
    );
    this.notify();
    return seq;
  }

  // Records the folders a path sits in, and the path itself if it is a folder, that are not
  // recorded yet. Returns the last change number used, or 0 if nothing was new.
  private recordFolders(path: string, deviceId: string): number {
    if (!isHubPath(path) || configCategory(path)) return 0;
    let seq = 0;
    for (const folder of [...parentFolders(path), ...(isFolderPath(path) ? [path] : [])])
      if (this.store.file(folder)?.blob !== FOLDER) seq = this.saveFolder(folder, FOLDER, deviceId);
    return seq;
  }

  private saveFolder(path: string, blob: string | null, deviceId: string): number {
    return this.store.saveFile(
      { path, blob, size: 0, mtime: 0, editedAt: Date.now(), device: deviceId },
      pathKey(path),
    );
  }

  private async writeDisk(path: string, bytes: Uint8Array): Promise<DiskFile> {
    const full = this.full(path);
    await mkdir(dirname(full), { recursive: true });
    const temp = join(dirname(full), `.kiwisync-${randomUUID()}`);
    await writeFile(temp, bytes);
    await rename(temp, full);
    const s = await lstat(full);
    return { size: s.size, mtime: s.mtimeMs };
  }

  private async scanNow(only?: string[]): Promise<number> {
    let folderChanges = 0;
    let disk: Map<string, DiskFile>;
    if (only) disk = await this.statPaths(only);
    else {
      const walked = await this.walk();
      disk = walked.files;
      folderChanges = this.syncFolders(walked.folders);
    }
    const changes: (FileChange & DiskFile & { editedAt: number })[] = [];
    for (let [path, stat] of disk) {
      const row = this.store.file(path);
      if (row?.blob && row.size === stat.size && row.mtime === stat.mtime) continue;
      if (stat.size > this.maxFileBytes) {
        if (!this.oversized.has(path))
          console.warn(`Not syncing ${path}: larger than the file limit.`);
        this.oversized.add(path);
        continue;
      }
      let bytes: Uint8Array = await readFile(this.full(path));
      const fixed = normalized(path, bytes);
      if (fixed !== bytes) {
        stat = await this.writeDisk(path, fixed);
        bytes = fixed;
      }
      const blob = await this.repo.writeBlob(bytes);
      if (row?.blob === blob) this.store.touchFile(path, stat.size, stat.mtime);
      else changes.push({ path, blob, ...stat, editedAt: Math.round(stat.mtime) });
    }
    const tracked = only
      ? only.map((p) => this.store.file(p)).filter((r): r is FileRow => !!r?.blob)
      : this.store.liveFiles();
    for (const row of tracked)
      if (!isFolderPath(row.path) && !disk.has(row.path))
        changes.push({ path: row.path, blob: null, size: 0, mtime: 0, editedAt: Date.now() });
    if (!changes.length) {
      if (folderChanges) this.notify();
      return folderChanges;
    }

    // A file that disappeared while a new one with the same contents appeared was moved.
    const links = new Map<string, RenameLink>();
    const added = new Map<string, string>();
    for (const c of changes)
      if (c.blob && !this.store.file(c.path)?.blob) added.set(c.blob, c.path);
    for (const c of changes) {
      const before = c.blob ? null : this.store.file(c.path)?.blob;
      const to = before && added.get(before);
      if (!to || links.has(to)) continue;
      links.set(to, { renamedFrom: c.path });
      links.set(c.path, { movedTo: to });
    }

    this.session = null;
    const time = Math.max(...changes.map((c) => c.editedAt));
    const [only1] = changes;
    const subject =
      changes.length === 1
        ? `${only1!.blob ? 'Edit' : 'Delete'} ${only1!.path}`
        : changes.length === 2 && links.size === 2
          ? `Rename ${changes.find((c) => !c.blob)!.path} to ${changes.find((c) => c.blob)!.path}`
          : `Edit ${changes.length} files`;
    await this.repo.commit(changes, this.author(HUB_ID, time), 'edit', subject);
    // New paths are recorded before deletions, so devices see a rename's target first.
    for (const c of [...changes].sort((a, b) => Number(!a.blob) - Number(!b.blob)))
      this.store.saveFile(
        {
          path: c.path,
          blob: c.blob,
          size: c.size,
          mtime: c.mtime,
          editedAt: c.editedAt,
          device: HUB_ID,
        },
        pathKey(c.path),
        links.get(c.path),
      );
    this.notify();
    return changes.length + folderChanges;
  }

  // Folders created or removed directly in the vault folder on this machine. New folders are
  // recorded outermost first and removed ones innermost first, the order devices apply them in.
  private syncFolders(onDisk: Set<string>): number {
    const recorded = new Set(this.store.liveFolders().map((r) => r.path));
    const added = [...onDisk].filter((f) => !recorded.has(f)).sort();
    const removed = [...recorded]
      .filter((f) => !onDisk.has(f))
      .sort()
      .reverse();
    for (const folder of added) this.saveFolder(folder, FOLDER, HUB_ID);
    for (const folder of removed) this.saveFolder(folder, null, HUB_ID);
    return added.length + removed.length;
  }

  private async walk(): Promise<{ files: Map<string, DiskFile>; folders: Set<string> }> {
    const files = new Map<string, DiskFile>();
    const folders = new Set<string>();
    const visited: string[] = [];
    const visit = async (dir: string) => {
      visited.push(dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const isConfig = dir === this.vault && entry.name === CONFIG_DIR;
        if (entry.name.startsWith('.') && !isConfig) continue;
        const path = relative(this.vault, full).split(sep).join('/');
        if (entry.isDirectory()) {
          if (isFolderPath(`${path}/`)) folders.add(`${path}/`);
          await visit(full);
        } else if (entry.isFile() && isHubPath(path)) {
          const s = await lstat(full);
          files.set(path, { size: s.size, mtime: s.mtimeMs });
        }
      }
    };
    await visit(this.vault);
    this.folders = visited;
    return { files, folders };
  }

  private async statPaths(paths: string[]): Promise<Map<string, DiskFile>> {
    const found = new Map<string, DiskFile>();
    for (const path of paths) {
      const s = await lstat(this.full(path)).catch(() => null);
      if (s?.isFile()) found.set(path, { size: s.size, mtime: s.mtimeMs });
    }
    return found;
  }

  private checkCase(path: string): void {
    const other = this.store.liveFileByKey(pathKey(path));
    if (other && other.path !== path)
      throw new HttpError(
        409,
        `"${other.path}" already exists. Names that differ only in capitalization clash on iPhone.`,
      );
  }

  private full(path: string): string {
    return join(this.vault, ...path.split('/'));
  }

  private deviceName(id: string): string {
    return this.store.device(id)?.name ?? 'another device';
  }

  private author(deviceId: string, time: number): Author {
    return { name: this.deviceName(deviceId), email: `${deviceId}@kiwisync`, time };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// Removes the folders above `path` that are left empty, stopping at the first one that is not
// and never removing the root or the settings folder itself. Used for settings folders, which
// are not synced as folders.
export async function pruneEmptyFolders(root: string, path: string): Promise<void> {
  const parts = path.split('/').slice(0, -1);
  while (parts.length && parts.join('/') !== CONFIG_DIR) {
    try {
      await rmdir(join(root, ...parts));
    } catch {
      return;
    }
    parts.pop();
  }
}

function checkPath(path: string): void {
  if (!isHubPath(path) || isFolderPath(path))
    throw new HttpError(400, `KiwiSync does not sync "${path}".`);
}

function checkFolder(path: string): void {
  if (!isFolderPath(path)) throw new HttpError(400, `"${path}" is not a folder path.`);
}

function normalized(path: string, bytes: Uint8Array): Uint8Array {
  if (path !== PLUGIN_LIST) return bytes;
  const text = decode(bytes);
  const fixed = text === null ? null : normalizePluginList(text);
  return fixed === null || fixed === text ? bytes : new TextEncoder().encode(fixed);
}

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'device'
  );
}
