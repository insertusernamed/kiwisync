import { TFile, TFolder, type App } from 'obsidian';
import { blobId } from '../shared/blob';
import { CONFIG_DIR, configCategory, isFolderPath, isSyncPath } from '../shared/paths';
import type { LocalFile, LocalVault } from './sync';

const TEXT = new Set(['md', 'txt', 'canvas', 'json', 'css', 'csv', 'svg', 'html']);
// Keeps a byte order mark, so text written back has exactly the bytes that were synced.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class ChangedMeanwhile extends Error {}

// Notes go through Obsidian's vault, which keeps open editors and links up to date. Settings
// live in a hidden folder the vault does not track, so they go straight to the file system.
export class ObsidianVault implements LocalVault {
  constructor(private app: App) {}

  async list(): Promise<LocalFile[]> {
    const notes = this.app.vault
      .getFiles()
      .filter((f) => isSyncPath(f.path))
      .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && isSyncPath(f.path))
      .map((f) => ({ path: `${f.path}/`, size: 0, mtime: 0 }));
    return [...notes, ...folders, ...(await this.listSettings())];
  }

  async stat(path: string): Promise<LocalFile | null> {
    if (isFolderPath(path)) return this.folder(path) ? { path, size: 0, mtime: 0 } : null;
    if (configCategory(path)) {
      const s = await this.app.vault.adapter.stat(this.local(path));
      return s?.type === 'file' ? { path, size: s.size, mtime: s.mtime } : null;
    }
    const file = this.file(path);
    return file && { path, size: file.stat.size, mtime: file.stat.mtime };
  }

  async read(path: string) {
    if (configCategory(path)) {
      const s = await this.stat(path);
      if (!s) return null;
      return {
        ...s,
        bytes: new Uint8Array(await this.app.vault.adapter.readBinary(this.local(path))),
      };
    }
    const file = this.file(path);
    if (!file) return null;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    return { path, size: file.stat.size, mtime: file.stat.mtime, bytes };
  }

  async write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean> {
    if (configCategory(path)) {
      const current = await this.read(path);
      const currentBlob = current && (await blobId(current.bytes));
      if (currentBlob === (await blobId(bytes))) return true;
      if (currentBlob !== expected) return false;
      await this.createSettingsFolders(path);
      await this.app.vault.adapter.writeBinary(this.local(path), bytes.slice().buffer);
      return true;
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error(`A folder named "${path}" is in the way.`);
    const data = bytes.slice().buffer;
    if (!existing) {
      if (expected !== null) return false;
      await this.createParents(path);
      await this.app.vault.createBinary(path, data);
      return true;
    }
    const file = existing as TFile;
    const current = new Uint8Array(await this.app.vault.readBinary(file));
    const currentBlob = await blobId(current);
    if (currentBlob === (await blobId(bytes))) return true;
    if (currentBlob !== expected) return false;

    // Text goes through Vault.process, which applies only if the note still has the contents
    // just checked, so typing in an open editor at this moment is not lost.
    const before = TEXT.has(file.extension) ? decode(current) : null;
    const after = before === null ? null : decode(bytes);
    if (before === null || after === null) {
      await this.app.vault.modifyBinary(file, data);
      return true;
    }
    try {
      await this.app.vault.process(file, (text) => {
        if (text !== before) throw new ChangedMeanwhile();
        return after;
      });
      return true;
    } catch (e) {
      if (e instanceof ChangedMeanwhile) return false;
      throw e;
    }
  }

  async remove(path: string, expected: string): Promise<boolean> {
    if (configCategory(path)) {
      const current = await this.read(path);
      if (!current) return true;
      if ((await blobId(current.bytes)) !== expected) return false;
      await this.app.vault.adapter.remove(this.local(path));
      await this.pruneSettingsFolders(path);
      return true;
    }
    const file = this.file(path);
    if (!file) return true;
    if ((await blobId(new Uint8Array(await this.app.vault.readBinary(file)))) !== expected)
      return false;
    await this.app.vault.trash(file, false);
    return true;
  }

  async createFolder(path: string): Promise<void> {
    await this.createFolders(path.replace(/\/$/, ''));
  }

  async removeFolder(path: string): Promise<boolean> {
    const folder = this.folder(path);
    if (!folder) return true;
    // Hidden files count, since the vault does not list them.
    const { files, folders } = await this.app.vault.adapter.list(folder.path);
    if (files.length || folders.length) return false;
    // Obsidian's non-recursive folder removal fails even on empty folders.
    await this.app.vault.delete(folder, true);
    return true;
  }

  async rename(from: string, to: string, expected: string): Promise<boolean> {
    if (configCategory(from) || configCategory(to)) {
      const current = await this.read(from);
      if (!current || (await this.stat(to)) || (await blobId(current.bytes)) !== expected)
        return false;
      await this.createSettingsFolders(to);
      await this.app.vault.adapter.rename(this.local(from), this.local(to));
      await this.pruneSettingsFolders(from);
      return true;
    }
    const file = this.file(from);
    if (!file || this.app.vault.getAbstractFileByPath(to)) return false;
    if ((await blobId(new Uint8Array(await this.app.vault.readBinary(file)))) !== expected)
      return false;
    await this.createParents(to);
    // Vault.rename, not FileManager.renameFile: links in other notes were already updated on
    // the device that renamed it, and those edits arrive separately.
    await this.app.vault.rename(file, to);
    return true;
  }

  // A plugin's folder goes with its last file. Stops at the settings folder itself. Obsidian's
  // non-recursive removal fails even on empty folders, so emptiness is checked first.
  private async pruneSettingsFolders(path: string): Promise<void> {
    const { adapter, configDir } = this.app.vault;
    const parts = this.local(path).split('/').slice(0, -1);
    while (parts.length > 1) {
      const dir = parts.join('/');
      if (dir === configDir) return;
      const { files, folders } = await adapter.list(dir);
      if (files.length || folders.length) return;
      await adapter.rmdir(dir, true);
      parts.pop();
    }
  }

  // Maps a path as the hub names it to this device's settings folder, which can be renamed.
  local(path: string): string {
    return path.startsWith(`${CONFIG_DIR}/`)
      ? this.app.vault.configDir + path.slice(CONFIG_DIR.length)
      : path;
  }

  canonical(local: string): string {
    const dir = this.app.vault.configDir;
    return local.startsWith(`${dir}/`) ? CONFIG_DIR + local.slice(dir.length) : local;
  }

  private async listSettings(): Promise<LocalFile[]> {
    const { adapter, configDir } = this.app.vault;
    if (!(await adapter.exists(configDir))) return [];
    const files: string[] = [];
    const top = await adapter.list(configDir);
    files.push(...top.files);
    for (const group of ['plugins', 'themes']) {
      const dir = `${configDir}/${group}`;
      if (!top.folders.includes(dir)) continue;
      for (const folder of (await adapter.list(dir)).folders)
        files.push(...(await adapter.list(folder)).files);
    }
    if (top.folders.includes(`${configDir}/snippets`))
      files.push(...(await adapter.list(`${configDir}/snippets`)).files);
    const found: LocalFile[] = [];
    for (const local of files) {
      const path = this.canonical(local);
      if (!configCategory(path)) continue;
      const s = await adapter.stat(local);
      if (s?.type === 'file') found.push({ path, size: s.size, mtime: s.mtime });
    }
    return found;
  }

  private async createSettingsFolders(path: string): Promise<void> {
    const parts = this.local(path).split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!(await this.app.vault.adapter.exists(folder)))
        await this.app.vault.adapter.mkdir(folder);
    }
  }

  private folder(path: string): TFolder | null {
    const folder = this.app.vault.getAbstractFileByPath(path.replace(/\/$/, ''));
    return folder instanceof TFolder ? folder : null;
  }

  private file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async createParents(path: string): Promise<void> {
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent) await this.createFolders(parent);
  }

  // Creates a folder and any folders above it that are missing.
  private async createFolders(dir: string): Promise<void> {
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (existing instanceof TFile) throw new Error(`A file named "${folder}" is in the way.`);
      if (!existing) await this.app.vault.createFolder(folder);
    }
  }
}

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
