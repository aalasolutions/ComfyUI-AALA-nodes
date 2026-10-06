<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { MediaMeta } from '../../api/fs';
import { usePointerSort } from '../../composables/usePointerSort';
import { isMod } from '../../composables/useKeyboardScope';
import { useVirtualRows } from '../../composables/useVirtualRows';
import { en, KIND_LABEL } from '../../i18n/en';
import { hasRoom, outputIndexes, skipReason } from '../../state/items';
import type { MediaItem, MediaKind, MediaState } from '../../state/schema';
import type { MediaStore, StatusMessage } from '../../state/store';
import Icon from '../ui/Icon.vue';
import Menu, { type MenuItem } from '../ui/Menu.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ItemCard from './ItemCard.vue';

export interface GroupNotice extends StatusMessage {
  confirm?: { label: string; action: () => void };
}

const props = defineProps<{
  store: MediaStore;
  kind: MediaKind;
  notice: GroupNotice | null;
  metaOf: (item: Readonly<MediaItem>) => MediaMeta | null;
  missingText: (item: Readonly<MediaItem>) => string | null;
}>();
const emit = defineEmits<{
  add: [];
  replace: [item: Readonly<MediaItem>];
  relink: [item: Readonly<MediaItem>];
  preview: [index: number];
  notify: [notice: GroupNotice | null];
}>();

const state = computed(() => props.store.data.state as Readonly<MediaState>);
const items = computed(() => state.value.groups[props.kind]);
const limit = computed(() => state.value.limits[props.kind]);
const layout = computed(() => state.value.ui.layout);
const collapsed = computed(() => state.value.ui.collapsed?.[props.kind] === true);
const isMissing = (item: Readonly<MediaItem>) => props.missingText(item) !== null;
const indexes = computed(() => outputIndexes(items.value, isMissing));
const activeCount = computed(() => items.value.filter((item) => item.active).length);
const label = KIND_LABEL[props.kind];

const selected = ref(new Set<string>());
const anchor = ref<string | null>(null);
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
const list = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

// Fixed card sizes (see .aala-card--list and .aala-card--grid) so the capped list can be virtualized.
const LIST_ROW = 50;
const LIST_GAP = 4;
const GRID_ROW = 132;
const GRID_GAP = 6;
const GRID_MIN_WIDTH = 116;

const virtual = useVirtualRows(scroller, {
  count: computed(() => items.value.length),
  rowHeight: computed(() => (layout.value === 'grid' ? GRID_ROW + GRID_GAP : LIST_ROW + LIST_GAP)),
  minColumnWidth: computed(() => (layout.value === 'grid' ? GRID_MIN_WIDTH + GRID_GAP : 0)),
});
const visibleItems = computed(() =>
  items.value.slice(virtual.range.value.start, virtual.range.value.end).map((item, offset) => ({
    item,
    index: virtual.range.value.start + offset,
  })),
);
const listStyle = computed(() => ({
  paddingTop: `${virtual.padTop.value}px`,
  paddingBottom: `${virtual.padBottom.value}px`,
  ...(layout.value === 'grid'
    ? { gridTemplateColumns: `repeat(${virtual.columns.value}, minmax(0, 1fr))`, gridAutoRows: `${GRID_ROW}px` }
    : {}),
}));

const sorter = usePointerSort(
  list,
  computed(() => (layout.value === 'grid' ? 'x' : 'y')),
  (id, insertAt) => {
    const from = items.value.findIndex((item) => item.id === id);
    const to = insertAt > from ? insertAt - 1 : insertAt;
    if (from >= 0 && to !== from) {
      props.store.moveItem(props.kind, id, to);
    }
  },
);

// Drop selection entries whose items are gone (removed, undo, workflow load).
watch(items, (current) => {
  const ids = new Set(current.map((item) => item.id));
  const kept = new Set([...selected.value].filter((id) => ids.has(id)));
  if (kept.size !== selected.value.size) {
    selected.value = kept;
  }
});

function notify(tone: GroupNotice['tone'], text: string, confirm?: GroupNotice['confirm']): void {
  emit('notify', { tone, text, confirm });
}

function dropFor(index: number): 'before' | 'after' | null {
  const drop = sorter.dropIndex.value;
  if (drop === null || sorter.draggingId.value === null) {
    return null;
  }
  if (drop === index) {
    return 'before';
  }
  return drop === items.value.length && index === items.value.length - 1 ? 'after' : null;
}

function toggleActive(item: Readonly<MediaItem>): void {
  if (!item.active && !hasRoom(state.value as MediaState, props.kind)) {
    notify('warning', en.limitFull(limit.value));
    return;
  }
  props.store.setActive(props.kind, new Set([item.id]), !item.active);
  emit('notify', null);
}

function toggleMute(item: Readonly<MediaItem>): void {
  props.store.setMuted(props.kind, new Set([item.id]), item.muted !== true);
}

function select(item: Readonly<MediaItem>, event: MouseEvent): void {
  if (event.shiftKey && anchor.value) {
    const ids = items.value.map((entry) => entry.id);
    const from = ids.indexOf(anchor.value);
    const to = ids.indexOf(item.id);
    if (from >= 0 && to >= 0) {
      const next = new Set(selected.value);
      ids.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((id) => next.add(id));
      selected.value = next;
      return;
    }
  }
  if (isMod(event)) {
    const next = new Set(selected.value);
    if (next.has(item.id)) {
      next.delete(item.id);
    } else {
      next.add(item.id);
    }
    selected.value = next;
    anchor.value = item.id;
    return;
  }
  selected.value = new Set();
  anchor.value = item.id;
}

function bulkActive(active: boolean): void {
  const result = props.store.setActive(props.kind, new Set(selected.value), active);
  if (active && result && result.blocked > 0) {
    notify('warning', en.activatedPartly(result.changed, result.blocked, limit.value));
  } else {
    emit('notify', null);
  }
}

function bulkMute(muted: boolean): void {
  props.store.setMuted(props.kind, new Set(selected.value), muted);
}

function bulkRemove(): void {
  props.store.removeItems(props.kind, new Set(selected.value));
  selected.value = new Set();
}

function confirmRemoveAll(): void {
  notify('warning', en.removeAllConfirm(items.value.length, label), {
    label: 'Remove all',
    action: () => {
      props.store.removeItems(props.kind, new Set(items.value.map((item) => item.id)));
      emit('notify', null);
    },
  });
}

async function copyPath(path: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(path);
    } else {
      // The async clipboard API needs a secure context; a remote server over plain http does not provide one.
      const area = document.createElement('textarea');
      area.value = path;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) {
        throw new Error('copy failed');
      }
    }
    notify('info', en.pathCopied);
  } catch {
    notify('error', en.copyFailed);
  }
}

async function moveBy(item: Readonly<MediaItem>, delta: number): Promise<void> {
  const index = items.value.findIndex((entry) => entry.id === item.id);
  props.store.moveItem(props.kind, item.id, index + delta);
  const moved = items.value.findIndex((entry) => entry.id === item.id);
  virtual.reveal(moved);
  await nextTick();
  list.value?.querySelector<HTMLElement>(`[data-sort-id="${item.id}"]`)?.focus({ preventScroll: true });
}

function duplicate(item: Readonly<MediaItem>): void {
  const copy = props.store.duplicateItem(props.kind, item.id);
  if (copy && item.active && !copy.active) {
    notify('warning', en.addedInactive(1, limit.value));
  }
}

function openOptions(item: Readonly<MediaItem>, event: MouseEvent): void {
  const index = items.value.findIndex((entry) => entry.id === item.id);
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    items: [
      ...(isMissing(item) ? [{ label: 'Relink…', action: () => emit('relink', item) }] : []),
      { label: 'Duplicate', action: () => duplicate(item) },
      { label: 'Replace file…', action: () => emit('replace', item) },
      { label: 'Copy path', action: () => copyPath(item.path) },
      { label: 'Move to top', action: () => props.store.moveItem(props.kind, item.id, 0), disabled: index === 0 },
      {
        label: 'Move to bottom',
        action: () => props.store.moveItem(props.kind, item.id, items.value.length - 1),
        disabled: index === items.value.length - 1,
      },
      { label: 'Remove', action: () => props.store.removeItems(props.kind, new Set([item.id])), danger: true },
    ],
  };
}

function openGroupMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = {
    x: rect.left,
    y: rect.bottom + 2,
    items: [
      { label: 'Select all', action: () => (selected.value = new Set(items.value.map((item) => item.id))), disabled: items.value.length === 0 },
      { label: 'Remove all…', action: confirmRemoveAll, disabled: items.value.length === 0, danger: true },
    ],
  };
}

function onLimitChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (input.value.trim() !== '' && Number.isFinite(value) && value >= 0) {
    const deactivated = props.store.setLimit(props.kind, value);
    emit('notify', deactivated > 0 ? { tone: 'info', text: en.deactivated(deactivated) } : null);
  }
  input.value = String(limit.value);
}
</script>

<template>
  <section class="aala-group" :class="{ 'aala-group--collapsed': collapsed }" :aria-label="label">
    <header class="aala-group__header">
      <button
        type="button"
        class="aala-icon-btn aala-group__toggle"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? `Expand ${label}` : `Collapse ${label}`"
        @click="store.setCollapsed(kind, !collapsed)"
      >
        <Icon name="chevron" :size="14" />
      </button>
      <span class="aala-group__title">{{ label }}</span>
      <span
        class="aala-group__count"
        :class="{ 'aala-group__count--full': activeCount >= limit && items.length > activeCount }"
        :title="`${activeCount} of ${limit} active, ${items.length} total`"
      >
        {{ activeCount }}/{{ limit }}<span class="aala-group__count-word"> active</span
        ><span v-if="items.length > activeCount" class="aala-group__total"> · {{ items.length }} total</span>
      </span>
      <label class="aala-group__limit" title="Max active">
        <span>Max</span>
        <input type="number" min="0" step="1" :value="limit" @change="onLimitChange" @keydown.enter="($event.target as HTMLInputElement).blur()" />
      </label>
      <button type="button" class="aala-btn aala-btn--small" :title="`Add ${label.toLowerCase()}`" @click="emit('add')">
        <Icon name="plus" :size="12" /><span class="aala-group__add-label">Add</span>
      </button>
      <button type="button" class="aala-icon-btn" :aria-label="`${label} options`" title="More" @click="openGroupMenu">
        <Icon name="more" :size="14" />
      </button>
    </header>

    <StatusBanner v-if="notice" :tone="notice.tone" :text="notice.text" dismissible @dismiss="emit('notify', null)">
      <button v-if="notice.confirm" type="button" class="aala-btn aala-btn--small aala-btn--danger" @click="notice.confirm.action()">
        {{ notice.confirm.label }}
      </button>
    </StatusBanner>

    <template v-if="!collapsed">
      <div v-if="selected.size > 0" class="aala-bulk" role="toolbar" :aria-label="`${label} bulk actions`">
        <span>{{ en.selected(selected.size) }}</span>
        <button type="button" class="aala-btn aala-btn--small" @click="bulkActive(true)">Activate</button>
        <button type="button" class="aala-btn aala-btn--small" @click="bulkActive(false)">Deactivate</button>
        <template v-if="kind !== 'image'">
          <button type="button" class="aala-btn aala-btn--small" @click="bulkMute(true)">Mute</button>
          <button type="button" class="aala-btn aala-btn--small" @click="bulkMute(false)">Unmute</button>
        </template>
        <button type="button" class="aala-btn aala-btn--small aala-btn--danger" @click="bulkRemove">Remove</button>
        <button type="button" class="aala-btn aala-btn--small aala-btn--ghost" @click="selected = new Set()">Clear</button>
      </div>

      <div
        v-if="items.length"
        ref="scroller"
        class="aala-items-scroll"
      >
        <div ref="list" class="aala-items" :class="`aala-items--${layout}`" :style="listStyle">
          <ItemCard
            v-for="{ item, index } in visibleItems"
            :key="item.id"
            :data-sort-index="index"
            :item="item"
            :kind="kind"
            :meta="metaOf(item)"
            :output-index="indexes.get(item.id)"
            :selected="selected.has(item.id)"
            :missing="missingText(item)"
            :skip="item.active && !indexes.has(item.id) ? skipReason(item, isMissing(item)) : null"
            :layout="layout"
            :dragging="sorter.draggingId.value === item.id"
            :drop="dropFor(index)"
            @toggle-active="toggleActive(item)"
            @toggle-mute="toggleMute(item)"
            @options="openOptions(item, $event)"
            @preview="emit('preview', index)"
            @select="select(item, $event)"
            @relink="emit('relink', item)"
            @drag-start="sorter.start($event, item.id)"
            @move="moveBy(item, $event)"
          />
        </div>
      </div>
      <button type="button" class="aala-add-tile" @click="emit('add')">
        <Icon name="plus" :size="14" />
        {{ items.length === 0 ? en.noItems(label) + ' Add media' : 'Add media' }}
      </button>
    </template>
    <Menu v-if="menu" :items="menu.items" :x="menu.x" :y="menu.y" @close="menu = null" />
  </section>
</template>
