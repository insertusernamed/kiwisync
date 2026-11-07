import type {
  ChangesResponse,
  DeleteResponse,
  DeletedFile,
  Device,
  FolderResponse,
  Health,
  HistoryEntry,
  PairRequest,
  PairResponse,
  PutResponse,
  RenameResponse,
} from '../shared/protocol';

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
}

// Header names must be lowercase.
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export type Fetcher = (request: HttpRequest) => Promise<HttpResponse>;

// Status 0 means the server could not be reached.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const decoder = new TextDecoder();

export class Api {
  // Server clock minus this device's clock, in milliseconds.
  offset = 0;
  pending = 0;

  constructor(
    readonly server: string,
    private token: string | null,
    private fetcher: Fetcher,
    private clock: () => number = Date.now,
  ) {}

  now(): number {
    return this.clock() + this.offset;
  }

  health(): Promise<Health> {
    return this.json('GET', '/health');
  }

  pair(request: PairRequest): Promise<PairResponse> {
    return this.json('POST', '/api/pair', request);
  }

  changes(since: number, serverId: string | null, wait = 0): Promise<ChangesResponse> {
    const query = new URLSearchParams({
      since: String(since),
      server: serverId ?? '',
      wait: String(wait),
    });
    return this.json('GET', `/api/changes?${query}`);
  }

  async blob(id: string): Promise<Uint8Array> {
    return new Uint8Array((await this.request('GET', `/api/blobs/${id}`)).body);
  }

  async uploadBlob(bytes: Uint8Array): Promise<string> {
    return ((await this.json('PUT', '/api/blobs', bytes)) as { blob: string }).blob;
  }

  put(path: string, base: string | null, edited: number, bytes: Uint8Array): Promise<PutResponse> {
    return this.json('PUT', `/api/files?${fileQuery(path, base, edited)}`, bytes);
  }

  remove(path: string, base: string | null, edited: number): Promise<DeleteResponse> {
    return this.json('DELETE', `/api/files?${fileQuery(path, base, edited)}`);
  }

  createFolder(path: string): Promise<FolderResponse> {
    return this.json('PUT', `/api/folders?${new URLSearchParams({ path })}`);
  }

  removeFolder(path: string): Promise<FolderResponse> {
    return this.json('DELETE', `/api/folders?${new URLSearchParams({ path })}`);
  }

  rename(from: string, to: string): Promise<RenameResponse> {
    return this.json('POST', '/api/rename', { from, to });
  }

  history(path: string): Promise<HistoryEntry[]> {
    return this.json('GET', `/api/history?${new URLSearchParams({ path })}`);
  }

  deleted(): Promise<DeletedFile[]> {
    return this.json('GET', '/api/deleted');
  }

  restore(path: string, blob: string): Promise<PutResponse> {
    return this.json('POST', '/api/restore', { path, blob });
  }

  async snapshot(label: string, files: { path: string; blob: string }[]): Promise<string> {
    return ((await this.json('POST', '/api/snapshots', { label, files })) as { branch: string })
      .branch;
  }

  devices(): Promise<Device[]> {
    return this.json('GET', '/api/devices');
  }

  renameDevice(id: string, name: string): Promise<Device> {
    return this.json('PATCH', `/api/devices/${encodeURIComponent(id)}`, { name });
  }

  removeDevice(id: string): Promise<void> {
    return this.json('DELETE', `/api/devices/${encodeURIComponent(id)}`);
  }

  invite(): Promise<{ code: string; expiresAt: number }> {
    return this.json('POST', '/api/invites');
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    return JSON.parse(decoder.decode(response.body)) as T;
  }

  private async request(method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const headers: Record<string, string> = { 'X-KiwiSync-Pending': String(this.pending) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: ArrayBuffer | string | undefined;
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body.slice().buffer;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const started = this.clock();
    let response: HttpResponse;
    try {
      response = await this.fetcher({ url: this.server + path, method, headers, body: payload });
    } catch {
      throw new ApiError(0, 'Cannot reach the KiwiSync server.');
    }
    const ended = this.clock();
    const serverTime = Number(response.headers['x-kiwisync-time']);
    // Slow round trips (including long polls) give a poor estimate, so only quick ones count.
    if (serverTime && ended - started < 2000)
      this.offset = Math.round(serverTime - (started + ended) / 2);
    if (response.status >= 400) {
      let message = `The server answered with status ${response.status}.`;
      try {
        message = JSON.parse(decoder.decode(response.body)).error ?? message;
      } catch {
        // Not a KiwiSync error body, for example a proxy's error page.
      }
      throw new ApiError(response.status, message);
    }
    return response;
  }
}

function fileQuery(path: string, base: string | null, edited: number): URLSearchParams {
  return new URLSearchParams({ path, base: base ?? '', edited: String(Math.round(edited)) });
}
