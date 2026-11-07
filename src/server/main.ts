import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from './config';
import { makeServer } from './http';
import { openHub } from './open';

const config = readConfig();
const hub = await openHub(config);
const imported = await hub.scan();
if (imported) console.log(`Recorded ${imported} changed files from ${config.vault}.`);

const server = makeServer({
  hub,
  publicUrl: config.publicUrl,
  pluginDir: config.pluginDir,
  installScript: resolve('scripts/install.sh'),
});
server.listen(config.port, config.host, () =>
  console.log(`KiwiSync is serving ${config.vault} on ${config.host}:${config.port}.`),
);

// Edits made directly in the vault folder on this machine are picked up shortly after they
// happen. The periodic scan covers anything the watcher misses.
let pending: NodeJS.Timeout | undefined;
function scanSoon() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    hub.scan().catch((e: unknown) => console.error('Scanning the vault failed:', e));
  }, 1000);
}
const watcher = watch(config.vault, { recursive: true }, (_event, name) => {
  if (name && !name.split('/').some((part) => part.startsWith('.'))) scanSoon();
});
const periodic = setInterval(scanSoon, 5 * 60_000);
const maintenance = setInterval(
  () => void hub.exclusive(() => hub.repo.git(['gc', '--auto', '--quiet'])).catch(console.error),
  24 * 60 * 60_000,
);

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    watcher.close();
    clearInterval(periodic);
    clearInterval(maintenance);
    clearTimeout(pending);
    server.closeAllConnections();
    server.close(() => {
      hub.store.close();
      process.exit(0);
    });
  });
