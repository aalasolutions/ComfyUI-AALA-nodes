<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fetchApi } from '../../comfy/host';
import { fileUrl, getPeaks, thumbUrl } from '../../api/fs';
import { useLazyVisible } from '../../composables/useLazyVisible';
import type { MediaKind } from '../../state/schema';
import Icon from './Icon.vue';

const DWELL_MS = 180;
const PREVIEW_DELAY_MS = 400;
const PEAK_BUCKETS = 48;

const props = defineProps<{ path: string; kind: MediaKind; mtime: number; size?: number; hoverPreview?: boolean }>();

const src = ref<string | null>(null);
const failed = ref<string | null>(null);
const peaks = ref<number[] | null>(null);
const previewing = ref(false);
const root = ref<HTMLElement | null>(null);
let started = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

// Mirrored pairs of min/max per bucket, drawn as bars in a 100 x 40 box.
const bars = computed(() => {
  const values = peaks.value;
  if (!values || values.length < 2) {
    return [];
  }
  const count = values.length / 2;
  return Array.from({ length: count }, (_, index) => {
    const amplitude = Math.min(1, Math.max(Math.abs(values[index * 2]), Math.abs(values[index * 2 + 1])));
    const height = Math.max(1.5, amplitude * 36);
    return { x: (index * 100) / count, w: (100 / count) * 0.6, y: 20 - height / 2, h: height };
  });
});

function load(): void {
  started = true;
  failed.value = null;
  if (props.kind === 'audio') {
    peaks.value = null;
    getPeaks(props.path, props.mtime, PEAK_BUCKETS).then((result) => {
      if (alive) {
        peaks.value = result?.peaks ?? [];
      }
    });
  } else {
    src.value = thumbUrl(props.path, props.mtime, props.size ?? 256);
  }
}

async function onError(): Promise<void> {
  const url = src.value;
  src.value = null;
  failed.value = 'Preview unavailable';
  if (!url) {
    return;
  }
  try {
    const body = await (await fetchApi(url.slice(url.indexOf('/aala-media/')))).json();
    if (alive && typeof body?.message === 'string') {
      failed.value = body.message;
    }
  } catch {
    // Keep the generic message.
  }
}

function onEnter(): void {
  if (props.hoverPreview && props.kind === 'video') {
    previewTimer = setTimeout(() => (previewing.value = true), PREVIEW_DELAY_MS);
  }
}

function onLeave(): void {
  clearTimeout(previewTimer);
  previewing.value = false;
}

watch(
  () => [props.path, props.mtime],
  () => started && load(),
);

useLazyVisible(root, DWELL_MS, load);

onBeforeUnmount(() => {
  alive = false;
  clearTimeout(previewTimer);
});
</script>

<template>
  <div ref="root" class="aala-thumb" :class="`aala-thumb--${kind}`" @pointerenter="onEnter" @pointerleave="onLeave">
    <img v-if="src" class="aala-thumb__media" :src="src" alt="" draggable="false" decoding="async" @error="onError" />
    <svg v-else-if="bars.length" class="aala-thumb__wave" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <rect v-for="(bar, index) in bars" :key="index" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" rx="0.5" />
    </svg>
    <Icon v-else class="aala-thumb__icon" :name="kind" :size="22" />
    <video
      v-if="previewing"
      class="aala-thumb__media"
      :src="fileUrl(path)"
      muted
      autoplay
      loop
      playsinline
    />
    <span v-if="failed" class="aala-badge aala-badge--warn aala-thumb__badge" :title="failed">unreadable</span>
  </div>
</template>
