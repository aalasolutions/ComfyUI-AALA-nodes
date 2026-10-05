import type { FileEntry } from '../api/fs';

// Selection is keyed by absolute path so it survives folder changes.
export type Selection = Map<string, FileEntry>;

export function selectOnly(file: FileEntry): Selection {
  return new Map([[file.path, file]]);
}

export function toggle(selection: Selection, file: FileEntry): Selection {
  const next = new Map(selection);
  if (next.has(file.path)) {
    next.delete(file.path);
  } else {
    next.set(file.path, file);
  }
  return next;
}

/** Adds the files between two visible positions (inclusive, either order) to the selection. */
export function selectRange(selection: Selection, visible: readonly FileEntry[], from: number, to: number): Selection {
  const next = new Map(selection);
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (const file of visible.slice(Math.max(0, start), end + 1)) {
    next.set(file.path, file);
  }
  return next;
}

export function selectAll(selection: Selection, visible: readonly FileEntry[]): Selection {
  return selectRange(selection, visible, 0, visible.length - 1);
}

export function invert(selection: Selection, visible: readonly FileEntry[]): Selection {
  const next = new Map(selection);
  for (const file of visible) {
    if (next.has(file.path)) {
      next.delete(file.path);
    } else {
      next.set(file.path, file);
    }
  }
  return next;
}
