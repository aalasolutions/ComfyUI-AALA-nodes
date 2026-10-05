export const SCHEMA_ID = 'aala-media/manager';
export const SCHEMA_VERSION = 1;
export const KINDS = ['image', 'video', 'audio'] as const;
export const DEFAULT_LIMIT = 9;

export type MediaKind = (typeof KINDS)[number];

export interface MediaItem {
  id: string;
  path: string;
  kind: MediaKind;
  active: boolean;
  [key: string]: unknown;
}

export interface MediaState {
  schema: typeof SCHEMA_ID;
  version: number;
  limits: Record<MediaKind, number>;
  groups: Record<MediaKind, MediaItem[]>;
  ui: { layout: 'list' | 'grid'; collapsed: Record<MediaKind, boolean> };
}

export type ParseResult = { ok: true; state: MediaState } | { ok: false; error: string };

export function defaultState(): MediaState {
  return {
    schema: SCHEMA_ID,
    version: SCHEMA_VERSION,
    limits: { image: DEFAULT_LIMIT, video: DEFAULT_LIMIT, audio: DEFAULT_LIMIT },
    groups: { image: [], video: [], audio: [] },
    ui: { layout: 'list', collapsed: { image: false, video: false, audio: false } },
  };
}

export function serializeState(state: MediaState): string {
  return JSON.stringify(state);
}

export function parseState(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Saved media state is not valid JSON.' };
  }
  if (!isRecord(data) || data.schema !== SCHEMA_ID) {
    return { ok: false, error: 'Saved media state has an unknown format.' };
  }
  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
    return { ok: false, error: 'Saved media state has no valid version.' };
  }
  if (data.version > SCHEMA_VERSION) {
    return { ok: false, error: `Saved with a newer version (${data.version}). Update ComfyUI-AALA-nodes to edit it.` };
  }

  const state = defaultState();
  const limits = 'limits' in data ? data.limits : {};
  const groups = 'groups' in data ? data.groups : {};
  if (!isRecord(limits)) {
    return { ok: false, error: 'Saved media state limits are invalid.' };
  }
  if (!isRecord(groups)) {
    return { ok: false, error: 'Saved media state groups are invalid.' };
  }
  for (const kind of KINDS) {
    const limit = kind in limits ? limits[kind] : DEFAULT_LIMIT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      return { ok: false, error: `Limit for ${kind} must be a non-negative integer.` };
    }
    state.limits[kind] = limit;

    const items = kind in groups ? groups[kind] : [];
    if (!Array.isArray(items)) {
      return { ok: false, error: `Group ${kind} must be a list.` };
    }
    for (const item of items) {
      if (!isRecord(item) || item.kind !== kind || typeof item.path !== 'string') {
        return { ok: false, error: `Group ${kind} contains an invalid item.` };
      }
      const itemError = validateItem(kind, item);
      if (itemError) {
        return { ok: false, error: itemError };
      }
    }
    if (items.filter((item) => item.active).length > limit) {
      return { ok: false, error: `limit ${limit} is full` };
    }
    state.groups[kind] = items as MediaItem[];
  }
  if (isRecord(data.ui)) {
    state.ui = { ...state.ui, ...(data.ui as Partial<MediaState['ui']>) };
  }
  return { ok: true, state };
}

// Mirrors aala_media/state.py _validate_item, _validate_edit and _validate_split, with the same messages.
const ITEM_FIELDS: Record<MediaKind, string[]> = {
  image: ['id', 'path', 'kind', 'active', 'meta', 'edit'],
  video: ['id', 'path', 'kind', 'active', 'muted', 'meta', 'edit', 'split_of', 'part', 'parts'],
  audio: ['id', 'path', 'kind', 'active', 'muted', 'meta', 'edit'],
};
const EDIT_FIELDS: Record<MediaKind, string[]> = {
  image: ['crop', 'rotate', 'mirror'],
  video: ['crop', 'rotate', 'mirror', 'trim'],
  audio: ['trim'],
};
const ROTATIONS = [0, 90, 180, 270];
const CROP_EPSILON = 1e-6;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInt = (value: unknown): value is number => Number.isInteger(value);

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
}

function firstExtra(value: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()[0];
}

export function validateItem(kind: MediaKind, item: Record<string, unknown>): string | null {
  const label = `${kind} item ${String(item.path)}`;
  const extra = firstExtra(item, ITEM_FIELDS[kind]);
  if (extra !== undefined) {
    return `${label}: field ${extra} does not apply to ${kind}`;
  }
  if ('id' in item && typeof item.id !== 'string') {
    return `${label}: id must be a string`;
  }
  for (const flag of ['active', 'muted']) {
    if (flag in item && typeof item[flag] !== 'boolean') {
      return `${label}: ${flag} must be true or false`;
    }
  }
  if (item.meta !== undefined && item.meta !== null && !isRecord(item.meta)) {
    return `${label}: meta must be an object or null`;
  }
  const editError = validateEdit(kind, label, 'edit' in item ? item.edit : {});
  if (editError) {
    return editError;
  }
  return kind === 'video' ? validateSplit(label, item) : null;
}

function validateEdit(kind: MediaKind, label: string, edit: unknown): string | null {
  if (!isRecord(edit)) {
    return `${label}: edit must be an object`;
  }
  const extra = firstExtra(edit, EDIT_FIELDS[kind]);
  if (extra !== undefined) {
    return `${label}: edit ${extra} does not apply to ${kind}`;
  }
  const crop = edit.crop;
  if (crop !== undefined && crop !== null) {
    if (!isRecord(crop) || !sameKeys(crop, ['x', 'y', 'w', 'h']) || !Object.values(crop).every(isNumber)) {
      return `${label}: crop must be {x, y, w, h} numbers`;
    }
    const { x, y, w, h } = crop as Record<'x' | 'y' | 'w' | 'h', number>;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + CROP_EPSILON || y + h > 1 + CROP_EPSILON) {
      return `${label}: crop must lie within 0 to 1`;
    }
  }
  if ('rotate' in edit && !(isInt(edit.rotate) && ROTATIONS.includes(edit.rotate as number))) {
    return `${label}: rotate must be one of 0, 90, 180, 270`;
  }
  if ('mirror' in edit && typeof edit.mirror !== 'boolean') {
    return `${label}: mirror must be true or false`;
  }
  const trim = edit.trim;
  if (trim === undefined || trim === null) {
    return null;
  }
  if (kind === 'video') {
    if (!isRecord(trim) || !sameKeys(trim, ['start_frame', 'end_frame'])) {
      return `${label}: trim must be {start_frame, end_frame}`;
    }
    const { start_frame: start, end_frame: end } = trim;
    if (!(isInt(start) && isInt(end) && 0 <= start && start < end)) {
      return `${label}: trim needs integer frames with 0 <= start_frame < end_frame`;
    }
    return null;
  }
  if (!isRecord(trim) || !sameKeys(trim, ['start', 'end'])) {
    return `${label}: trim must be {start, end}`;
  }
  const { start, end } = trim;
  if (!(isNumber(start) && isNumber(end) && 0 <= start && start < end)) {
    return `${label}: trim needs seconds with 0 <= start < end`;
  }
  return null;
}

function validateSplit(label: string, item: Record<string, unknown>): string | null {
  const none = (value: unknown) => value === undefined || value === null;
  const { split_of: splitOf, part, parts } = item;
  if (none(splitOf) && none(part) && none(parts)) {
    return null;
  }
  if (typeof splitOf !== 'string' || !isInt(part) || !isInt(parts) || part < 1 || part > parts) {
    return `${label}: split_of, part and parts must be set together with 1 <= part <= parts`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
