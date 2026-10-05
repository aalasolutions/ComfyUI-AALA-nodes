<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { cachedProbe, isMeta, wantProbe, type Entry } from '../../api/fs';
import { describeMeta, formatDate, formatSize, type SortSpec } from '../../browser/listing';
import type { Selection } from '../../browser/selection';
import type { SortKey } from '../../comfy/prefs';
import { useVirtualRows } from '../../composables/useVirtualRows';
import Icon from '../ui/Icon.vue';

const ROW_HEIGHT = 30;

const props = defineProps<{
  entries: Entry[];
  focusIndex: number;
  selection: Selection;
  addedPaths: ReadonlySet<string>;
  sort: SortSpec;
  idPrefix: string;
}>();
const emit = defineEmits<{
  itemClick: [index: number, event: MouseEvent];
  itemOpen: [index: number];
  itemToggle: [index: number];
  itemContext: [index: number, event: MouseEvent];
  sortBy: [key: SortKey];
}>();

const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind' },
  { key: 'size', label: 'Size' },
  { key: null, label: 'Duration or dimensions' },
  { key: 'mtime', label: 'Modified' },
];

const scroller = ref<HTMLElement | null>(null);
const virtual = useVirtualRows(scroller, {
  count: computed(() => props.entries.length),
  rowHeight: ref(ROW_HEIGHT),
  minColumnWidth: ref(0),
});
const visible = computed(() =>
  props.entries.slice(virtual.range.value.start, virtual.range.value.end).map((entry, offset) => ({
    entry,
    index: virtual.range.value.start + offset,
  })),
);

watch(visible, (list) => list.forEach(({ entry }) => entry.type === 'file' && wantProbe(entry.path, entry.mtime)), {
  immediate: true,
});
watch(toRef(props, 'focusIndex'), (index) => index >= 0 && virtual.reveal(index));

function info(entry: Entry): string {
  if (entry.type !== 'file') {
    return '';
  }
  const result = cachedProbe(entry.path, entry.mtime) ?? undefined;
  return isMeta(result) ? describeMeta(entry.kind, result) : '';
}

function sortMark(key: SortKey | null): string {
  return key && props.sort.key === key ? (props.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
}
</script>

<template>
  <div class="aala-files aala-files--list">
    <div class="aala-row aala-row--head" role="row">
      <span class="aala-row__check" />
      <template v-for="column in COLUMNS" :key="column.label">
        <button
          v-if="column.key"
          type="button"
          class="aala-row__head"
          :class="`aala-row__cell--${column.key}`"
          @click="emit('sortBy', column.key)"
        >
          {{ column.label }}{{ sortMark(column.key) }}
        </button>
        <span v-else class="aala-row__head aala-row__cell--info">{{ column.label }}</span>
      </template>
    </div>
    <div ref="scroller" class="aala-files__scroll">
      <div :style="{ paddingTop: `${virtual.padTop.value}px`, paddingBottom: `${virtual.padBottom.value}px` }">
        <div
          v-for="{ entry, index } in visible"
          :id="`${idPrefix}-${index}`"
          :key="entry.path"
          class="aala-row"
          :class="{
            'aala-row--focus': index === focusIndex,
            'aala-row--selected': selection.has(entry.path),
          }"
          :style="{ height: `${ROW_HEIGHT}px` }"
          role="row"
          :aria-selected="entry.type === 'file' ? selection.has(entry.path) : undefined"
          @click="emit('itemClick', index, $event)"
          @dblclick="emit('itemOpen', index)"
          @contextmenu.prevent="emit('itemContext', index, $event)"
        >
          <label v-if="entry.type === 'file'" class="aala-row__check aala-check" @click.stop @dblclick.stop>
            <input
              type="checkbox"
              :checked="selection.has(entry.path)"
              :aria-label="`Select ${entry.name}`"
              tabindex="-1"
              @change="emit('itemToggle', index)"
            />
          </label>
          <span v-else class="aala-row__check" />
          <span class="aala-row__cell--name" :title="entry.name">
            <Icon :name="entry.type === 'dir' ? 'folder' : entry.kind" :size="14" />
            <span class="aala-ellipsis">{{ entry.name }}</span>
            <span v-if="entry.type === 'file' && addedPaths.has(entry.path)" class="aala-badge">added</span>
          </span>
          <span class="aala-row__cell--kind">{{ entry.type === 'dir' ? 'Folder' : entry.kind }}</span>
          <span class="aala-row__cell--size">{{ entry.type === 'file' ? formatSize(entry.size) : '' }}</span>
          <span class="aala-row__cell--info">{{ info(entry) }}</span>
          <span class="aala-row__cell--mtime">{{ formatDate(entry.mtime) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
