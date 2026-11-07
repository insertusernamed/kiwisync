export const CONFIG_DIR = '.obsidian';
export const PLUGIN_LIST = `${CONFIG_DIR}/community-plugins.json`;

export type ConfigCategory = 'plugins' | 'themes' | 'settings';

// Plugins each device keeps to itself: this one holds the device's own connection, and other
// sync plugins would fight with it over the same files.
export const LOCAL_PLUGINS = new Set(['kiwisync', 'obsidian-livesync', 'remotely-save']);
const PLUGIN_FILES = new Set(['main.js', 'manifest.json', 'styles.css', 'data.json']);
const THEME_FILES = new Set(['theme.css', 'manifest.json']);
// Open tabs and pane sizes differ between a phone and a desktop.
const DEVICE_SETTINGS = new Set(['workspace.json', 'workspace-mobile.json']);

function isSafe(path: string): boolean {
  if (!path || path.length > 1024 || /^[/"]/.test(path) || path.includes('\\')) return false;
  return !/[\u0000-\u001f\u007f]/.test(path) && path.split('/').every((part) => part !== '');
}

// Notes and attachments. Hidden files and folders (.obsidian, .trash, .git) are not notes.
export function isSyncPath(path: string): boolean {
  return isSafe(path) && path.split('/').every((part) => !part.startsWith('.'));
}

// Obsidian settings that can be synced, grouped by the toggle that turns them on.
export function configCategory(path: string): ConfigCategory | null {
  if (!isSafe(path) || !path.startsWith(`${CONFIG_DIR}/`)) return null;
  const parts = path.slice(CONFIG_DIR.length + 1).split('/');
  if (parts.some((part) => part.startsWith('.'))) return null;
  const [first = '', second = '', third] = parts;
  if (parts.length === 1) {
    if (!first.endsWith('.json') || DEVICE_SETTINGS.has(first)) return null;
    if (path === PLUGIN_LIST) return 'plugins';
    return first === 'appearance.json' ? 'themes' : 'settings';
  }
  if (first === 'plugins' && parts.length === 3 && !LOCAL_PLUGINS.has(second))
    return PLUGIN_FILES.has(third!) ? 'plugins' : null;
  if (first === 'themes' && parts.length === 3) return THEME_FILES.has(third!) ? 'themes' : null;
  if (first === 'snippets' && parts.length === 2) return second.endsWith('.css') ? 'themes' : null;
  return null;
}

// Folders are synced as entries of their own, so empty folders and folder deletions reach
// every device. Their paths end in a slash and their version is FOLDER instead of a blob id.
export const FOLDER = 'folder';

export function isFolderPath(path: string): boolean {
  return path.endsWith('/') && isSyncPath(path.slice(0, -1));
}

// The folders that contain a path, outermost first: "a/b/c.md" gives "a/", "a/b/".
export function parentFolders(path: string): string[] {
  const parts = path.replace(/\/$/, '').split('/').slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

export function isHubPath(path: string): boolean {
  return isSyncPath(path) || isFolderPath(path) || configCategory(path) !== null;
}

// iOS and macOS treat paths that differ only in case or Unicode form as the same file.
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

// Line merging is only safe for prose. Excalidraw notes embed compressed JSON split across
// lines, and canvas files are JSON, so those are replaced whole instead.
export function isMergeable(path: string, text: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) return false;
  return !lower.endsWith('.excalidraw.md') && !/^---\r?\n[\s\S]*?excalidraw-plugin:/.test(text);
}

// The enabled plugin list as the hub keeps it: always including KiwiSync, so a device that
// takes the shared list keeps syncing, and never including another sync plugin.
export function normalizePluginList(text: string): string | null {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.every((id) => typeof id === 'string')) return null;
  const kept = list.filter((id) => id === 'kiwisync' || !LOCAL_PLUGINS.has(id));
  if (!kept.includes('kiwisync')) kept.push('kiwisync');
  return JSON.stringify(kept, null, 2);
}

export function mergePluginLists(a: string, b: string): string | null {
  const first = normalizePluginList(a);
  const second = normalizePluginList(b);
  if (first === null || second === null) return first ?? second;
  const union = [...(JSON.parse(first) as string[])];
  for (const id of JSON.parse(second) as string[]) if (!union.includes(id)) union.push(id);
  return JSON.stringify(union, null, 2);
}
