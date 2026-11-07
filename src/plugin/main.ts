import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  requestUrl,
} from 'obsidian';
import { configCategory, isFolderPath, isSyncPath, type ConfigCategory } from '../shared/paths';
import { Api, ApiError, type Fetcher } from './api';
import { defaultDeviceName, devicePlatform } from './device';
import { ObsidianVault } from './obsidian-vault';
import { SyncEngine, emptyState, type JoinMode, type SyncState } from './sync';
import { ConnectModal, DeletedModal, HistoryModal, InviteModal, KiwiSyncSettingTab } from './ui';

interface Settings {
  server: string;
  deviceId: string;
  deviceName: string;
  secretId: string;
  updates: boolean;
  settingsSync: Record<ConfigCategory, boolean>;
}

const DEFAULTS: Settings = {
  server: '',
  deviceId: '',
  deviceName: '',
  secretId: '',
  updates: true,
  settingsSync: { plugins: false, themes: false, settings: false },
};
const GROUP_LABELS: Record<ConfigCategory, string> = {
  plugins: 'plugins',
  themes: 'themes and snippets',
  settings: 'settings',
};
const OTHER_SYNC_PLUGINS: Record<string, string> = {
  'obsidian-livesync': 'Self-hosted LiveSync',
  'remotely-save': 'Remotely Save',
};
const POLL_SECONDS = 60;
const TYPING_PAUSE_MS = 750;
const DRAWING_PAUSE_MS = 1500;

// The parts of an Excalidraw drawing view that its own scripting interface uses.
interface DrawingView {
  isDirty?(): boolean;
  forceSave?(silent: boolean): Promise<void>;
}
const UPDATE_CHECK_MINUTES = 60;

export const fetcher: Fetcher = async ({ url, method, headers, body }) => {
  const response = await requestUrl({ url, method, headers, body, throw: false });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(response.headers)) lower[k.toLowerCase()] = v;
  return { status: response.status, headers: lower, body: response.arrayBuffer };
};

export default class KiwiSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  api: Api | null = null;
  engine: SyncEngine | null = null;
  error: string | null = null;
  private statusBar: HTMLElement | null = null;
  private settingTab: KiwiSyncSettingTab | null = null;
  private debounce: number | undefined;
  private typing: number | undefined;
  private drawing: number | undefined;
  private stopped = false;
  private lastUpdateCheck = 0;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = {
      ...DEFAULTS,
      ...saved,
      settingsSync: { ...DEFAULTS.settingsSync, ...saved?.settingsSync },
    };
    this.settingTab = new KiwiSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (Platform.isDesktopApp) this.statusBar = this.addStatusBarItem();
    this.addRibbonIcon('refresh-cw', 'KiwiSync: sync now', () => void this.sync(true));

    this.registerObsidianProtocolHandler('kiwisync', (params) => {
      if (this.connected) new Notice('This device is already connected to KiwiSync.');
      else new ConnectModal(this.app, this, params.server ?? '', params.code ?? '').open();
    });
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.sync(true) });
    this.addCommand({
      id: 'file-history',
      name: 'Show version history of the current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.api) return false;
        if (!checking) new HistoryModal(this.app, this, file.path).open();
        return true;
      },
    });
    this.addCommand({
      id: 'add-device',
      name: 'Add a device',
      checkCallback: (checking) => {
        if (!this.api) return false;
        if (!checking) new InviteModal(this.app, this).open();
        return true;
      },
    });
    this.addCommand({
      id: 'deleted-files',
      name: 'Recover a deleted file',
      checkCallback: (checking) => {
        if (!this.api) return false;
        if (!checking) new DeletedModal(this.app, this).open();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !this.api || !isSyncPath(file.path)) return;
        menu.addItem((item) =>
          item
            .setTitle('Version history')
            .setIcon('history')
            .onClick(() => new HistoryModal(this.app, this, file.path).open()),
        );
      }),
    );

    const edited = (file: TAbstractFile, oldPath?: string) => {
      if (!this.engine) return;
      const suffix = file instanceof TFolder ? '/' : '';
      if (oldPath) this.engine.noteEdit(oldPath + suffix);
      this.engine.noteEdit(file.path + suffix);
      this.syncSoon();
    };
    this.app.workspace.onLayoutReady(() => {
      // Obsidian saves about two seconds after typing stops. Saving sooner gets the edit to
      // other devices sooner.
      this.registerEvent(
        this.app.workspace.on('editor-change', (_editor, info) => {
          if (!this.engine || !(info instanceof MarkdownView)) return;
          window.clearTimeout(this.typing);
          this.typing = window.setTimeout(() => {
            void info.save().then(() => {
              if (info.file) this.engine?.noteEdit(info.file.path);
              return this.sync();
            });
          }, TYPING_PAUSE_MS);
        }),
      );
      for (const type of ['pointerup', 'keyup'] as const)
        this.registerDomEvent(document, type, (e) => this.drawingActivity(e), { capture: true });
      this.registerEvent(this.app.vault.on('create', (f) => edited(f)));
      this.registerEvent(this.app.vault.on('modify', (f) => edited(f)));
      this.registerEvent(this.app.vault.on('delete', (f) => edited(f, f.path)));
      this.registerEvent(
        this.app.vault.on('rename', (f, oldPath) => {
          if (!this.engine) return;
          // Files move as renames. Folders, including those inside, are noticed by the next scan
          // as removed at the old path and created at the new one.
          if (f instanceof TFolder) {
            Vault.recurseChildren(f, (child) => {
              if (child instanceof TFile)
                this.engine?.noteRename(oldPath + child.path.slice(f.path.length), child.path);
            });
            this.engine.noteEdit(`${oldPath}/`);
            this.engine.noteEdit(`${f.path}/`);
          } else this.engine.noteRename(oldPath, f.path);
          this.syncSoon();
        }),
      );
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (!document.hidden) void this.sync();
      });
      this.registerInterval(window.setInterval(() => void this.sync(), POLL_SECONDS * 1000));
      this.registerInterval(window.setInterval(() => this.refresh(), 10_000));
      void this.start();
      void this.listen();
    });
  }

  onunload(): void {
    this.stopped = true;
    window.clearTimeout(this.debounce);
    window.clearTimeout(this.typing);
    window.clearTimeout(this.drawing);
  }

  get connected(): boolean {
    return !!this.settings.server && !!this.token();
  }

  // Another sync plugin writing the same files would undo KiwiSync's changes and vice versa.
  otherSyncPlugin(): { id: string; name: string } | null {
    const enabled = (this.app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins
      .enabledPlugins;
    const id = Object.keys(OTHER_SYNC_PLUGINS).find((p) => enabled.has(p));
    return id ? { id, name: OTHER_SYNC_PLUGINS[id]! } : null;
  }

  async disableOtherSyncPlugin(): Promise<void> {
    const other = this.otherSyncPlugin();
    if (!other) return;
    const plugins = (
      this.app as unknown as { plugins: { disablePluginAndSave(id: string): Promise<void> } }
    ).plugins;
    await plugins.disablePluginAndSave(other.id);
    await this.start();
  }

  async connect(
    server: string,
    code: string,
    name: string,
    mode: JoinMode | null,
  ): Promise<string | null> {
    server = server.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(server)) server = `https://${server}`;
    const anonymous = new Api(server, null, fetcher);
    const health = await anonymous.health().catch((e: unknown) => {
      throw e instanceof ApiError && e.status === 0
        ? new Error(`Nothing answered at ${server}. Check the address and your connection.`)
        : e;
    });
    if (health.app !== 'kiwisync') throw new Error(`${server} is not a KiwiSync server.`);
    const paired = await anonymous.pair({
      code,
      name: name.trim() || defaultDeviceName(),
      platform: devicePlatform(),
    });

    this.settings.server = server;
    this.settings.deviceId = paired.device.id;
    this.settings.deviceName = paired.device.name;
    this.settings.secretId ||= `kiwisync-${crypto.randomUUID()}`;
    this.app.secretStorage.setSecret(this.settings.secretId, paired.token);
    await this.saveData(this.settings);
    await this.writeState(emptyState());
    return this.start(mode ? { mode, label: paired.device.name } : undefined);
  }

  async disconnect(): Promise<void> {
    if (this.settings.secretId) this.app.secretStorage.setSecret(this.settings.secretId, '');
    this.settings = {
      ...DEFAULTS,
      updates: this.settings.updates,
      settingsSync: this.settings.settingsSync,
    };
    await this.saveData(this.settings);
    await this.writeState(emptyState());
    this.engine = null;
    this.api = null;
    this.error = null;
    this.refresh();
  }

  // Turning a group on takes the hub's copies of files both sides have, after saving this
  // device's copies on a history branch. Returns that branch, if one was needed.
  async setSettingsSync(group: ConfigCategory, on: boolean): Promise<string | null> {
    this.settings.settingsSync[group] = on;
    await this.saveData(this.settings);
    const inGroup = (path: string) => configCategory(path) === group;
    if (!this.engine) return null;
    if (!on) {
      this.engine.forget(inGroup);
      return null;
    }
    let branch: string | null;
    try {
      branch = await this.engine.adopt(
        inGroup,
        `${this.settings.deviceName} ${GROUP_LABELS[group]}`,
      );
    } catch (e) {
      this.settings.settingsSync[group] = false;
      await this.saveData(this.settings);
      this.engine.forget(inGroup);
      throw e;
    }
    await this.sync();
    return branch;
  }

  private wanted = (path: string): boolean => {
    if (isSyncPath(path) || isFolderPath(path)) return true;
    const group = configCategory(path);
    return group !== null && this.settings.settingsSync[group];
  };

  async renameThisDevice(name: string): Promise<void> {
    if (!this.api) return;
    const device = await this.api.renameDevice(this.settings.deviceId, name);
    this.settings.deviceName = device.name;
    await this.saveData(this.settings);
  }

  // Manual syncs explain why nothing happened; background ones stay quiet.
  async sync(manual = false): Promise<void> {
    if (!this.engine) {
      if (manual) new Notice(`KiwiSync: ${this.statusText()}`);
      return;
    }
    try {
      await this.engine.sync();
      this.error = null;
      void this.checkForUpdate();
    } catch (e) {
      this.error = e instanceof ApiError && e.status === 0 ? null : (e as Error).message;
    }
    this.refresh();
  }

  statusText(): string {
    if (!this.connected) return 'Not connected';
    const other = this.otherSyncPlugin();
    if (other) return `Paused: turn off ${other.name} first`;
    const engine = this.engine;
    if (!engine) return 'Starting';
    if (engine.busy) return 'Syncing';
    if (this.error) return `Error: ${this.error}`;
    const failed = engine.errors.size;
    if (failed) return `${failed} ${failed === 1 ? 'file' : 'files'} could not sync`;
    const waiting = Object.keys(engine.state.dirty).length;
    if (engine.lastSync === null || Date.now() - engine.lastSync > 3 * POLL_SECONDS * 1000)
      return waiting
        ? `Offline, ${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting`
        : 'Offline';
    return 'Synced';
  }

  refresh(): void {
    this.statusBar?.setText(`KiwiSync: ${this.statusText()}`);
    this.settingTab?.refreshStatus();
  }

  private token(): string | null {
    return this.settings.secretId
      ? this.app.secretStorage.getSecret(this.settings.secretId) || null
      : null;
  }

  // Creates the sync engine once the device is connected and no other sync plugin is on.
  // On the first connection `join` prepares existing notes before anything is synced.
  private async start(join?: { mode: JoinMode; label: string }): Promise<string | null> {
    this.refresh();
    if (!this.connected || this.engine || this.otherSyncPlugin()) return null;
    this.api = new Api(this.settings.server, this.token(), fetcher);
    const engine = new SyncEngine(
      new ObsidianVault(this.app),
      this.api,
      await this.readState(),
      (state) => this.writeState(state),
      {
        replaced: (path, by) => this.showReplaced(path, by),
        disconnected: (message) => {
          new Notice(`KiwiSync stopped: ${message}`, 0);
          void this.disconnect();
        },
        settingsChanged: () => this.showSettingsChanged(),
      },
    );
    engine.wanted = this.wanted;
    const branch = join ? await engine.join(join.mode, join.label) : null;
    this.engine = engine;
    await this.sync();
    return branch;
  }

  // Holds a request open on the server so changes from other devices arrive within seconds.
  private async listen(): Promise<void> {
    while (!this.stopped) {
      if (document.hidden || !this.engine || !this.api) {
        await sleep(5000);
        continue;
      }
      try {
        const { cursor, serverId } = this.engine.state;
        const page = await this.api.changes(cursor, serverId, 25);
        if (page.changes.length && !this.stopped) await this.sync();
      } catch {
        await sleep(15_000);
      }
    }
  }

  // Excalidraw keeps a drawing in memory and saves it on a timer, every 10 to 60 seconds.
  // Saving shortly after the pen lifts gets strokes to other devices about as fast as text.
  private drawingActivity(event: Event): void {
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (!this.engine || view?.getViewType() !== 'excalidraw') return;
    if (!(event.target instanceof Node) || !view.containerEl.contains(event.target)) return;
    window.clearTimeout(this.drawing);
    this.drawing = window.setTimeout(() => {
      const drawing = view as unknown as DrawingView;
      if (drawing.isDirty?.()) void drawing.forceSave?.(true);
    }, DRAWING_PAUSE_MS);
  }

  private syncSoon(): void {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => void this.sync(), 500);
  }

  private showSettingsChanged(): void {
    const message = createFragment((f) => {
      f.appendText('New plugins or settings arrived from the hub. ');
      f.createEl('a', { text: 'Reload Obsidian to use them', href: '#' }, (a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          (
            this.app as unknown as { commands: { executeCommandById(id: string): boolean } }
          ).commands.executeCommandById('app:reload');
        }),
      );
    });
    new Notice(message, 0);
  }

  private showReplaced(path: string, by: string): void {
    const message = createFragment((f) => {
      f.appendText(
        `Your edit to "${path}" overlapped a newer edit from ${by}. The newer text was kept. `,
      );
      f.createEl('a', { text: 'See version history', href: '#' }, (a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          new HistoryModal(this.app, this, path).open();
        }),
      );
    });
    new Notice(message, 15_000);
  }

  // Installs a newer plugin build from the hub, so devices only need to be set up once.
  private async checkForUpdate(): Promise<void> {
    if (!this.settings.updates || !this.api) return;
    if (Date.now() - this.lastUpdateCheck < UPDATE_CHECK_MINUTES * 60_000) return;
    this.lastUpdateCheck = Date.now();
    const { pluginVersion } = await this.api.health();
    if (!pluginVersion || compareVersions(pluginVersion, this.manifest.version) <= 0) return;
    const dir = this.manifest.dir!;
    const files = await Promise.all(
      ['main.js', 'manifest.json', 'styles.css'].map(async (name) => {
        const response = await requestUrl({ url: `${this.settings.server}/plugin/${name}` });
        return [name, response.text] as const;
      }),
    );
    for (const [name, text] of files) await this.app.vault.adapter.write(`${dir}/${name}`, text);
    const message = createFragment((f) => {
      f.appendText(`KiwiSync updated to ${pluginVersion}. `);
      f.createEl('a', { text: 'Reload it now', href: '#' }, (a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const plugins = (
            this.app as unknown as {
              plugins: {
                disablePlugin(id: string): Promise<void>;
                enablePlugin(id: string): Promise<void>;
              };
            }
          ).plugins;
          void plugins
            .disablePlugin(this.manifest.id)
            .then(() => plugins.enablePlugin(this.manifest.id));
        }),
      );
    });
    new Notice(message, 0);
  }

  private statePath(): string {
    return `${this.manifest.dir}/state.json`;
  }

  private async readState(): Promise<SyncState> {
    try {
      return {
        ...emptyState(),
        ...JSON.parse(await this.app.vault.adapter.read(this.statePath())),
      };
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: SyncState): Promise<void> {
    await this.app.vault.adapter.write(this.statePath(), JSON.stringify(state));
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
