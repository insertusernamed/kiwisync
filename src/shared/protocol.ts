export const PROTOCOL = 1;

export type Platform = 'desktop' | 'ios' | 'android' | 'hub';

export interface Change {
  path: string;
  blob: string | null;
  seq: number;
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

export type HistoryKind = 'edit' | 'delete' | 'merge' | 'replaced' | 'restore' | 'import';

export interface HistoryEntry {
  commit: string;
  blob: string | null;
  time: number;
  device: string;
  kind: HistoryKind;
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
