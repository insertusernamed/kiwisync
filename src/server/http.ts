import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBlobId } from '../shared/blob';
import {
  PROTOCOL,
  type ChangesResponse,
  type Health,
  type PairRequest,
  type Platform,
} from '../shared/protocol';
import { HttpError, slug, type Hub } from './hub';
import { HUB_ID, type DeviceRow } from './store';

export interface ServerOptions {
  hub: Hub;
  publicUrl: string;
  pluginDir: string;
  installScript: string;
}

const PLATFORMS: Platform[] = ['desktop', 'ios', 'android'];
const PLUGIN_FILES = new Set(['main.js', 'manifest.json', 'styles.css']);
const MAX_WAIT_SECONDS = 25;
const PAIR_FAILURE_LIMIT = 20;
const PAIR_FAILURE_WINDOW = 10 * 60_000;

export function makeServer(options: ServerOptions) {
  const { hub } = options;
  const { store } = hub;
  const pairFailures: number[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    res.setHeader('X-KiwiSync-Time', String(Date.now()));
    res.setHeader('Cache-Control', 'no-store');

    if (route === 'GET /health') {
      const health: Health = {
        app: 'kiwisync',
        protocol: PROTOCOL,
        pluginVersion: await pluginVersion(options.pluginDir),
        hubName: store.device(HUB_ID)!.name,
      };
      return json(res, 200, health);
    }
    if (route === 'GET /install.sh') {
      const script = (await readFile(options.installScript, 'utf8')).replaceAll(
        '@KIWISYNC_URL@',
        options.publicUrl,
      );
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
      return void res.end(script);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/plugin/')) {
      const name = url.pathname.slice('/plugin/'.length);
      if (!PLUGIN_FILES.has(name)) throw new HttpError(404, 'Not found.');
      const body = await readFile(join(options.pluginDir, name)).catch(() => null);
      if (!body) throw new HttpError(404, 'The plugin has not been built on the server.');
      res.writeHead(200, {
        'Content-Type': name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : 'application/json',
      });
      return void res.end(body);
    }
    if (route === 'POST /api/pair') return pair(req, res);

    const device = authenticate(req);

    if (route === 'GET /api/changes') {
      let since = Number(url.searchParams.get('since') ?? 0);
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), MAX_WAIT_SECONDS);
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Bad cursor.');
      // A cursor from before a server reset starts over; devices compare contents, so this is safe.
      if (since > store.latest() || url.searchParams.get('server') !== store.serverId) since = 0;
      if (wait > 0 && since >= store.latest()) await waitForChange(wait * 1000);
      const changes = store.changes(since, 500);
      const latest = store.latest();
      const response: ChangesResponse = {
        serverId: store.serverId,
        latest,
        changes,
        more: (changes.at(-1)?.seq ?? latest) < latest,
        // Only a sync collects these; a waiting request that just signals activity does not.
        replaced: wait ? [] : store.takeReplacements(device.id),
      };
      return json(res, 200, response);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/blobs/')) {
      const blob = url.pathname.slice('/api/blobs/'.length);
      if (!isBlobId(blob)) throw new HttpError(400, 'Bad version id.');
      const bytes = await hub.repo.readBlob(blob);
      if (!bytes) throw new HttpError(404, 'That version is not on the server.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return void res.end(bytes);
    }
    if (route === 'PUT /api/blobs') {
      const bytes = await body(req, hub.maxFileBytes);
      return json(res, 200, { blob: await hub.repo.writeBlob(bytes) });
    }
    if (route === 'PUT /api/files' || route === 'DELETE /api/files') {
      const path = url.searchParams.get('path') ?? '';
      const base = url.searchParams.get('base') || null;
      if (base !== null && !isBlobId(base)) throw new HttpError(400, 'Bad base version.');
      // An edit cannot have happened after the server received it. This also stops a device
      // with a wrong clock from always winning.
      const edited = Math.min(Number(url.searchParams.get('edited')), Date.now());
      if (!Number.isFinite(edited)) throw new HttpError(400, 'Bad edit time.');
      if (req.method === 'DELETE')
        return json(res, 200, await hub.remove(path, base, edited, device.id));
      const bytes = await body(req, hub.maxFileBytes);
      return json(res, 200, await hub.put(path, base, edited, bytes, device.id));
    }
    if (route === 'GET /api/history')
      return json(res, 200, await hub.history(url.searchParams.get('path') ?? ''));
    if (route === 'GET /api/deleted') return json(res, 200, hub.deleted());
    if (route === 'POST /api/restore') {
      const { path, blob } = (await jsonBody(req)) as { path?: unknown; blob?: unknown };
      if (typeof path !== 'string' || !isBlobId(blob))
        throw new HttpError(400, 'Bad restore request.');
      return json(res, 200, await hub.restore(path, blob, device.id));
    }
    if (route === 'POST /api/snapshots') {
      const { label, files } = (await jsonBody(req)) as { label?: unknown; files?: unknown };
      if (typeof label !== 'string' || !Array.isArray(files))
        throw new HttpError(400, 'Bad snapshot.');
      const valid = files.every((f) => typeof f?.path === 'string' && isBlobId(f?.blob));
      if (!valid) throw new HttpError(400, 'Bad snapshot.');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const branch = `backup/${slug(label)}-${stamp}`;
      await hub.snapshot(branch, `Files on ${label} before it joined`, files, device.id);
      return json(res, 200, { branch });
    }
    if (route === 'GET /api/devices') {
      return json(
        res,
        200,
        store
          .devices()
          .filter((d) => !d.removed)
          .map(({ removed: _, ...d }) => d),
      );
    }
    if (route === 'POST /api/invites') return json(res, 200, store.createInvite(device.id));

    const deviceRoute = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
    const target = deviceRoute && store.device(decodeURIComponent(deviceRoute[1]!));
    if (deviceRoute && (!target || target.removed)) throw new HttpError(404, 'No such device.');
    if (target && req.method === 'PATCH') {
      const { name } = (await jsonBody(req)) as { name?: unknown };
      if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Enter a name.');
      store.renameDevice(target.id, name);
      return json(res, 200, store.device(target.id));
    }
    if (target && req.method === 'DELETE') {
      if (target.id === HUB_ID) throw new HttpError(400, 'The hub cannot be removed.');
      store.removeDevice(target.id);
      return json(res, 200, { removed: target.id });
    }
    throw new HttpError(404, 'Not found.');
  }

  function authenticate(req: IncomingMessage): DeviceRow {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const device = token ? store.deviceByToken(token) : undefined;
    if (!device || device.removed)
      throw new HttpError(401, 'This device is not connected to KiwiSync. Connect it again.');
    const pending = Number(req.headers['x-kiwisync-pending'] ?? 0);
    store.seen(device.id, Number.isSafeInteger(pending) && pending >= 0 ? pending : 0);
    return device;
  }

  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now();
    while (pairFailures.length && pairFailures[0]! < now - PAIR_FAILURE_WINDOW)
      pairFailures.shift();
    if (pairFailures.length >= PAIR_FAILURE_LIMIT)
      throw new HttpError(429, 'Too many wrong codes. Wait ten minutes and try again.');
    const { code, name, platform } = (await jsonBody(req)) as Partial<PairRequest>;
    if (typeof code !== 'string' || typeof name !== 'string' || !PLATFORMS.includes(platform!))
      throw new HttpError(400, 'Bad pairing request.');
    if (!store.claimInvite(code)) {
      pairFailures.push(now);
      throw new HttpError(403, 'That code is wrong, expired, or already used. Create a new one.');
    }
    const { device, token } = store.addDevice(name, platform!);
    const { removed: _, ...shown } = device;
    return json(res, 200, { token, device: shown, hubName: store.device(HUB_ID)!.name });
  }

  function waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const stop = hub.onChange(done);
      function done() {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return void res.destroy();
      json(res, status, {
        error: status === 500 ? 'The server hit an error. Check its log.' : (e as Error).message,
      });
    });
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // The rest of an oversized upload is read and dropped so the device receives the error
  // instead of a reset connection.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new HttpError(413, 'The file is larger than the server accepts.');
  return Buffer.concat(chunks);
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await body(req, 4 * 1024 * 1024)).toString());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

async function pluginVersion(dir: string): Promise<string | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).version;
  } catch {
    return null;
  }
}
