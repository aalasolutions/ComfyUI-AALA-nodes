import type { Entry, FileEntry, MediaMeta } from '../api/fs';
import type { SortKey } from '../comfy/prefs';
import type { MediaKind } from '../state/schema';

export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export type KindFilter = MediaKind | 'all';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: Entry, b: Entry, key: SortKey): number {
  if (key === 'mtime' && a.mtime !== b.mtime) {
    return a.mtime - b.mtime;
  }
  if (a.type === 'file' && b.type === 'file') {
    if (key === 'size' && a.size !== b.size) {
      return a.size - b.size;
    }
    if (key === 'kind' && a.kind !== b.kind) {
      return collator.compare(a.kind, b.kind);
    }
  }
  return collator.compare(a.name, b.name);
}

/** Folders always come first; both blocks follow the chosen key and direction. */
export function sortEntries(entries: readonly Entry[], spec: SortSpec): Entry[] {
  const sign = spec.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1;
    }
    return sign * compare(a, b, spec.key);
  });
}

export function filterEntries(entries: readonly Entry[], query: string, kind: KindFilter): Entry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (entry.type === 'file' && kind !== 'all' && entry.kind !== kind) {
      return false;
    }
    return needle === '' || entry.name.toLowerCase().includes(needle);
  });
}

export function filesOf(entries: readonly Entry[]): FileEntry[] {
  return entries.filter((entry): entry is FileEntry => entry.type === 'file');
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export function formatDate(mtime: number): string {
  return new Date(mtime * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const NAMED_RATIOS: [number, string][] = [
  [1, '1:1 Square'],
  [16 / 9, '16:9 Widescreen'],
  [9 / 16, '9:16 Portrait'],
  [4 / 3, '4:3'],
  [3 / 4, '3:4'],
  [3 / 2, '3:2'],
  [2 / 3, '2:3'],
  [21 / 9, '21:9 Ultrawide'],
  [9 / 21, '9:21'],
];

export function ratioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return '';
  }
  const ratio = width / height;
  const named = NAMED_RATIOS.find(([value]) => Math.abs(value - ratio) / value < 0.01);
  return named ? named[1] : `${ratio.toFixed(2)}:1`;
}

/** Short info line: dimensions for images, duration and dimensions for videos, duration for audio. */
export function describeMeta(kind: MediaKind, meta: MediaMeta | null | undefined): string {
  if (!meta) {
    return '';
  }
  const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '';
  const duration = meta.duration !== undefined ? formatDuration(meta.duration) : '';
  if (kind === 'image') {
    return size;
  }
  if (kind === 'audio') {
    return duration;
  }
  return [duration, size].filter(Boolean).join(' · ');
}
