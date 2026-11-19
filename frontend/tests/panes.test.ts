import { describe, expect, it } from 'vitest';
import { distributePanes, paneSizesFrom, resizePanes, type Pane } from '../src/state/panes';
import { defaultState, parsePaneSizes, parseState, serializeState } from '../src/state/schema';
import { createMediaStore } from '../src/state/store';

const ROW = 50;
const pane = (kind: Pane['kind'], rows: number): Pane => ({ kind, content: rows * (ROW + 4) - 4, floor: ROW });

describe('pane sizes parsing', () => {
  it('accepts positive weights for every kind', () => {
    expect(parsePaneSizes({ image: 0.2, video: 0.5, audio: 0.3 })).toEqual({ image: 0.2, video: 0.5, audio: 0.3 });
  });

  it('rejects garbage', () => {
    for (const value of [
      null,
      'big',
      [1, 2, 3],
      { image: 1, video: 1 },
      { image: 1, video: 1, audio: 0 },
      { image: 1, video: -1, audio: 1 },
      { image: 1, video: '1', audio: 1 },
      { image: 1, video: Number.NaN, audio: 1 },
      { image: 1, video: 1, audio: 1, other: 1 },
    ]) {
      expect(parsePaneSizes(value)).toBeNull();
    }
  });

  it('normalizes weights and rejects ones whose sum is not finite', () => {
    expect(parsePaneSizes({ image: 2, video: 5, audio: 3 })).toEqual({ image: 0.2, video: 0.5, audio: 0.3 });
    expect(parsePaneSizes({ image: 1e308, video: 1e308, audio: 1 })).toBeNull();
  });
});

describe('pane distribution', () => {
  it('caps panes at their content and gives the rest to the long list', () => {
    const heights = distributePanes([pane('image', 1), pane('video', 71), pane('audio', 2)], 600, null);
    expect(heights).toEqual({ image: 50, audio: 104, video: 446 });
  });

  it('shares equally when every list is long', () => {
    expect(distributePanes([pane('image', 40), pane('video', 40)], 601, null)).toEqual({ image: 300, video: 300 });
  });

  it('leaves blank space when all content fits', () => {
    expect(distributePanes([pane('image', 1), pane('video', 2)], 900, null)).toEqual({ image: 50, video: 104 });
  });

  it('fills the height with the only open pane, whatever its content', () => {
    expect(distributePanes([pane('image', 1)], 800, null)).toEqual({ image: 800 });
    expect(distributePanes([pane('image', 1)], 800, { image: 0.2, video: 0.4, audio: 0.4 })).toEqual({ image: 800 });
    expect(distributePanes([pane('image', 1), pane('audio', 1)], 800, null)).toEqual({ image: 50, audio: 50 });
  });

  it('follows dragged proportions over the content cap', () => {
    const sizes = { image: 0.5, video: 0.25, audio: 0.25 };
    expect(distributePanes([pane('image', 1), pane('video', 71), pane('audio', 1)], 800, sizes)).toEqual({
      image: 400,
      video: 200,
      audio: 200,
    });
  });

  it('scales dragged proportions with the available height', () => {
    const sizes = { image: 0.5, video: 0.25, audio: 0.25 };
    const panes = [pane('image', 9), pane('video', 9)];
    expect(distributePanes(panes, 300, sizes)).toEqual({ image: 200, video: 100 });
    expect(distributePanes(panes, 600, sizes)).toEqual({ image: 400, video: 200 });
  });

  it('excludes collapsed groups, which are simply absent', () => {
    const sizes = { image: 0.5, video: 0.25, audio: 0.25 };
    expect(distributePanes([pane('video', 9), pane('audio', 9)], 300, sizes)).toEqual({ video: 150, audio: 150 });
    expect(distributePanes([pane('video', 71)], 300, null)).toEqual({ video: 300 });
  });

  it('keeps every pane at its floor and lets the total overflow', () => {
    const sizes = { image: 0.9, video: 0.05, audio: 0.05 };
    expect(distributePanes([pane('image', 9), pane('video', 9), pane('audio', 9)], 400, sizes)).toEqual({
      image: 300,
      video: 50,
      audio: 50,
    });
    expect(distributePanes([pane('image', 9), pane('video', 9)], 60, null)).toEqual({ image: 50, video: 50 });
    expect(distributePanes([pane('image', 9)], 0, { image: 1, video: 1, audio: 1 })).toEqual({ image: 50 });
  });
});

describe('divider drag', () => {
  const above = { ...pane('image', 9), height: 200 };
  const below = { ...pane('video', 9), height: 200 };

  it('captures current heights and keeps closed panes in their saved ratio', () => {
    expect(paneSizesFrom({ image: 100, video: 300 }, null)).toEqual({ image: 0.1667, video: 0.5, audio: 0.3333 });
    expect(paneSizesFrom({ image: 100, video: 100 }, { image: 0.25, video: 0.25, audio: 0.5 })).toEqual({
      image: 0.25,
      video: 0.25,
      audio: 0.5,
    });
  });

  it('moves space between the two neighbors only', () => {
    const base = { image: 0.4, video: 0.4, audio: 0.2 };
    expect(resizePanes(base, above, below, 100)).toEqual({ image: 0.6, video: 0.2, audio: 0.2 });
  });

  it('tracks the pointer from the first pixel of a drag from content-capped panes', () => {
    const image = { kind: 'image' as const, content: 158, floor: ROW };
    const audio = { kind: 'audio' as const, content: 50, floor: ROW };
    const capped = distributePanes([image, audio], 800, null);
    expect(capped).toEqual({ image: 158, audio: 50 });
    const base = paneSizesFrom(capped, null, 800);
    const start = distributePanes([image, audio], 800, base);
    expect(start).toEqual({ image: 158, audio: 642 });
    for (const delta of [-1, -10, -100, 1, 37]) {
      const sizes = resizePanes(base, { ...image, height: start.image! }, { ...audio, height: start.audio! }, delta);
      expect(distributePanes([image, audio], 800, sizes)).toEqual({ image: 158 + delta, audio: 642 - delta });
    }
  });

  it('changes nothing when the drag is clamped at a floor', () => {
    const image = { kind: 'image' as const, content: 158, floor: ROW };
    const audio = { kind: 'audio' as const, content: 50, floor: ROW };
    const start = distributePanes([image, audio], 208, null);
    const base = paneSizesFrom(start, null, 208);
    const sizes = resizePanes(base, { ...image, height: 158 }, { ...audio, height: 50 }, 1);
    expect(distributePanes([image, audio], 208, sizes)).toEqual(start);
  });

  it('stops at the floors', () => {
    const base = { image: 0.4, video: 0.4, audio: 0.2 };
    const down = resizePanes(base, above, below, 1000);
    const up = resizePanes(base, above, below, -1000);
    expect(distributePanes([above, below], 400, down)).toEqual({ image: 350, video: 50 });
    expect(distributePanes([above, below], 400, up)).toEqual({ image: 50, video: 350 });
  });
});

describe('ui.sizes in saved state', () => {
  it('round-trips', () => {
    const state = defaultState();
    state.ui.sizes = { image: 0.2, video: 0.5, audio: 0.3 };
    const result = parseState(serializeState(state));
    expect(result.ok && result.state).toEqual(state);
  });

  it('loads old state without the field', () => {
    const result = parseState(serializeState(defaultState()));
    expect(result.ok).toBe(true);
    expect(result.ok && 'sizes' in result.state.ui).toBe(false);
  });

  it('drops garbage and keeps the rest of ui', () => {
    const raw = { ...defaultState(), ui: { layout: 'grid', collapsed: { image: true, video: false, audio: false }, sizes: 'x' } };
    const result = parseState(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    expect(result.ok && result.state.ui).toEqual({ layout: 'grid', collapsed: { image: true, video: false, audio: false } });
  });

  it('records one change per new value and none for the same value', () => {
    let commits = 0;
    const store = createMediaStore(() => (commits += 1));
    store.setPaneSizes({ image: 0.2, video: 0.5, audio: 0.3 });
    store.setPaneSizes({ image: 0.2, video: 0.5, audio: 0.3 });
    expect(commits).toBe(1);
    expect(JSON.parse(store.serialize()).ui.sizes).toEqual({ image: 0.2, video: 0.5, audio: 0.3 });
  });
});
