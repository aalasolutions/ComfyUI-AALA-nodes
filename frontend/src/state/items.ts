import type { MediaMeta } from '../api/fs';
import type { MediaItem, MediaKind, MediaState } from './schema';

export interface NewFile {
  path: string;
  kind: MediaKind;
  meta?: MediaMeta | null;
}

export const OUTPUT_PREFIX: Record<MediaKind, string> = { image: 'IMG', video: 'VID', audio: 'AUD' };

export function newId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // randomUUID needs a secure context; a remote server over plain http does not provide one.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Persisted item shape; fields that do not apply to a kind are left out.
export function createItem(file: NewFile, active: boolean): MediaItem {
  const item: MediaItem = { id: newId(), path: file.path, kind: file.kind, active };
  if (file.kind !== 'image') {
    item.muted = false;
  }
  item.meta = file.meta ?? null;
  item.edit = {};
  if (file.kind === 'video') {
    item.split_of = null;
    item.part = null;
    item.parts = null;
  }
  return item;
}

export function activeCount(state: MediaState, kind: MediaKind): number {
  return state.groups[kind].filter((item) => item.active).length;
}

export function hasRoom(state: MediaState, kind: MediaKind): boolean {
  return activeCount(state, kind) < state.limits[kind];
}

/** Appends files to their groups; files beyond a full group's limit come in inactive. */
export function addItems(state: MediaState, files: NewFile[]): Record<MediaKind, { added: number; inactive: number }> {
  const report = { image: { added: 0, inactive: 0 }, video: { added: 0, inactive: 0 }, audio: { added: 0, inactive: 0 } };
  for (const file of files) {
    const active = hasRoom(state, file.kind);
    state.groups[file.kind].push(createItem(file, active));
    report[file.kind].added += 1;
    if (!active) {
      report[file.kind].inactive += 1;
    }
  }
  return report;
}

/** Sets active state for the given items in group order; activation stops at the limit. */
export function setActive(
  state: MediaState,
  kind: MediaKind,
  ids: Set<string>,
  active: boolean,
): { changed: number; blocked: number } {
  let changed = 0;
  let blocked = 0;
  for (const item of state.groups[kind]) {
    if (!ids.has(item.id) || item.active === active) {
      continue;
    }
    if (active && !hasRoom(state, kind)) {
      blocked += 1;
      continue;
    }
    item.active = active;
    changed += 1;
  }
  return { changed, blocked };
}

export function setMuted(state: MediaState, kind: MediaKind, ids: Set<string>, muted: boolean): number {
  if (kind === 'image') {
    return 0;
  }
  let changed = 0;
  for (const item of state.groups[kind]) {
    if (ids.has(item.id) && item.muted !== muted) {
      item.muted = muted;
      changed += 1;
    }
  }
  return changed;
}

export function removeItems(state: MediaState, kind: MediaKind, ids: Set<string>): number {
  const before = state.groups[kind].length;
  state.groups[kind] = state.groups[kind].filter((item) => !ids.has(item.id));
  return before - state.groups[kind].length;
}

/** Moves one item to a new index within its group. `to` is the index in the list after removal. */
export function moveItem(state: MediaState, kind: MediaKind, id: string, to: number): boolean {
  const items = state.groups[kind];
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) {
    return false;
  }
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (target === from) {
    return false;
  }
  const [item] = items.splice(from, 1);
  items.splice(target, 0, item);
  return true;
}

/** Copies an item right after the original with a new id; the copy is inactive when the group is full. */
export function duplicateItem(state: MediaState, kind: MediaKind, id: string): MediaItem | null {
  const items = state.groups[kind];
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    return null;
  }
  const copy = JSON.parse(JSON.stringify(items[index])) as MediaItem;
  copy.id = newId();
  copy.active = copy.active && hasRoom(state, kind);
  items.splice(index + 1, 0, copy);
  return copy;
}

export function replacePath(state: MediaState, kind: MediaKind, id: string, path: string, meta: MediaMeta | null): boolean {
  const item = state.groups[kind].find((entry) => entry.id === id);
  if (!item) {
    return false;
  }
  item.path = path;
  item.meta = meta;
  return true;
}

export function setEdit(state: MediaState, kind: MediaKind, id: string, edit: Record<string, unknown>): boolean {
  const item = state.groups[kind].find((entry) => entry.id === id);
  if (!item) {
    return false;
  }
  item.edit = edit;
  return true;
}

/** Applies a new limit; active items beyond it are deactivated from the bottom. Returns how many. */
export function applyLimit(state: MediaState, kind: MediaKind, limit: number): number {
  state.limits[kind] = limit;
  let excess = activeCount(state, kind) - limit;
  let deactivated = 0;
  const items = state.groups[kind];
  for (let index = items.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (items[index].active) {
      items[index].active = false;
      excess -= 1;
      deactivated += 1;
    }
  }
  return deactivated;
}

/** Why an active item is left out of its output at Run: muted audio or a missing file. */
export function skipReason(item: Readonly<MediaItem>, missing: boolean): 'muted' | 'missing' | null {
  if (missing) {
    return 'missing';
  }
  return item.kind === 'audio' && item.muted === true ? 'muted' : null;
}

/**
 * Output position (1-based) of each active item in its group, matching the node's output list order.
 * Items that Run skips take no position and do not shift the ones after them.
 */
export function outputIndexes(
  items: readonly Readonly<MediaItem>[],
  isMissing: (item: Readonly<MediaItem>) => boolean = () => false,
): Map<string, number> {
  const indexes = new Map<string, number>();
  let next = 0;
  for (const item of items) {
    if (item.active && !skipReason(item, isMissing(item))) {
      indexes.set(item.id, next);
      next += 1;
    }
  }
  return indexes;
}
