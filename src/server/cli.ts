import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import qrcode from 'qrcode-generator';
import { isSyncPath } from '../shared/paths';
import { readConfig } from './config';
import { slug } from './hub';
import { openHub } from './open';
import { HUB_ID } from './store';

const USAGE = `Usage:
  kiwisync invite              Print a one-time code and QR code for adding a device
  kiwisync devices             List connected devices
  kiwisync rename <device> <new name>
  kiwisync remove <device>     Disconnect a device
  kiwisync snapshot <folder> <label>
                               Save a folder of notes on its own history branch`;

const config = readConfig();
const hub = await openHub(config);
const { store } = hub;
const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'invite') {
    const { code, expiresAt } = store.createInvite(HUB_ID);
    const link = `obsidian://kiwisync?server=${encodeURIComponent(config.publicUrl)}&code=${code}`;
    console.log(terminalQr(link));
    console.log(`Scan with the phone's camera, or in KiwiSync choose Connect and enter:\n`);
    console.log(`  Server  ${config.publicUrl}`);
    console.log(`  Code    ${code}\n`);
    console.log(`The code works once, until ${new Date(expiresAt).toLocaleTimeString()}.`);
  } else if (command === 'devices') {
    for (const d of store.devices().filter((d) => !d.removed)) {
      const seen =
        d.platform === 'hub'
          ? 'this machine'
          : d.lastSeen
            ? new Date(d.lastSeen).toLocaleString()
            : 'never';
      const waiting = d.pending ? `, ${d.pending} changes waiting` : '';
      console.log(`${d.name.padEnd(24)} ${d.platform.padEnd(8)} last synced ${seen}${waiting}`);
    }
  } else if (command === 'rename' && args.length >= 2) {
    const device = find(args[0]!);
    store.renameDevice(device.id, args.slice(1).join(' '));
    console.log(`Renamed ${device.name} to ${store.device(device.id)!.name}.`);
  } else if (command === 'remove' && args.length === 1) {
    const device = find(args[0]!);
    if (device.id === HUB_ID) throw new Error('The hub cannot be removed.');
    store.removeDevice(device.id);
    console.log(`Removed ${device.name}. It will stop syncing the next time it connects.`);
  } else if (command === 'snapshot' && args.length >= 2) {
    const folder = resolve(args[0]!);
    const files = [];
    for (const path of await listFiles(folder))
      files.push({ path, blob: await hub.repo.writeBlob(await readFile(join(folder, path))) });
    const label = args.slice(1).join(' ');
    const branch = `backup/${slug(label)}`;
    await hub.snapshot(branch, label, files, HUB_ID);
    console.log(`Saved ${files.length} files on branch ${branch}.`);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}

function find(nameOrId: string) {
  const device = store.findDevice(nameOrId);
  if (!device)
    throw new Error(`No device named "${nameOrId}". Run "kiwisync devices" to list them.`);
  return device;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter(isSyncPath)
    .sort();
}

// Light modules are drawn as blocks, which scans correctly on the usual dark terminal.
function terminalQr(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  const lines: string[] = [];
  for (let r = -2; r < size + 2; r += 2) {
    let line = '';
    for (let c = -2; c < size + 2; c++) {
      const top = !dark(r, c);
      const bottom = !dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
