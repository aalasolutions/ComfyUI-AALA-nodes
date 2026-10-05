import { describe, expect, it } from 'vitest';
import * as items from '../src/state/items';
import { defaultState, parseState, serializeState } from '../src/state/schema';

const file = (path: string, kind: 'image' | 'video' | 'audio' = 'image') => ({ path, kind });

function stateWith(limit: number, count: number) {
  const state = defaultState();
  state.limits.image = limit;
  items.addItems(state, Array.from({ length: count }, (_, index) => file(`/a/${index}.png`)));
  return state;
}

describe('item limits', () => {
  it('adds items inactive once the group is full and routes by kind', () => {
    const state = defaultState();
    state.limits.image = 2;
    const report = items.addItems(state, [file('/1.png'), file('/2.png'), file('/3.png'), file('/v.mp4', 'video')]);
    expect(report.image).toEqual({ added: 3, inactive: 1 });
    expect(report.video).toEqual({ added: 1, inactive: 0 });
    expect(state.groups.image.map((item) => item.active)).toEqual([true, true, false]);
    expect(state.groups.video).toHaveLength(1);
  });

  it('blocks activation at the limit and reports blocked counts', () => {
    const state = stateWith(2, 4);
    const ids = new Set(state.groups.image.map((item) => item.id));
    expect(items.setActive(state, 'image', ids, true)).toEqual({ changed: 0, blocked: 2 });
    items.setActive(state, 'image', new Set([state.groups.image[0].id]), false);
    expect(items.setActive(state, 'image', ids, true)).toEqual({ changed: 1, blocked: 2 });
    expect(items.activeCount(state, 'image')).toBe(2);
  });

  it('lowering a limit deactivates from the bottom', () => {
    const state = stateWith(4, 4);
    expect(items.applyLimit(state, 'image', 1)).toBe(3);
    expect(state.groups.image.map((item) => item.active)).toEqual([true, false, false, false]);
    expect(items.applyLimit(state, 'image', 5)).toBe(0);
  });

  it('never produces a state the validator rejects', () => {
    const state = stateWith(3, 5);
    items.duplicateItem(state, 'image', state.groups.image[0].id);
    items.applyLimit(state, 'image', 2);
    const parsed = parseState(serializeState(state));
    expect(parsed.ok).toBe(true);
  });

  it('duplicates inactive when full and keeps order', () => {
    const state = stateWith(1, 1);
    const copy = items.duplicateItem(state, 'image', state.groups.image[0].id);
    expect(copy?.active).toBe(false);
    expect(state.groups.image[1].id).toBe(copy?.id);
    expect(copy?.id).not.toBe(state.groups.image[0].id);
  });

  it('moves, removes and numbers outputs by active order', () => {
    const state = stateWith(9, 3);
    const [a, b, c] = state.groups.image.map((item) => item.id);
    items.moveItem(state, 'image', c, 0);
    expect(state.groups.image.map((item) => item.id)).toEqual([c, a, b]);
    items.setActive(state, 'image', new Set([a]), false);
    const indexes = items.outputIndexes(state.groups.image);
    expect([indexes.get(c), indexes.get(a), indexes.get(b)]).toEqual([1, undefined, 2]);
    expect(items.removeItems(state, 'image', new Set([a, b]))).toBe(2);
  });

  it('creates items with only the fields that apply to their kind', () => {
    expect(Object.keys(items.createItem(file('/i.png'), true)).sort()).toEqual(['active', 'edit', 'id', 'kind', 'meta', 'path']);
    expect(items.createItem(file('/a.mp3', 'audio'), true).muted).toBe(false);
    expect(items.createItem(file('/v.mp4', 'video'), true)).toMatchObject({ split_of: null, part: null, parts: null });
  });
});
