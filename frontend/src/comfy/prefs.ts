import { getSettingStore, type SettingDefinition } from './host';

// Browser preferences live in ComfyUI settings (AalaMedia.Browser.*), with localStorage when that store is unreachable.

export type SortKey = 'name' | 'mtime' | 'size' | 'kind';
export type ThumbSize = 's' | 'm' | 'l';

export interface BrowserPrefs {
  favorites: string[];
  recent: string[];
  view: 'grid' | 'list';
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  thumbSize: ThumbSize;
  showHidden: boolean;
  dialogSize: { w: number; h: number } | null;
}

const DEFAULTS: BrowserPrefs = {
  favorites: [],
  recent: [],
  view: 'grid',
  sort: { key: 'name', dir: 'asc' },
  thumbSize: 'm',
  showHidden: false,
  dialogSize: null,
};

const IDS: Record<keyof BrowserPrefs, string> = {
  favorites: 'AalaMedia.Browser.Favorites',
  recent: 'AalaMedia.Browser.Recent',
  view: 'AalaMedia.Browser.View',
  sort: 'AalaMedia.Browser.Sort',
  thumbSize: 'AalaMedia.Browser.ThumbSize',
  showHidden: 'AalaMedia.Browser.ShowHidden',
  dialogSize: 'AalaMedia.Browser.DialogSize',
};

export const RECENT_LIMIT = 10;

export const PREF_SETTINGS: SettingDefinition[] = (Object.keys(IDS) as (keyof BrowserPrefs)[]).map((key) => ({
  id: IDS[key],
  name: IDS[key],
  type: 'hidden',
  defaultValue: DEFAULTS[key],
}));

function readLocal(id: string): unknown {
  try {
    const raw = localStorage.getItem(id);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function getPref<K extends keyof BrowserPrefs>(key: K): BrowserPrefs[K] {
  const store = getSettingStore();
  const value = store ? store.get(IDS[key]) : readLocal(IDS[key]);
  // Plain copy: the host store hands out reactive proxies.
  return JSON.parse(JSON.stringify(isValid(key, value) ? value : DEFAULTS[key])) as BrowserPrefs[K];
}

export function setPref<K extends keyof BrowserPrefs>(key: K, value: BrowserPrefs[K]): void {
  const store = getSettingStore();
  if (store) {
    store.set(IDS[key], value).catch((error) => console.warn('[aala-media] could not save setting', error));
    return;
  }
  try {
    localStorage.setItem(IDS[key], JSON.stringify(value));
  } catch {
    // Storage may be unavailable; preferences then last for the session only.
  }
}

function isValid(key: keyof BrowserPrefs, value: unknown): boolean {
  if (value === undefined || value === null) {
    return key === 'dialogSize' && value === null;
  }
  const fallback = DEFAULTS[key];
  if (Array.isArray(fallback)) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }
  if (key === 'sort') {
    const sort = value as BrowserPrefs['sort'];
    return ['name', 'mtime', 'size', 'kind'].includes(sort.key) && ['asc', 'desc'].includes(sort.dir);
  }
  if (key === 'dialogSize') {
    const size = value as { w: unknown; h: unknown };
    return typeof size.w === 'number' && typeof size.h === 'number';
  }
  if (key === 'view') {
    return value === 'grid' || value === 'list';
  }
  if (key === 'thumbSize') {
    return value === 's' || value === 'm' || value === 'l';
  }
  return typeof value === typeof fallback;
}
