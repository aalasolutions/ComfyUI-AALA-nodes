<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { cachedProbe, isMeta, wantProbe, type Entry } from '../../api/fs';
import { describeMeta } from '../../browser/listing';
import type { Selection } from '../../browser/selection';
import type { ThumbSize } from '../../comfy/prefs';
import { useVirtualRows } from '../../composables/useVirtualRows';
import Icon from '../ui/Icon.vue';
import Thumb from '../ui/Thumb.vue';

const TILE_WIDTH: Record<ThumbSize, number> = { s: 104, m: 148, l: 216 };
const THUMB_PX: Record<ThumbSize, number> = { s: 128, m: 256, l: 512 };
const LABEL_HEIGHT = 40;

const props = defineProps<{
  entries: Entry[];
  focusIndex: number;
  selection: Selection;
  addedPaths: ReadonlySet<string>;
  thumbSize: ThumbSize;
  idPrefix: string;
}>();
const emit = defineEmits<{
  itemClick: [index: number, event: MouseEvent];
  itemOpen: [index: number];
  itemToggle: [index: number];
  itemContext: [index: number, event: MouseEvent];
}>();

const scroller = ref<HTMLElement | null>(null);
const tileWidth = computed(() => TILE_WIDTH[props.thumbSize]);
const rowHeight = computed(() => tileWidth.value + LABEL_HEIGHT);
const virtual = useVirtualRows(scroller, {
  count: computed(() => props.entries.length),
  rowHeight,
  minColumnWidth: tileWidth,
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

defineExpose({ columns: virtual.columns });
</script>

<template>
  <div ref="scroller" class="aala-files aala-files--grid">
    <div
      class="aala-grid"
      :style="{
        gridTemplateColumns: `repeat(${virtual.columns.value}, minmax(0, 1fr))`,
        gridAutoRows: `${rowHeight}px`,
        paddingTop: `${virtual.padTop.value}px`,
        paddingBottom: `${virtual.padBottom.value}px`,
      }"
    >
      <div
        v-for="{ entry, index } in visible"
        :id="`${idPrefix}-${index}`"
        :key="entry.path"
        class="aala-tile"
        :class="{
          'aala-tile--focus': index === focusIndex,
          'aala-tile--selected': selection.has(entry.path),
          'aala-tile--dir': entry.type === 'dir',
        }"
        role="gridcell"
        :aria-selected="entry.type === 'file' ? selection.has(entry.path) : undefined"
        :title="entry.name"
        @click="emit('itemClick', index, $event)"
        @dblclick="emit('itemOpen', index)"
        @contextmenu.prevent="emit('itemContext', index, $event)"
      >
        <div class="aala-tile__preview">
          <Icon v-if="entry.type === 'dir'" class="aala-tile__folder" name="folder" :size="Math.round(tileWidth * 0.42)" />
          <Thumb v-else :path="entry.path" :kind="entry.kind" :mtime="entry.mtime" :size="THUMB_PX[thumbSize]" hover-preview />
          <label v-if="entry.type === 'file'" class="aala-check" @click.stop @dblclick.stop>
            <input
              type="checkbox"
              :checked="selection.has(entry.path)"
              :aria-label="`Select ${entry.name}`"
              tabindex="-1"
              @change="emit('itemToggle', index)"
            />
          </label>
          <span v-if="entry.type === 'file' && addedPaths.has(entry.path)" class="aala-badge aala-tile__added">added</span>
        </div>
        <span class="aala-tile__name aala-ellipsis">{{ entry.name }}</span>
        <span class="aala-tile__info aala-ellipsis">{{ info(entry) }}</span>
      </div>
    </div>
  </div>
</template>
