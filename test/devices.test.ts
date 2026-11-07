import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, ApiError } from '../src/plugin/api';
import { fetcher, startHub } from './helpers';

test('an invite code works once and wrong codes are refused', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const laptop = await hub.client('Laptop');
  const { code } = await laptop.api.invite();
  const anonymous = new Api(hub.url, null, fetcher);

  await assert.rejects(anonymous.pair({ code: 'AAAA-BBBB-CCCC', name: 'X', platform: 'ios' }), {
    status: 403,
  });
  const paired = await anonymous.pair({
    code: code.toLowerCase(),
    name: 'iPhone',
    platform: 'ios',
  });
  assert.equal(paired.device.name, 'iPhone');
  assert.equal(paired.hubName, 'Mini PC');
  await assert.rejects(anonymous.pair({ code, name: 'Again', platform: 'ios' }), { status: 403 });
});

test('devices can be listed, renamed from another device, and removed', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const laptop = await hub.client('Laptop');
  const phone = await hub.client('Laptop');
  let devices = await laptop.api.devices();
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Mini PC', 'Laptop', 'Laptop 2'],
  );

  const phoneId = devices[2]!.id;
  await laptop.api.renameDevice(phoneId, 'Pixel 7 Pro');
  await phone.vault.edit('n.md', 'x\n');
  await phone.sync();
  assert.equal((await hub.hub.history('n.md'))[0]!.device, 'Pixel 7 Pro');

  // Renaming relabels earlier history too.
  await laptop.api.renameDevice(phoneId, 'Pixel');
  assert.equal((await hub.hub.history('n.md'))[0]!.device, 'Pixel');

  await assert.rejects(laptop.api.removeDevice(devices[0]!.id), { status: 400 });
  await laptop.api.removeDevice(phoneId);
  await assert.rejects(phone.sync(), (e: unknown) => e instanceof ApiError && e.status === 401);
  devices = await laptop.api.devices();
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Mini PC', 'Laptop'],
  );
});

test('a device reports changes waiting to upload', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  phone.engine.noteEdit('a.md');
  phone.engine.noteEdit('b.md');
  phone.api.pending = phone.engine.pending();
  await phone.api.health();
  await phone.api.devices();
  assert.equal(hub.hub.store.findDevice('Phone')?.pending, 2);
});

test('joining with the hub copy saves the device files on a branch first', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const desktop = await hub.client('Desktop', { files: { 'Shared.md': 'hub version\n' } });
  await desktop.sync();

  const old = await hub.client('Old laptop', {
    files: { 'Shared.md': 'stale version\n', 'Only here.md': 'local only\n' },
  });
  const branch = await old.engine.join('hub', 'Old laptop');
  await old.sync();

  assert.match(branch ?? '', /^backup\/old-laptop-/);
  assert.equal(await old.vault.text('Shared.md'), 'hub version\n');
  assert.equal(await old.vault.text('Only here.md'), null);
  const saved = await hub.hub.repo.git(['show', `${branch}:Only here.md`]);
  assert.equal(saved.toString(), 'local only\n');
  assert.equal(await hub.hubVault.text('Only here.md'), null);
});

test('joining by merging keeps the newer copy of shared files and adds the rest', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const desktop = await hub.client('Desktop', { files: { 'Shared.md': 'older\n' } });
  await desktop.sync();
  await new Promise((r) => setTimeout(r, 20));

  const laptop = await hub.client('Laptop', {
    files: { 'Shared.md': 'newer\n', 'Laptop.md': 'from laptop\n' },
  });
  await laptop.engine.join('merge', 'Laptop');
  await laptop.sync();
  await desktop.sync();

  assert.equal(await desktop.vault.text('Shared.md'), 'newer\n');
  assert.equal(await desktop.vault.text('Laptop.md'), 'from laptop\n');
});
