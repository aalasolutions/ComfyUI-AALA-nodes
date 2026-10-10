<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fetchApi } from '../../comfy/host';
import { fileUrl, getPeaks, thumbUrl } from '../../api/fs';
import { useLazyVisible } from '../../composables/useLazyVisible';
import type { Rect } from '../../state/edit';
import type { MediaKind } from '../../state/schema';
import Icon from './Icon.vue';

const DWELL_MS = 180;
const PREVIEW_DELAY_MS = 400;
const PEAK_BUCKETS = 48;

const props = defineProps<{
  path: string;
  kind: MediaKind;
  mtime: number;
  size?: number;
  hoverPreview?: boolean;
  crop?: Rect | null;
  rotate?: number;
  mirror?: boolean;
  range?: [number, number] | null;
}>();

const src = ref<string | null>(null);
const failed = ref<string | null>(null);
const peaks = ref<number[] | null>(null);
const previewing = ref(false);
const root = ref<HTMLElement | null>(null);
const natural = ref<{ w: number; h: number } | null>(null);
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
    const at = (index + 0.5) / count;
    const cut = !!props.range && (at < props.range[0] || at > props.range[1]);
    return { x: (index * 100) / count, w: (100 / count) * 0.6, y: 20 - height / 2, h: height, cut };
  });
});

const edited = computed(() => {
  const size = natural.value;
  const rotate = props.rotate ?? 0;
  if (!size || (!props.crop && !rotate && !props.mirror)) {
    return null;
  }
  const { w, h } = size;
  const turned = rotate % 180 !== 0;
  const fw = turned ? h : w;
  const fh = turned ? w : h;
  const place = { 0: '', 90: `translate(${h} 0) rotate(90)`, 180: `translate(${w} ${h}) rotate(180)`, 270: `translate(0 ${w}) rotate(270)` }[rotate] ?? '';
  const crop = props.crop;
  const rect = crop ? { x: crop.x * fw, y: crop.y * fh, w: crop.w * fw, h: crop.h * fh } : null;
  return {
    fw,
    fh,
    w,
    h,
    transform: `${props.mirror ? `translate(${fw} 0) scale(-1 1) ` : ''}${place}`,
    rect,
    dim: rect ? `M0 0H${fw}V${fh}H0Z M${rect.x} ${rect.y}h${rect.w}v${rect.h}h${-rect.w}Z` : '',
  };
});

function onLoad(event: Event): void {
  const image = event.target as HTMLImageElement;
  natural.value = { w: image.naturalWidth, h: image.naturalHeight };
}

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
    <img
      v-if="src"
      class="aala-thumb__media"
      :class="{ 'aala-thumb__media--hidden': edited }"
      :src="src"
      alt=""
      draggable="false"
      decoding="async"
      @load="onLoad"
      @error="onError"
    />
    <svg v-if="src && edited" class="aala-thumb__media" :viewBox="`0 0 ${edited.fw} ${edited.fh}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g :transform="edited.transform">
        <image :href="src" :width="edited.w" :height="edited.h" preserveAspectRatio="none" />
      </g>
      <template v-if="edited.rect">
        <path class="aala-thumb__dim" :d="edited.dim" fill-rule="evenodd" />
        <rect class="aala-thumb__crop" :x="edited.rect.x" :y="edited.rect.y" :width="edited.rect.w" :height="edited.rect.h" />
      </template>
    </svg>
    <svg v-else-if="bars.length" class="aala-thumb__wave" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <rect
        v-for="(bar, index) in bars"
        :key="index"
        :x="bar.x"
        :y="bar.y"
        :width="bar.w"
        :height="bar.h"
        rx="0.5"
        :class="{ 'aala-thumb__bar--cut': bar.cut }"
      />
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
