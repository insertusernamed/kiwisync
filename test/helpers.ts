import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { blobId } from '../src/shared/blob';
import { isHubPath } from '../src/shared/paths';
import { readConfig } from '../src/server/config';
import { makeServer } from '../src/server/http';
import { openHub } from '../src/server/open';
import { HUB_ID } from '../src/server/store';
import { pruneEmptyFolders } from '../src/server/hub';
import { Api, type Fetcher } from '../src/plugin/api';
import { SyncEngine, emptyState, type LocalFile, type LocalVault } from '../src/plugin/sync';

export const fetcher: Fetcher = async ({ url, method, headers, body }) => {
  const response = await fetch(url, { method, headers, body });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.arrayBuffer(),
  };
};

// A plain folder standing in for an Obsidian vault. `skew` shifts its clock, including file
// modification times, the way a device with a wrong clock would see them.
export class FolderVault implements LocalVault {
  constructor(
    readonly root: string,
    readonly skew = 0,
  ) {}

  async list(): Promise<LocalFile[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    const files: LocalFile[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = relative(this.root, join(e.parentPath, e.name)).split(sep).join('/');
      if (isHubPath(path)) files.push((await this.stat(path))!);
    }
    return files;
  }

  async stat(path: string): Promise<LocalFile | null> {
    const s = await stat(this.full(path)).catch(() => null);
    return s ? { path, size: s.size, mtime: Math.round(s.mtimeMs) + this.skew } : null;
  }

  async read(path: string) {
    const s = await this.stat(path);
    return s && { ...s, bytes: new Uint8Array(await readFile(this.full(path))) };
  }

  async write(path: string, bytes: Uint8Array, expected: string | null): Promise<boolean> {
    const current = await this.read(path);
    const currentBlob = current && (await blobId(current.bytes));
    if (currentBlob === (await blobId(bytes))) return true;
    if (currentBlob !== expected) return false;
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), bytes);
    return true;
  }

  async remove(path: string, expected: string): Promise<boolean> {
    const current = await this.read(path);
    if (!current) return true;
    if ((await blobId(current.bytes)) !== expected) return false;
    await unlink(this.full(path));
    await this.prune(path);
    return true;
  }

  async rename(from: string, to: string, expected: string): Promise<boolean> {
    const current = await this.read(from);
    if (!current || (await this.stat(to)) || (await blobId(current.bytes)) !== expected)
      return false;
    await mkdir(dirname(this.full(to)), { recursive: true });
    await rename(this.full(from), this.full(to));
    await this.prune(from);
    return true;
  }

  async exists(path: string): Promise<boolean> {
    return stat(this.full(path)).then(
      () => true,
      () => false,
    );
  }

  private async prune(path: string): Promise<void> {
    await pruneEmptyFolders(this.root, path);
  }

  async edit(path: string, text: string): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), text);
  }

  async text(path: string): Promise<string | null> {
    return readFile(this.full(path), 'utf8').catch(() => null);
  }

  async delete(path: string): Promise<void> {
    await unlink(this.full(path));
  }

  private full(path: string): string {
    return join(this.root, ...path.split('/'));
  }
}

export interface Client {
  name: string;
  vault: FolderVault;
  api: Api;
  engine: SyncEngine;
  replaced: { path: string; by: string }[];
  settingsChanged: number;
  sync(): Promise<void>;
  // Deletes a file and reports it the way Obsidian's delete event does.
  remove(path: string): Promise<void>;
  // Renames a file and reports it the way Obsidian's rename event does.
  move(from: string, to: string): Promise<void>;
}

export async function startHub() {
  const root = await mkdtemp(join(tmpdir(), 'kiwisync-test-'));
  const config = readConfig({
    KIWISYNC_VAULT: join(root, 'hub-vault'),
    KIWISYNC_DATA: join(root, 'data'),
    KIWISYNC_HUB_NAME: 'Mini PC',
    KIWISYNC_MAX_FILE_MB: '1',
  });
  const hub = await openHub(config);
  const server = makeServer({
    hub,
    publicUrl: '',
    pluginDir: join(root, 'plugin'),
    installScript: join(root, 'install.sh'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function client(
    name: string,
    options: { skew?: number; files?: Record<string, string> } = {},
  ) {
    const skew = options.skew ?? 0;
    const vault = new FolderVault(join(root, name), skew);
    await mkdir(vault.root, { recursive: true });
    for (const [path, text] of Object.entries(options.files ?? {})) await vault.edit(path, text);
    const { code } = hub.store.createInvite(HUB_ID);
    const clock = () => Date.now() + skew;
    const paired = await new Api(url, null, fetcher, clock).pair({
      code,
      name,
      platform: 'desktop',
    });
    const api = new Api(url, paired.token, fetcher, clock);
    const replaced: Client['replaced'] = [];
    const engine = new SyncEngine(vault, api, emptyState(), async () => {}, {
      replaced: (path, by) => replaced.push({ path, by }),
      disconnected: () => {},
      settingsChanged: () => client.settingsChanged++,
    });
    const client: Client = {
      name,
      vault,
      api,
      engine,
      replaced,
      settingsChanged: 0,
      sync: () => engine.sync(),
      async remove(path) {
        await vault.delete(path);
        engine.noteEdit(path);
      },
      async move(from, to) {
        await mkdir(dirname(join(vault.root, to)), { recursive: true });
        await rename(join(vault.root, from), join(vault.root, to));
        engine.noteRename(from, to);
      },
    };
    return client;
  }

  return {
    hub,
    url,
    root,
    hubVault: new FolderVault(config.vault),
    client,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      hub.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
