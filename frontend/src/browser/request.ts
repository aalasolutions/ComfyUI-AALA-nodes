import type { MediaKind } from '../state/schema';

/** How the file browser was opened: adding to groups, or picking one file to replace or relink an item. */
export type BrowserRequest =
  | { mode: 'add'; kind: MediaKind | null }
  | { mode: 'replace'; kind: MediaKind; itemId: string; startPath: string | null };
