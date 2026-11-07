import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config';
import { Hub } from './hub';
import { Repo } from './repo';
import { Store } from './store';

export async function openHub(config: Config): Promise<Hub> {
  await mkdir(config.vault, { recursive: true });
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  const repo = await Repo.open(config.vault);
  const store = new Store(join(config.data, 'kiwisync.sqlite'), config.hubName);
  return new Hub(store, repo, config.vault, config.maxFileBytes);
}
