<script setup lang="ts">
import { computed, ref } from 'vue';
import { baseName, fileUrl, type MediaMeta } from '../../api/fs';
import { describeMeta } from '../../browser/listing';
import { useKeyboardScope } from '../../composables/useKeyboardScope';
import { OUTPUT_PREFIX } from '../../state/items';
import type { MediaItem, MediaKind } from '../../state/schema';
import Icon from '../ui/Icon.vue';

const props = defineProps<{
  items: readonly Readonly<MediaItem>[];
  index: number;
  kind: MediaKind;
  outputIndexes: Map<string, number>;
  metaOf: (item: Readonly<MediaItem>) => MediaMeta | null;
}>();
const emit = defineEmits<{ close: []; step: [index: number] }>();

const item = computed(() => props.items[props.index]);
const failed = ref(false);
const caption = computed(() => {
  const current = item.value;
  if (!current) {
    return '';
  }
  const position = props.outputIndexes.get(current.id);
  const tag = position ? `${OUTPUT_PREFIX[props.kind]} ${position}` : current.active ? 'skipped' : 'off';
  return [tag, baseName(current.path), describeMeta(props.kind, props.metaOf(current))].filter(Boolean).join(' · ');
});

function step(delta: number): void {
  const count = props.items.length;
  if (count > 1) {
    failed.value = false;
    emit('step', (props.index + delta + count) % count);
  }
}

useKeyboardScope(ref(true), (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="item" class="aala-media aala-backdrop aala-lightbox" role="dialog" aria-modal="true" :aria-label="caption" @click.self="emit('close')">
      <button type="button" class="aala-icon-btn aala-lightbox__close" aria-label="Close" @click="emit('close')">
        <Icon name="close" :size="20" />
      </button>
      <button v-if="items.length > 1" type="button" class="aala-icon-btn aala-lightbox__nav aala-lightbox__nav--prev" aria-label="Previous" @click="step(-1)">
        <Icon name="back" :size="24" />
      </button>
      <figure class="aala-lightbox__figure">
        <p v-if="failed" class="aala-state">This file cannot be previewed in the browser.</p>
        <img v-else-if="kind === 'image'" :key="item.id" :src="fileUrl(item.path)" alt="" @error="failed = true" />
        <video v-else-if="kind === 'video'" :key="item.id" :src="fileUrl(item.path)" controls autoplay loop playsinline :muted="item.muted === true" @error="failed = true" />
        <audio v-else :key="item.id" :src="fileUrl(item.path)" controls autoplay @error="failed = true" />
        <figcaption class="aala-lightbox__caption">{{ caption }}</figcaption>
      </figure>
      <button v-if="items.length > 1" type="button" class="aala-icon-btn aala-lightbox__nav aala-lightbox__nav--next" aria-label="Next" @click="step(1)">
        <Icon name="forward" :size="24" />
      </button>
    </div>
  </Teleport>
</template>
