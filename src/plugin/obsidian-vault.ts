import { TFile, TFolder, type App } from 'obsidian';
import { blobId } from '../shared/blob';
import { isSyncPath } from '../shared/paths';
import type { LocalFile, LocalVault } from './sync';

const TEXT = new Set(['md', 'txt', 'canvas', 'json', 'css', 'csv', 'svg', 'html']);
// Keeps a byte order mark, so text written back has exactly the bytes that were synced.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class ChangedMeanwhile extends Error {}

export class ObsidianVault implements LocalVault {
  constructor(private app: App) {}

  async list(): Promise<LocalFile[]> {
    return this.app.vault
      .getFiles()
      .filter((f) => isSyncPath(f.path))
      .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  async stat(path: string): Promise<LocalFile | null> {
    const file = this.file(path);
    return file && { path, size: file.stat.size, mtime: file.stat.mtime };
  }

  async read(path: string) {
    const file = this.file(path);
    if (!file) return null;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    return { path, size: file.stat.size, mtime: file.stat.mtime, bytes };
  }

  async write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean> {
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
    const file = this.file(path);
    if (!file) return true;
    if ((await blobId(new Uint8Array(await this.app.vault.readBinary(file)))) !== expected)
      return false;
    await this.app.vault.trash(file, false);
    return true;
  }

  private file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async createParents(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
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
