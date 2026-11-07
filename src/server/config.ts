import { hostname } from 'node:os';
import { resolve } from 'node:path';

export interface Config {
  vault: string;
  data: string;
  host: string;
  port: number;
  publicUrl: string;
  hubName: string;
  maxFileBytes: number;
  pluginDir: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.KIWISYNC_VAULT) throw new Error('Set KIWISYNC_VAULT to the vault folder.');
  const port = Number(env.KIWISYNC_PORT ?? 7025);
  const maxMegabytes = Number(env.KIWISYNC_MAX_FILE_MB ?? 200);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('KIWISYNC_PORT is not a valid port.');
  if (!(maxMegabytes > 0)) throw new Error('KIWISYNC_MAX_FILE_MB must be a positive number.');
  return {
    vault: resolve(env.KIWISYNC_VAULT),
    data: resolve(env.KIWISYNC_DATA ?? 'data'),
    host: env.KIWISYNC_HOST ?? '127.0.0.1',
    port,
    publicUrl: (env.KIWISYNC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    hubName: env.KIWISYNC_HUB_NAME ?? hostname(),
    maxFileBytes: maxMegabytes * 1024 * 1024,
    pluginDir: resolve(env.KIWISYNC_PLUGIN_DIR ?? 'dist/plugin'),
  };
}
