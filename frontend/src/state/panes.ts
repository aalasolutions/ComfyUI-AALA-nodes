import { KINDS, type MediaKind, type PaneSizes } from './schema';

/** An open group with a list: `content` is the full list height, `floor` one row. */
export interface Pane {
  kind: MediaKind;
  content: number;
  floor: number;
}

export type PaneHeights = Partial<Record<MediaKind, number>>;

/**
 * List heights for the open panes. Without saved sizes the panes share `available` equally, each capped at its
 * content; with saved sizes they fill it by weight. A single open pane fills it. No pane goes below its floor, even if
 * that overflows.
 */
export function distributePanes(panes: Pane[], available: number, sizes: PaneSizes | null): PaneHeights {
  const heights: PaneHeights = {};
  let pool = [...panes];
  let remaining = Math.max(0, available);
  const weight = (pane: Pane) => (sizes ? sizes[pane.kind] : 1);
  const fill = sizes !== null || panes.length === 1;
  while (pool.length > 0) {
    const total = pool.reduce((sum, pane) => sum + weight(pane), 0);
    const share = (pane: Pane) => (remaining * weight(pane)) / total;
    const capped = fill ? [] : pool.filter((pane) => pane.content <= share(pane));
    const floored = capped.length > 0 ? [] : pool.filter((pane) => share(pane) < pane.floor);
    if (capped.length === 0 && floored.length === 0) {
      // Weighted panes round their edges, not their heights, so they fill `remaining` and divider positions are exact.
      let edge = 0;
      let offset = 0;
      pool.forEach((pane) => {
        if (!sizes) {
          heights[pane.kind] = Math.floor(share(pane));
          return;
        }
        offset += share(pane);
        const next = Math.round(offset);
        heights[pane.kind] = next - edge;
        edge = next;
      });
      break;
    }
    const fixed = new Map<Pane, number>([
      ...capped.map((pane): [Pane, number] => [pane, pane.content]),
      ...floored.map((pane): [Pane, number] => [pane, pane.floor]),
    ]);
    fixed.forEach((height, pane) => {
      heights[pane.kind] = Math.floor(height);
      remaining = Math.max(0, remaining - height);
    });
    pool = pool.filter((pane) => !fixed.has(pane));
  }
  return heights;
}

/**
 * Weights that reproduce the current open heights, with any space left under the stack (`available` minus the open
 * heights) given to the bottom open pane; closed panes keep their saved ratio, or the open average.
 */
export function paneSizesFrom(heights: PaneHeights, previous: PaneSizes | null, available = 0): PaneSizes {
  const open = KINDS.filter((kind) => (heights[kind] ?? 0) > 0);
  const filled = { ...heights };
  const used = open.reduce((sum, kind) => sum + (heights[kind] ?? 0), 0);
  if (open.length > 0 && available > used) {
    const bottom = open[open.length - 1];
    filled[bottom] = (filled[bottom] ?? 0) + available - used;
  }
  const openTotal = open.reduce((sum, kind) => sum + (filled[kind] ?? 0), 0);
  const previousOpen = previous ? open.reduce((sum, kind) => sum + previous[kind], 0) : 0;
  const raw = {} as PaneSizes;
  for (const kind of KINDS) {
    if (open.includes(kind)) {
      raw[kind] = filled[kind] ?? 0;
    } else if (previous && previousOpen > 0) {
      raw[kind] = (previous[kind] * openTotal) / previousOpen;
    } else {
      raw[kind] = open.length > 0 ? openTotal / open.length : 1;
    }
  }
  return normalize(raw);
}

/** Moves the divider between `above` and `below` by `delta` pixels, keeping both at or above their floors. */
export function resizePanes(
  base: PaneSizes,
  above: Pane & { height: number },
  below: Pane & { height: number },
  delta: number,
): PaneSizes {
  const span = above.height + below.height;
  if (span <= 0) {
    return base;
  }
  const top = Math.min(Math.max(above.height + delta, above.floor), Math.max(above.floor, span - below.floor));
  const pair = base[above.kind] + base[below.kind];
  return normalize({ ...base, [above.kind]: (pair * top) / span, [below.kind]: (pair * (span - top)) / span });
}

function normalize(sizes: PaneSizes): PaneSizes {
  const total = KINDS.reduce((sum, kind) => sum + sizes[kind], 0);
  const result = {} as PaneSizes;
  for (const kind of KINDS) {
    const share = total > 0 ? sizes[kind] / total : 1 / KINDS.length;
    result[kind] = Math.max(0.0001, Math.round(share * 10000) / 10000);
  }
  return result;
}
