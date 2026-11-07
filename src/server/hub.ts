import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMergeable, isSyncPath, pathKey } from '../shared/paths';
import type {
  DeleteResponse,
  DeletedFile,
  HistoryEntry,
  HistoryKind,
  PutResponse,
} from '../shared/protocol';
import { REPLACED_BRANCH, type Author, type FileChange, type Repo } from './repo';
import { HUB_ID, type FileRow, type Store } from './store';

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
};

// Owns the vault folder. Every change, whether uploaded by a device or made directly on this
// machine, goes through here one at a time, is written to disk, and is committed to git.
export class Hub {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private oversized = new Set<string>();
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
    const full = this.full(path);
    let disk: DiskFile = { size: 0, mtime: 0 };
    if (bytes) {
      await mkdir(dirname(full), { recursive: true });
      const temp = join(dirname(full), `.kiwisync-${randomUUID()}`);
      await writeFile(temp, bytes);
      await rename(temp, full);
      const s = await lstat(full);
      disk = { size: s.size, mtime: s.mtimeMs };
    } else {
      await unlink(full).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
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

  private async scanNow(only?: string[]): Promise<number> {
    const disk = only ? await this.statPaths(only) : await this.walk();
    const changes: (FileChange & DiskFile & { editedAt: number })[] = [];
    for (const [path, stat] of disk) {
      const row = this.store.file(path);
      if (row?.blob && row.size === stat.size && row.mtime === stat.mtime) continue;
      if (stat.size > this.maxFileBytes) {
        if (!this.oversized.has(path))
          console.warn(`Not syncing ${path}: larger than the file limit.`);
        this.oversized.add(path);
        continue;
      }
      const blob = await this.repo.writeBlob(await readFile(this.full(path)));
      if (row?.blob === blob) this.store.touchFile(path, stat.size, stat.mtime);
      else changes.push({ path, blob, ...stat, editedAt: Math.round(stat.mtime) });
    }
    const tracked = only
      ? only.map((p) => this.store.file(p)).filter((r): r is FileRow => !!r?.blob)
      : this.store.liveFiles();
    for (const row of tracked)
      if (!disk.has(row.path))
        changes.push({ path: row.path, blob: null, size: 0, mtime: 0, editedAt: Date.now() });
    if (!changes.length) return 0;

    this.session = null;
    const time = Math.max(...changes.map((c) => c.editedAt));
    const subject =
      changes.length === 1
        ? `${changes[0]!.blob ? 'Edit' : 'Delete'} ${changes[0]!.path}`
        : `Edit ${changes.length} files`;
    await this.repo.commit(changes, this.author(HUB_ID, time), 'edit', subject);
    for (const c of changes)
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
      );
    this.notify();
    return changes.length;
  }

  private async walk(): Promise<Map<string, DiskFile>> {
    const found = new Map<string, DiskFile>();
    const visit = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) {
          const path = relative(this.vault, full).split(sep).join('/');
          if (!isSyncPath(path)) continue;
          const s = await lstat(full);
          found.set(path, { size: s.size, mtime: s.mtimeMs });
        }
      }
    };
    await visit(this.vault);
    return found;
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

function checkPath(path: string): void {
  if (!isSyncPath(path)) throw new HttpError(400, `KiwiSync does not sync "${path}".`);
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
