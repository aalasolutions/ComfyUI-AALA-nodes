import { reactive, readonly } from 'vue';
import type { MediaMeta } from '../api/fs';
import * as items from './items';
import { defaultState, parseState, serializeState, type MediaKind, type MediaState } from './schema';

export type StatusTone = 'info' | 'warning' | 'error';

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface StoreData {
  state: MediaState;
  readOnlyRaw: string | null;
  status: StatusMessage | null;
}

export function createMediaStore(onCommit: () => void) {
  const data = reactive<StoreData>({ state: defaultState(), readOnlyRaw: null, status: null });
  let committing = false;

  function serialize(): string {
    return data.readOnlyRaw ?? serializeState(data.state);
  }

  function replace(raw: string): void {
    if (committing || typeof raw !== 'string' || raw.trim() === '') {
      return;
    }
    const result = parseState(raw);
    if (result.ok) {
      data.state = result.state;
      data.readOnlyRaw = null;
      data.status = null;
    } else {
      data.readOnlyRaw = raw;
      data.status = { tone: 'error', text: result.error };
    }
  }

  function commit<T>(mutate: (state: MediaState) => T): T | undefined {
    if (data.readOnlyRaw !== null || committing) {
      return undefined;
    }
    committing = true;
    try {
      // A mutation that changed nothing (blocked activation, move to the same index) records no undo step.
      const before = serializeState(data.state);
      const result = mutate(data.state);
      if (serializeState(data.state) !== before) {
        onCommit();
      }
      return result;
    } finally {
      committing = false;
    }
  }

  /** Returns how many items were deactivated because the new limit is lower than the active count. */
  function setLimit(kind: MediaKind, value: number): number {
    const limit = Math.max(1, Math.floor(value));
    return commit((state) => items.applyLimit(state, kind, limit)) ?? 0;
  }

  const actions = {
    addItems: (files: items.NewFile[]) => commit((state) => items.addItems(state, files)),
    setActive: (kind: MediaKind, ids: Set<string>, active: boolean) =>
      commit((state) => items.setActive(state, kind, ids, active)),
    setMuted: (kind: MediaKind, ids: Set<string>, muted: boolean) =>
      commit((state) => items.setMuted(state, kind, ids, muted)),
    removeItems: (kind: MediaKind, ids: Set<string>) => commit((state) => items.removeItems(state, kind, ids)),
    moveItem: (kind: MediaKind, id: string, to: number) => commit((state) => items.moveItem(state, kind, id, to)),
    duplicateItem: (kind: MediaKind, id: string) => commit((state) => items.duplicateItem(state, kind, id)),
    replacePath: (kind: MediaKind, id: string, path: string, meta: MediaMeta | null) =>
      commit((state) => items.replacePath(state, kind, id, path, meta)),
    setEdit: (kind: MediaKind, id: string, edit: Record<string, unknown>) =>
      commit((state) => items.setEdit(state, kind, id, edit)),
    setCollapsed: (kind: MediaKind, collapsed: boolean) =>
      commit((state) => {
        state.ui.collapsed = { ...state.ui.collapsed, [kind]: collapsed };
      }),
    setLayout: (layout: MediaState['ui']['layout']) =>
      commit((state) => {
        state.ui.layout = layout;
      }),
  };

  function setStatus(status: StatusMessage | null): void {
    data.status = status;
  }

  return { data: readonly(data), serialize, replace, setLimit, setStatus, ...actions };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
