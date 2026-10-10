import type { MediaMeta } from '../api/fs';
import type { MediaItem, MediaKind } from './schema';

// Crop is normalized to the frame after rotate and mirror (PLAN.md 4.1).
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

// Trim is in seconds here; video is stored as frames.
export interface Draft {
  rotate: Rotation;
  mirror: boolean;
  crop: Rect | null;
  trim: { start: number; end: number } | null;
}

const EPSILON = 1e-6;

export function parseFps(fps: string | undefined): number | null {
  if (!fps) {
    return null;
  }
  const [num, den] = fps.split('/').map(Number);
  const rate = den ? num / den : num;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function isFullRect(rect: Rect | null): boolean {
  return !rect || (rect.x <= EPSILON && rect.y <= EPSILON && rect.w >= 1 - EPSILON && rect.h >= 1 - EPSILON);
}

export function rotateRectCw(rect: Rect): Rect {
  return { x: 1 - (rect.y + rect.h), y: rect.x, w: rect.h, h: rect.w };
}

export function rotateRectCcw(rect: Rect): Rect {
  return { x: rect.y, y: 1 - (rect.x + rect.w), w: rect.h, h: rect.w };
}

export function mirrorRect(rect: Rect): Rect {
  return { ...rect, x: 1 - (rect.x + rect.w) };
}

export function centeredRect(ratio: number, width: number, height: number): Rect {
  const frame = width / height;
  return ratio >= frame ? { x: 0, w: 1, h: frame / ratio, y: (1 - frame / ratio) / 2 } : { y: 0, h: 1, w: ratio / frame, x: (1 - ratio / frame) / 2 };
}

export function clampRect(rect: Rect): Rect {
  const w = Math.min(1, Math.max(0, rect.w));
  const h = Math.min(1, Math.max(0, rect.h));
  return { x: Math.min(1 - w, Math.max(0, rect.x)), y: Math.min(1 - h, Math.max(0, rect.y)), w, h };
}

export function draftFromItem(item: Readonly<MediaItem>, meta: MediaMeta | null): Draft {
  const edit = (item.edit ?? {}) as Record<string, unknown>;
  const crop = edit.crop as Rect | null | undefined;
  const raw = edit.trim as { start_frame?: number; end_frame?: number; start?: number; end?: number } | null | undefined;
  let trim: Draft['trim'] = null;
  if (raw && item.kind === 'video') {
    const fps = parseFps(meta?.fps);
    if (fps && raw.start_frame !== undefined && raw.end_frame !== undefined) {
      trim = { start: raw.start_frame / fps, end: raw.end_frame / fps };
    }
  } else if (raw && raw.start !== undefined && raw.end !== undefined) {
    trim = { start: raw.start, end: raw.end };
  }
  return {
    rotate: ([0, 90, 180, 270].includes(edit.rotate as number) ? edit.rotate : 0) as Rotation,
    mirror: edit.mirror === true,
    crop: crop && !isFullRect(crop) ? { ...crop } : null,
    trim,
  };
}

export function editFromDraft(kind: MediaKind, draft: Draft, meta: MediaMeta | null, duration: number): Record<string, unknown> {
  const edit: Record<string, unknown> = {};
  if (kind !== 'audio') {
    if (draft.crop && draft.crop.w > 0 && draft.crop.h > 0 && !isFullRect(draft.crop)) {
      edit.crop = clampRect(draft.crop);
    }
    if (draft.rotate) {
      edit.rotate = draft.rotate;
    }
    if (draft.mirror) {
      edit.mirror = true;
    }
  }
  const trim = draft.trim;
  if (kind === 'image' || !trim || duration <= 0 || (trim.start <= EPSILON && trim.end >= duration - EPSILON)) {
    return edit;
  }
  if (kind === 'video') {
    const fps = parseFps(meta?.fps);
    if (!fps) {
      return edit;
    }
    const total = meta?.frames ?? Math.round(duration * fps);
    const start = Math.max(0, Math.round(trim.start * fps));
    const end = Math.min(total, Math.max(start + 1, Math.round(trim.end * fps)));
    if (start > 0 || end < total) {
      edit.trim = { start_frame: start, end_frame: end };
    }
    return edit;
  }
  edit.trim = { start: Math.max(0, trim.start), end: Math.min(duration, trim.end) };
  return edit;
}

export function trimRange(item: Readonly<MediaItem>, meta: MediaMeta | null): [number, number] | null {
  const trim = (item.edit as Record<string, unknown> | undefined)?.trim as Record<string, number> | null | undefined;
  if (!trim) {
    return null;
  }
  if (item.kind === 'video') {
    const fps = parseFps(meta?.fps);
    const total = meta?.frames ?? (fps && meta?.duration ? Math.round(meta.duration * fps) : null);
    return total ? [trim.start_frame / total, Math.min(1, trim.end_frame / total)] : null;
  }
  const duration = meta?.duration;
  return duration ? [trim.start / duration, Math.min(1, trim.end / duration)] : null;
}

export function formatSeconds(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}
