export const PROTOCOL = 1;

export type Platform = 'desktop' | 'ios' | 'android' | 'hub';

export interface Change {
  // A path ending in a slash is a folder, with FOLDER as its blob.
  path: string;
  blob: string | null;
  seq: number;
  // Set when this file was renamed from another path. The old path's deletion follows.
  from?: string;
}

export interface ChangesResponse {
  serverId: string;
  latest: number;
  changes: Change[];
  more: boolean;
  // Edits of this device that a newer edit from another device later replaced.
  replaced: Replacement[];
}

export interface Replacement {
  path: string;
  by: string;
}

// saved: the upload is now the current version.
// unchanged: the server already had these exact contents.
// merged: the upload was combined with edits made elsewhere since the device last synced.
// outdated: a newer version of the whole file won; the upload is kept in history.
// deleted: a newer deletion won; the upload is kept in history.
export type PutOutcome = 'saved' | 'unchanged' | 'merged' | 'outdated' | 'deleted';

export interface PutResponse {
  outcome: PutOutcome;
  blob: string | null;
  seq: number;
  // Set when some or all of the upload was replaced by a newer edit from this device.
  lostTo: string | null;
  // Set when the file had been renamed on the hub. The upload was applied at this path.
  movedTo?: string;
}

export interface DeleteResponse {
  outcome: 'deleted' | 'kept';
  blob: string | null;
  seq: number;
}

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  lastSeen: number | null;
  pending: number;
}

export type HistoryKind =
  'edit' | 'delete' | 'merge' | 'replaced' | 'restore' | 'import' | 'rename';

export interface HistoryEntry {
  commit: string;
  blob: string | null;
  time: number;
  device: string;
  kind: HistoryKind;
  // For a rename, the previous path.
  from?: string;
}

export interface FolderResponse {
  // kept: a delete was refused because the folder holds files this device has not seen.
  outcome: 'created' | 'deleted' | 'kept';
  seq: number;
}

export interface RenameResponse {
  blob: string;
  seq: number;
}

export interface DeletedFile {
  path: string;
  blob: string;
  time: number;
  device: string;
}

export interface PairRequest {
  code: string;
  name: string;
  platform: Platform;
}

export interface PairResponse {
  token: string;
  device: Device;
  hubName: string;
}

export interface Health {
  app: 'kiwisync';
  protocol: number;
  pluginVersion: string | null;
  hubName: string;
}
