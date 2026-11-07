import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configCategory, isSyncPath, type ConfigCategory } from '../src/shared/paths';
import { startHub, type Client } from './helpers';

function syncGroups(client: Client, ...groups: ConfigCategory[]): void {
  client.engine.wanted = (path) => {
    const group = configCategory(path);
    return isSyncPath(path) || (group !== null && groups.includes(group));
  };
}

const inGroup = (group: ConfigCategory) => (path: string) => configCategory(path) === group;

test('settings files are grouped, and device-only files are never synced', () => {
  const cases: [string, ConfigCategory | null][] = [
    ['.obsidian/community-plugins.json', 'plugins'],
    ['.obsidian/plugins/dataview/main.js', 'plugins'],
    ['.obsidian/plugins/dataview/data.json', 'plugins'],
    ['.obsidian/plugins/dataview/cache/index.db', null],
    ['.obsidian/plugins/kiwisync/data.json', null],
    ['.obsidian/plugins/obsidian-livesync/main.js', null],
    ['.obsidian/appearance.json', 'themes'],
    ['.obsidian/themes/Minimal/theme.css', 'themes'],
    ['.obsidian/snippets/wide.css', 'themes'],
    ['.obsidian/hotkeys.json', 'settings'],
    ['.obsidian/app.json', 'settings'],
    ['.obsidian/workspace.json', null],
    ['.obsidian/workspace-mobile.json', null],
    ['.trash/old.md', null],
    ['Notes/a.md', null],
  ];
  for (const [path, group] of cases) assert.equal(configCategory(path), group, path);
});

test('turning on plugin sync shares plugins and combines the enabled lists', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const desktop = await hub.client('Desktop', {
    files: {
      '.obsidian/community-plugins.json': '["dataview", "obsidian-livesync", "kiwisync"]',
      '.obsidian/plugins/dataview/main.js': 'dataview code',
      '.obsidian/plugins/dataview/data.json': '{"setting": 1}',
      '.obsidian/plugins/kiwisync/data.json': '{"secretId": "private"}',
      '.obsidian/workspace.json': '{"desktop": "layout"}',
      '.obsidian/appearance.json': '{"theme": "obsidian"}',
    },
  });
  const phone = await hub.client('Phone', {
    files: {
      '.obsidian/community-plugins.json': '["obsidian42-brat"]',
      '.obsidian/plugins/obsidian42-brat/main.js': 'brat code',
      '.obsidian/workspace-mobile.json': '{"phone": "layout"}',
    },
  });

  syncGroups(desktop, 'plugins');
  assert.equal(await desktop.engine.adopt(inGroup('plugins'), 'Desktop plugins'), null);
  await desktop.sync();
  assert.deepEqual(JSON.parse((await hub.hubVault.text('.obsidian/community-plugins.json'))!), [
    'dataview',
    'kiwisync',
  ]);
  assert.equal(await hub.hubVault.text('.obsidian/plugins/kiwisync/data.json'), null);
  assert.equal(await hub.hubVault.text('.obsidian/workspace.json'), null);
  assert.equal(await hub.hubVault.text('.obsidian/appearance.json'), null);

  syncGroups(phone, 'plugins');
  const branch = await phone.engine.adopt(inGroup('plugins'), 'Phone plugins');
  await phone.sync();
  await desktop.sync();

  assert.match(branch ?? '', /^backup\/phone-plugins-/);
  const expected = ['dataview', 'kiwisync', 'obsidian42-brat'];
  for (const device of [phone, desktop])
    assert.deepEqual(
      JSON.parse((await device.vault.text('.obsidian/community-plugins.json'))!),
      expected,
      device.name,
    );
  assert.equal(await phone.vault.text('.obsidian/plugins/dataview/main.js'), 'dataview code');
  assert.equal(await desktop.vault.text('.obsidian/plugins/obsidian42-brat/main.js'), 'brat code');
  assert.equal(await phone.vault.text('.obsidian/appearance.json'), null);
  assert.ok(phone.settingsChanged > 0);
  assert.ok(desktop.settingsChanged > 0);

  await desktop.vault.edit('.obsidian/plugins/dataview/data.json', '{"setting": 2}');
  await desktop.sync();
  await phone.sync();
  assert.equal(await phone.vault.text('.obsidian/plugins/dataview/data.json'), '{"setting": 2}');
});

test('a device without a group turned on ignores those files', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const desktop = await hub.client('Desktop', {
    files: { '.obsidian/snippets/wide.css': '.x {}', 'note.md': 'n\n' },
  });
  const phone = await hub.client('Phone');
  syncGroups(desktop, 'themes');
  await desktop.engine.adopt(inGroup('themes'), 'Desktop themes');
  await desktop.sync();
  await phone.sync();
  assert.equal(await phone.vault.text('note.md'), 'n\n');
  assert.equal(await phone.vault.text('.obsidian/snippets/wide.css'), null);

  syncGroups(phone, 'themes');
  await phone.engine.adopt(inGroup('themes'), 'Phone themes');
  assert.equal(await phone.vault.text('.obsidian/snippets/wide.css'), '.x {}');
});

test('the hub removes other sync plugins from its own plugin list', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  await hub.hubVault.edit('.obsidian/community-plugins.json', '["obsidian-livesync", "dataview"]');
  await hub.hub.scan();
  assert.deepEqual(JSON.parse((await hub.hubVault.text('.obsidian/community-plugins.json'))!), [
    'dataview',
    'kiwisync',
  ]);
});
