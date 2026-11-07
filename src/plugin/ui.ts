import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import qrcode from 'qrcode-generator';
import { diffLines, withContext } from '../shared/diff';
import { isDrawing, isSyncPath, type ConfigCategory } from '../shared/paths';
import type { Device, HistoryEntry, HistoryKind } from '../shared/protocol';
import type KiwiSyncPlugin from './main';
import { defaultDeviceName } from './device';
import type { JoinMode } from './sync';

const KIND_LABELS: Record<HistoryKind, string> = {
  edit: 'Edited',
  delete: 'Deleted',
  merge: 'Edits combined',
  replaced: 'Replaced by a newer edit',
  restore: 'Restored',
  import: 'Saved copy',
  rename: 'Renamed',
};
const PREVIEW_LIMIT = 200_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ConnectModal extends Modal {
  private mode: JoinMode = 'hub';

  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
    private server: string,
    private code: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle('Connect to KiwiSync');
    contentEl.createEl('p', {
      text: 'On a device that is already connected, open KiwiSync settings and choose Add a device. Enter the server address and code it shows.',
    });
    let name = defaultDeviceName();
    new Setting(contentEl).setName('Server address').addText((t) =>
      t
        .setPlaceholder('https://example.duckdns.org/kiwisync')
        .setValue(this.server)
        .onChange((v) => (this.server = v)),
    );
    new Setting(contentEl).setName('Code').addText((t) =>
      t
        .setPlaceholder('XXXX-XXXX-XXXX')
        .setValue(this.code)
        .onChange((v) => (this.code = v)),
    );
    new Setting(contentEl)
      .setName('Device name')
      .setDesc('Shown in the device list and in version history. You can change it later.')
      .addText((t) => t.setValue(name).onChange((v) => (name = v)));

    const existing = this.app.vault.getFiles().filter((f) => isSyncPath(f.path)).length;
    if (existing) {
      new Setting(contentEl)
        .setName(`This vault already has ${existing} ${existing === 1 ? 'file' : 'files'}`)
        .setDesc(
          "Use the hub's copy: this device's files are saved in the hub's history, then replaced so this device matches the hub. " +
            'Merge: files only on this device are added to the hub, and for files on both, the newer version is kept.',
        )
        .addDropdown((d) =>
          d
            .addOption('hub', "Use the hub's copy")
            .addOption('merge', 'Merge')
            .setValue(this.mode)
            .onChange((v) => (this.mode = v as JoinMode)),
        );
    }

    const status = contentEl.createEl('p', { cls: 'kiwisync-error' });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Connect')
        .setCta()
        .onClick(async () => {
          b.setDisabled(true).setButtonText('Connecting');
          status.setText('');
          try {
            const branch = await this.plugin.connect(
              this.server,
              this.code,
              name,
              existing ? this.mode : null,
            );
            new Notice(
              branch
                ? `KiwiSync connected. This device's previous files are saved on the hub as ${branch}.`
                : 'KiwiSync connected.',
            );
            this.close();
          } catch (e) {
            status.setText((e as Error).message);
            b.setDisabled(false).setButtonText('Connect');
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class InviteModal extends Modal {
  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    this.setTitle('Add a device');
    const loading = contentEl.createEl('p', { text: 'Creating a code' });
    try {
      const { code, expiresAt } = await this.plugin.api!.invite();
      const server = this.plugin.settings.server;
      const link = `obsidian://kiwisync?server=${encodeURIComponent(server)}&code=${code}`;
      loading.remove();
      contentEl.createEl('p', {
        text: 'Install Obsidian and the KiwiSync plugin on the new device. On a phone, scan this code with the camera. On a computer, choose Connect in KiwiSync settings and enter the details below.',
      });
      drawQr(contentEl.createDiv({ cls: 'kiwisync-qr' }), link);
      const details = contentEl.createDiv({ cls: 'kiwisync-invite' });
      details.createDiv({ text: 'Server' });
      details.createEl('code', { text: server });
      details.createDiv({ text: 'Code' });
      details.createEl('code', { text: code, cls: 'kiwisync-code' });
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `It expires at ${new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} and works only once.`,
      });
    } catch (e) {
      loading.setText((e as Error).message);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
    private path: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle(this.path);
    const list = this.contentEl.createDiv({ cls: 'kiwisync-history' });
    list.setText('Loading history');
    let entries: HistoryEntry[];
    try {
      entries = await this.plugin.api!.history(this.path);
    } catch (e) {
      list.setText((e as Error).message);
      return;
    }
    list.empty();
    if (!entries.length) list.setText('This file has no synced versions yet.');
    const current = entries.find((e) => e.kind !== 'replaced')?.commit;
    entries.forEach((entry, index) => {
      // Each version is compared with the one before it in the file's own history.
      const previous = entries
        .slice(index + 1)
        .find((e) => e.blob && e.kind !== 'replaced' && e.blob !== entry.blob);
      const row = new Setting(list)
        .setName(`${formatTime(entry.time)}, ${entry.device}`)
        .setDesc(
          (entry.from ? `${KIND_LABELS[entry.kind]} from ${entry.from}` : KIND_LABELS[entry.kind]) +
            (entry.commit === current ? ' (current)' : ''),
        );
      if (!entry.blob) return;
      const blob = entry.blob;
      const restore = entry.commit === current ? null : () => this.restore(blob);
      row.addButton((b) =>
        b
          .setButtonText('View')
          .onClick(() =>
            new VersionModal(this.app, this.plugin, this.path, entry, previous, restore).open(),
          ),
      );
      if (restore) row.addButton((b) => b.setButtonText('Restore').onClick(restore));
    });
  }

  private async restore(blob: string): Promise<void> {
    try {
      await this.plugin.api!.restore(this.path, blob);
      await this.plugin.sync();
      new Notice(`Restored ${this.path}.`);
      this.close();
    } catch (e) {
      new Notice((e as Error).message);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// One version of a file, shown as the changes from the version before it.
class VersionModal extends Modal {
  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
    private path: string,
    private entry: HistoryEntry,
    private previous: HistoryEntry | undefined,
    private restore: (() => Promise<void>) | null,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, entry, previous } = this;
    this.setTitle(`${formatTime(entry.time)}, ${entry.device}`);
    contentEl.setText('Loading');
    try {
      const [bytes, before] = await Promise.all([
        this.plugin.api!.blob(entry.blob!),
        previous ? this.plugin.api!.blob(previous.blob!) : null,
      ]);
      contentEl.empty();
      const text = asText(bytes);
      if (text === null) {
        contentEl.createEl('p', {
          text: `${formatSize(bytes.length)}. This kind of file can't be shown here; restore it to open it.`,
        });
      } else if (isDrawing(this.path, text)) {
        contentEl.createEl('p', {
          text: "Drawings can't be compared line by line. Restore this version to see it.",
        });
      } else this.showText(text, before && asText(before));
    } catch (e) {
      contentEl.setText((e as Error).message);
    }
    if (this.restore) {
      const restore = this.restore;
      new Setting(contentEl).addButton((b) =>
        b
          .setButtonText('Restore this version')
          .setCta()
          .onClick(async () => {
            this.close();
            await restore();
          }),
      );
    }
  }

  private showText(text: string, before: string | null): void {
    const { contentEl, previous } = this;
    const lines = before === null ? null : diffLines(before, text);
    const intro = contentEl.createEl('p', { cls: 'setting-item-description' });
    const body = contentEl.createDiv();
    const whole = () => {
      body.empty();
      body.createEl('pre', { cls: 'kiwisync-preview', text });
    };
    if (!previous || lines === null) {
      intro.setText(
        previous
          ? 'Too many changes to compare. This is the whole version.'
          : 'The first version of this file.',
      );
      whole();
      return;
    }
    intro.setText(
      `Changes since the version from ${formatTime(previous.time)}, ${previous.device}.`,
    );
    let showingChanges = true;
    const changes = () => {
      body.empty();
      const view = body.createDiv({ cls: 'kiwisync-diff' });
      const rows = withContext(lines);
      if (!rows.some((r) => r.kind === 'added' || r.kind === 'removed'))
        view.createDiv({ cls: 'kiwisync-diff-skip', text: 'No changes in the text.' });
      for (const row of rows) {
        if (row.kind === 'skipped') {
          const count = `${row.count} unchanged ${row.count === 1 ? 'line' : 'lines'}`;
          view.createDiv({ cls: 'kiwisync-diff-skip', text: count });
          continue;
        }
        const mark = { same: ' ', added: '+', removed: '−' }[row.kind];
        view.createDiv({ cls: `kiwisync-diff-line is-${row.kind}`, text: `${mark} ${row.text}` });
      }
    };
    changes();
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Show whole version').onClick(() => {
        showingChanges = !showingChanges;
        if (showingChanges) changes();
        else whole();
        b.setButtonText(showingChanges ? 'Show whole version' : 'Show changes');
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function asText(bytes: Uint8Array): string | null {
  if (bytes.length > PREVIEW_LIMIT) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export class DeletedModal extends Modal {
  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle('Deleted files');
    const list = this.contentEl.createDiv({ cls: 'kiwisync-history' });
    try {
      const files = await this.plugin.api!.deleted();
      if (!files.length) list.setText('No deleted files.');
      for (const file of files)
        new Setting(list)
          .setName(file.path)
          .setDesc(`Deleted ${formatTime(file.time)} on ${file.device}`)
          .addButton((b) =>
            b.setButtonText('Restore').onClick(async () => {
              b.setDisabled(true);
              try {
                await this.plugin.api!.restore(file.path, file.blob);
                await this.plugin.sync();
                new Notice(`Restored ${file.path}.`);
                b.setButtonText('Restored');
              } catch (e) {
                new Notice((e as Error).message);
                b.setDisabled(false);
              }
            }),
          );
    } catch (e) {
      list.setText((e as Error).message);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class KiwiSyncSettingTab extends PluginSettingTab {
  private status: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: KiwiSyncPlugin,
  ) {
    super(app, plugin);
  }

  refreshStatus(): void {
    this.status?.setText(this.plugin.statusText());
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    const statusRow = new Setting(containerEl).setName('Status');
    this.status = statusRow.descEl;
    this.refreshStatus();

    if (!plugin.connected) {
      statusRow.addButton((b) =>
        b
          .setButtonText('Connect')
          .setCta()
          .onClick(() => new ConnectModal(this.app, plugin, '', '').open()),
      );
      return;
    }
    statusRow.addButton((b) => b.setButtonText('Sync now').onClick(() => void plugin.sync(true)));

    const other = plugin.otherSyncPlugin();
    if (other)
      new Setting(containerEl)
        .setName(`${other.name} is on`)
        .setDesc(
          `Two sync plugins would overwrite each other's changes. KiwiSync waits until ${other.name} is off.`,
        )
        .addButton((b) =>
          b
            .setButtonText(`Turn off ${other.name}`)
            .setWarning()
            .onClick(async () => {
              await plugin.disableOtherSyncPlugin();
              this.display();
            }),
        );

    if (plugin.engine?.errors.size) {
      const failed = new Setting(containerEl).setName('Files that could not sync').descEl;
      for (const [path, message] of plugin.engine.errors)
        failed.createDiv({ text: `${path}: ${message}` });
    }

    new Setting(containerEl).setName('Server').setDesc(plugin.settings.server);
    new Setting(containerEl)
      .setName('This device')
      .setDesc('The name other devices and the version history show.')
      .addText((t) => {
        t.setValue(plugin.settings.deviceName);
        t.inputEl.addEventListener('change', async () => {
          try {
            await plugin.renameThisDevice(t.getValue());
            this.display();
          } catch (e) {
            new Notice((e as Error).message);
          }
        });
      });

    new Setting(containerEl).setName('Devices').setHeading();
    new Setting(containerEl)
      .setName('Add a device')
      .setDesc('Shows a one-time code for connecting a phone or computer.')
      .addButton((b) =>
        b.setButtonText('Add a device').onClick(() => new InviteModal(this.app, plugin).open()),
      );
    const deviceList = containerEl.createDiv();
    void this.showDevices(deviceList);

    new Setting(containerEl).setName('History').setHeading();
    new Setting(containerEl)
      .setName('Deleted files')
      .setDesc('Bring back a file deleted on any device.')
      .addButton((b) =>
        b.setButtonText('Show').onClick(() => new DeletedModal(this.app, plugin).open()),
      );
    new Setting(containerEl)
      .setName('Version history')
      .setDesc('Right-click a file and choose Version history, or use the command palette.');

    new Setting(containerEl)
      .setName('Plugins and settings')
      .setDesc(
        "Off by default, and set on each device. Turning one on makes this device use the hub's version of anything the hub already has; this device's own copies are saved in the hub's history first. Reload Obsidian after changes arrive.",
      )
      .setHeading();
    const groups: [ConfigCategory, string, string][] = [
      ['plugins', 'Plugins', 'Which community plugins are on, plus their code and options.'],
      ['themes', 'Themes and snippets', 'The theme, CSS snippets, and appearance settings.'],
      ['settings', 'Other settings', 'Hotkeys, editor options, and core plugin settings.'],
    ];
    for (const [group, name, desc] of groups)
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(plugin.settings.settingsSync[group]).onChange(async (on) => {
            t.setDisabled(true);
            try {
              const branch = await plugin.setSettingsSync(group, on);
              if (branch)
                new Notice(
                  `This device's previous ${name.toLowerCase()} are saved on the hub as ${branch}.`,
                );
            } catch (e) {
              new Notice((e as Error).message);
              this.display();
              return;
            }
            t.setDisabled(false);
          }),
        );

    new Setting(containerEl).setName('Advanced').setHeading();
    new Setting(containerEl)
      .setName('Install updates from the hub')
      .setDesc('When the hub has a newer version of this plugin, download it automatically.')
      .addToggle((t) =>
        t.setValue(plugin.settings.updates).onChange(async (v) => {
          plugin.settings.updates = v;
          await plugin.saveData(plugin.settings);
        }),
      );
    new Setting(containerEl)
      .setName('Disconnect this device')
      .setDesc('Stops syncing. Notes stay on this device. To connect again you need a new code.')
      .addButton((b) =>
        b
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            if (
              !(await confirmAction(
                this.app,
                'Disconnect this device from KiwiSync?',
                'Disconnect',
              ))
            )
              return;
            await plugin.disconnect();
            this.display();
          }),
      );
  }

  private async showDevices(container: HTMLElement): Promise<void> {
    const plugin = this.plugin;
    let devices: Device[];
    try {
      devices = await plugin.api!.devices();
    } catch (e) {
      container.setText((e as Error).message);
      return;
    }
    container.empty();
    for (const device of devices) {
      const self = device.id === plugin.settings.deviceId;
      const parts = [platformLabel(device)];
      if (self) parts.push('this device');
      else if (device.platform !== 'hub')
        parts.push(device.lastSeen ? `last synced ${formatTime(device.lastSeen)}` : 'never synced');
      if (device.pending && !self)
        parts.push(`${device.pending} ${device.pending === 1 ? 'change' : 'changes'} waiting`);
      const row = new Setting(container).setName(device.name).setDesc(parts.join(', '));
      if (self) continue;
      row.addExtraButton((b) =>
        b
          .setIcon('pencil')
          .setTooltip('Rename')
          .onClick(() => {
            row.controlEl.empty();
            row.addText((t) => {
              t.setValue(device.name);
              t.inputEl.focus();
              t.inputEl.addEventListener('change', async () => {
                try {
                  await plugin.api!.renameDevice(device.id, t.getValue());
                } catch (e) {
                  new Notice((e as Error).message);
                }
                void this.showDevices(container);
              });
            });
          }),
      );
      if (device.platform !== 'hub')
        row.addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip('Remove')
            .onClick(async () => {
              const question = `Remove ${device.name}? It stops syncing and needs a new code to connect again.`;
              if (!(await confirmAction(this.app, question, 'Remove'))) return;
              try {
                await plugin.api!.removeDevice(device.id);
              } catch (e) {
                new Notice((e as Error).message);
              }
              void this.showDevices(container);
            }),
        );
    }
  }
}

function confirmAction(app: App, question: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const modal = new Modal(app);
    modal.contentEl.createEl('p', { text: question });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => modal.close()))
      .addButton((b) =>
        b
          .setButtonText(action)
          .setWarning()
          .onClick(() => {
            answer = true;
            modal.close();
          }),
      );
    modal.onClose = () => resolve(answer);
    modal.open();
  });
}

function drawQr(container: HTMLElement, text: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  const svg = container.createSvg('svg', {
    attr: { viewBox: `0 0 ${size + 4} ${size + 4}`, 'shape-rendering': 'crispEdges' },
  });
  svg.createSvg('rect', { attr: { width: size + 4, height: size + 4, fill: '#fff' } });
  svg.createSvg('path', { attr: { d, fill: '#000' } });
}

function platformLabel(device: Device): string {
  return { hub: 'Hub', desktop: 'Computer', ios: 'iPhone or iPad', android: 'Android' }[
    device.platform
  ];
}

function formatTime(time: number): string {
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
