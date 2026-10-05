import { describe, expect, it } from 'vitest';
import { createItem } from '../src/state/items';
import { defaultState, KINDS, parseState, type MediaKind } from '../src/state/schema';

// Mirrors tests/test_state.py ItemValidationTests so the node shows the same rejections /prompt would give.

function uiItem(kind: MediaKind, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const item: Record<string, unknown> = { id: `id-${kind}`, path: `/media/file.${kind}`, kind, active: true };
  if (kind !== 'image') {
    item.muted = false;
  }
  item.meta = null;
  item.edit = {};
  if (kind === 'video') {
    Object.assign(item, { split_of: null, part: null, parts: null });
  }
  return Object.assign(item, fields);
}

function withItem(kind: MediaKind, item: Record<string, unknown>): string {
  const state = defaultState() as unknown as Record<string, unknown>;
  state.groups = { image: [], video: [], audio: [], [kind]: [item] };
  return JSON.stringify(state);
}

function rejected(kind: MediaKind, pattern: RegExp, fields: Record<string, unknown>): void {
  const result = parseState(withItem(kind, uiItem(kind, fields)));
  expect(result.ok).toBe(false);
  expect(result.ok ? '' : result.error).toMatch(pattern);
}

describe('item validation parity with state.py', () => {
  it('accepts the shape items.ts writes today', () => {
    for (const kind of KINDS) {
      expect(parseState(withItem(kind, uiItem(kind))).ok).toBe(true);
      const written = createItem({ path: `/media/x.${kind}`, kind, meta: { size: 1, mtime: 2 } }, true);
      expect(parseState(withItem(kind, written as Record<string, unknown>)).ok).toBe(true);
    }
  });

  it('accepts full edits', () => {
    const crop = { x: 0.1, y: 0.0, w: 0.8, h: 1.0 };
    expect(parseState(withItem('image', uiItem('image', { edit: { crop, rotate: 270, mirror: true } }))).ok).toBe(true);
    const videoEdit = { crop: null, rotate: 90, mirror: false, trim: { start_frame: 0, end_frame: 24 } };
    const video = uiItem('video', { edit: videoEdit, split_of: 'orig', part: 2, parts: 4, meta: { fps: '30000/1001' } });
    expect(parseState(withItem('video', video)).ok).toBe(true);
    expect(parseState(withItem('audio', uiItem('audio', { edit: { trim: { start: 0.5, end: 1.25 } } }))).ok).toBe(true);
  });

  it('rejects fields that do not apply', () => {
    rejected('image', /muted does not apply/, { muted: false });
    rejected('audio', /split_of does not apply/, { split_of: null });
    rejected('image', /trim does not apply/, { edit: { trim: { start: 0, end: 1 } } });
    rejected('audio', /crop does not apply/, { edit: { crop: null } });
    rejected('audio', /rotate does not apply/, { edit: { rotate: 0 } });
  });

  it('checks field types', () => {
    rejected('image', /meta/, { meta: 'big' });
    rejected('image', /edit must be/, { edit: [] });
    rejected('video', /active/, { active: 'yes' });
    rejected('video', /muted/, { muted: 1 });
    rejected('image', /id must be a string/, { id: 7 });
  });

  it('checks crop rules', () => {
    rejected('image', /within/, { edit: { crop: { x: 0.5, y: 0, w: 0.6, h: 1 } } });
    rejected('image', /crop must be/, { edit: { crop: { x: 0, y: 0, w: 1 } } });
    rejected('image', /within/, { edit: { crop: { x: 0, y: 0, w: 0, h: 1 } } });
  });

  it('checks rotate and mirror rules', () => {
    rejected('image', /rotate/, { edit: { rotate: 45 } });
    rejected('video', /rotate/, { edit: { rotate: false } });
    rejected('video', /mirror/, { edit: { mirror: 1 } });
  });

  it('checks trim rules', () => {
    rejected('video', /integer frames/, { edit: { trim: { start_frame: 5, end_frame: 5 } } });
    rejected('video', /integer frames/, { edit: { trim: { start_frame: 0.5, end_frame: 5 } } });
    rejected('video', /start_frame, end_frame/, { edit: { trim: { start: 0, end: 1 } } });
    rejected('audio', /seconds/, { edit: { trim: { start: 2, end: 1 } } });
  });

  it('checks split rules', () => {
    rejected('video', /split_of/, { split_of: 'orig', part: null, parts: null });
    rejected('video', /split_of/, { split_of: 'orig', part: 5, parts: 4 });
  });

  it('still reports the limit after items pass', () => {
    const state = defaultState() as unknown as Record<string, unknown>;
    state.limits = { image: 1, video: 9, audio: 9 };
    state.groups = { image: [uiItem('image', { id: 'a' }), uiItem('image', { id: 'b' })], video: [], audio: [] };
    const result = parseState(JSON.stringify(state));
    expect(result.ok ? '' : result.error).toBe('limit 1 is full');
  });
});
