<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { baseName, fileUrl, getPeaks, type MediaMeta } from '../../api/fs';
import { describeMeta } from '../../browser/listing';
import { isTextInput, useKeyboardScope } from '../../composables/useKeyboardScope';
import {
  centeredRect,
  draftFromItem,
  editFromDraft,
  mirrorRect,
  parseFps,
  rotateRectCcw,
  rotateRectCw,
  type Draft,
  type Rect,
} from '../../state/edit';
import { OUTPUT_PREFIX } from '../../state/items';
import type { MediaItem, MediaKind } from '../../state/schema';
import Icon from '../ui/Icon.vue';
import CropStage from './CropStage.vue';
import TrimBar from './TrimBar.vue';

const PEAK_BUCKETS = 400;
const RATIOS: { key: string; label: string; value: number | null }[] = [
  { key: 'free', label: 'Free', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
  { key: '9:16', label: '9:16', value: 9 / 16 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '3:4', label: '3:4', value: 3 / 4 },
];

const props = defineProps<{
  items: readonly Readonly<MediaItem>[];
  index: number;
  kind: MediaKind;
  outputIndexes: Map<string, number>;
  metaOf: (item: Readonly<MediaItem>) => MediaMeta | null;
}>();
const emit = defineEmits<{ close: []; step: [index: number]; apply: [id: string, edit: Record<string, unknown>] }>();

const item = computed(() => props.items[props.index]);
const meta = computed(() => (item.value ? props.metaOf(item.value) : null));
const failed = ref(false);
const draft = reactive<Draft>({ rotate: 0, mirror: false, crop: null, trim: null });
const ratioKey = ref('free');
const frame = reactive({ w: 0, h: 0 });
const duration = ref(0);
const current = ref(0);
const playing = ref(false);
const peaks = ref<number[] | null>(null);
const media = ref<HTMLVideoElement | HTMLAudioElement | null>(null);
let raf = 0;

const caption = computed(() => {
  const current = item.value;
  if (!current) {
    return '';
  }
  const position = props.outputIndexes.get(current.id);
  const tag = position !== undefined ? `${OUTPUT_PREFIX[props.kind]} ${position}` : current.active ? 'skipped' : 'off';
  return [tag, baseName(current.path), describeMeta(props.kind, meta.value)].filter(Boolean).join(' · ');
});

const fps = computed(() => parseFps(meta.value?.fps));
const canTrim = computed(() => props.kind === 'audio' || (props.kind === 'video' && fps.value !== null));
const trimStart = computed(() => draft.trim?.start ?? 0);
const trimEnd = computed(() => draft.trim?.end ?? duration.value);
const ratio = computed(() => RATIOS.find((entry) => entry.key === ratioKey.value)?.value ?? null);
const oriented = computed(() => (draft.rotate % 180 ? { w: frame.h, h: frame.w } : { w: frame.w, h: frame.h }));

const saved = computed(() => (item.value ? JSON.stringify(editFromDraft(props.kind, draftFromItem(item.value, meta.value), meta.value, duration.value)) : ''));
const dirty = computed(() => JSON.stringify(editFromDraft(props.kind, draft, meta.value, duration.value)) !== saved.value);

// Core aligns video crops to even pixels.
const sizeLabel = computed(() => {
  const { w, h } = oriented.value;
  if (!w || !h) {
    return '';
  }
  const rect = draft.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  let cw = Math.round(rect.w * w);
  let ch = Math.round(rect.h * h);
  if (props.kind === 'video') {
    cw -= cw % 2;
    ch -= ch % 2;
  }
  return draft.crop ? `${cw} x ${ch} of ${w} x ${h}` : `${w} x ${h}`;
});

function reset(): void {
  const current = item.value;
  Object.assign(draft, current ? draftFromItem(current, meta.value) : { rotate: 0, mirror: false, crop: null, trim: null });
  ratioKey.value = 'free';
}

function stopPlayback(): void {
  cancelAnimationFrame(raf);
  media.value?.pause();
  playing.value = false;
}

watch(
  () => item.value?.id,
  () => {
    stopPlayback();
    failed.value = false;
    frame.w = 0;
    frame.h = 0;
    duration.value = meta.value?.duration ?? 0;
    current.value = 0;
    peaks.value = null;
    reset();
    if (props.kind === 'audio' && item.value) {
      const path = item.value.path;
      getPeaks(path, meta.value?.mtime ?? 0, PEAK_BUCKETS).then((result) => {
        if (item.value?.path === path) {
          peaks.value = result?.peaks ?? null;
        }
      });
    }
  },
  { immediate: true },
);

function onImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement;
  frame.w = image.naturalWidth;
  frame.h = image.naturalHeight;
}

function onMediaMeta(event: Event): void {
  const element = event.target as HTMLVideoElement | HTMLAudioElement;
  if (Number.isFinite(element.duration) && element.duration > 0) {
    duration.value = element.duration;
  }
  if (element instanceof HTMLVideoElement) {
    frame.w = element.videoWidth;
    frame.h = element.videoHeight;
  }
  if (draft.trim) {
    element.currentTime = draft.trim.start;
    current.value = draft.trim.start;
  }
}

function tick(): void {
  const element = media.value;
  if (!element) {
    return;
  }
  if (element.ended) {
    element.currentTime = trimStart.value;
    void element.play();
  } else if (element.paused) {
    playing.value = false;
    return;
  }
  if (element.currentTime >= trimEnd.value || element.currentTime < trimStart.value - 0.05) {
    element.currentTime = trimStart.value;
  }
  current.value = element.currentTime;
  raf = requestAnimationFrame(tick);
}

async function togglePlay(): Promise<void> {
  const element = media.value;
  if (!element) {
    return;
  }
  if (!element.paused) {
    stopPlayback();
    return;
  }
  if (element.currentTime < trimStart.value || element.currentTime >= trimEnd.value - 0.05) {
    element.currentTime = trimStart.value;
  }
  try {
    await element.play();
    playing.value = true;
    raf = requestAnimationFrame(tick);
  } catch {
    playing.value = false;
  }
}

function seek(seconds: number): void {
  if (media.value) {
    media.value.currentTime = seconds;
  }
  current.value = seconds;
}

function setRange(start: number, end: number): void {
  const rate = props.kind === 'video' ? fps.value : null;
  draft.trim = rate ? { start: Math.round(start * rate) / rate, end: Math.round(end * rate) / rate } : { start, end };
}

function setCrop(rect: Rect | null): void {
  draft.crop = rect;
}

function chooseRatio(key: string): void {
  ratioKey.value = key;
  const value = RATIOS.find((entry) => entry.key === key)?.value;
  if (value && oriented.value.w) {
    draft.crop = centeredRect(value, oriented.value.w, oriented.value.h);
  }
}

function turn(clockwise: boolean): void {
  // Shown as mirror(rotate(source)), so a mirror reverses the stored step.
  const step = clockwise !== draft.mirror ? 90 : 270;
  draft.rotate = ((draft.rotate + step) % 360) as Draft['rotate'];
  if (draft.crop) {
    draft.crop = clockwise ? rotateRectCw(draft.crop) : rotateRectCcw(draft.crop);
  }
  ratioKey.value = 'free';
}

function flip(): void {
  draft.mirror = !draft.mirror;
  if (draft.crop) {
    draft.crop = mirrorRect(draft.crop);
  }
}

function clearAll(): void {
  Object.assign(draft, { rotate: 0, mirror: false, crop: null, trim: null });
  ratioKey.value = 'free';
}

function apply(): void {
  const current = item.value;
  if (!current) {
    return;
  }
  const edit = editFromDraft(props.kind, draft, meta.value, duration.value);
  const stored = (current.edit as Record<string, unknown> | undefined)?.trim;
  if (props.kind === 'video' && !fps.value && stored) {
    edit.trim = stored;
  }
  emit('apply', current.id, edit);
  emit('close');
}

function step(delta: number): void {
  const count = props.items.length;
  if (count > 1) {
    emit('step', (props.index + delta + count) % count);
  }
}

useKeyboardScope(ref(true), (event) => {
  if (isTextInput(event.target)) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  } else if (event.key === ' ' && props.kind !== 'image') {
    event.preventDefault();
    void togglePlay();
  }
});

onBeforeUnmount(stopPlayback);
</script>

<template>
  <Teleport to="body">
    <div v-if="item" class="aala-media aala-backdrop aala-lightbox aala-editor" role="dialog" aria-modal="true" :aria-label="caption">
      <header class="aala-editor__head">
        <span class="aala-lightbox__caption aala-ellipsis">{{ caption }}</span>
        <span class="aala-spacer" />
        <button type="button" class="aala-icon-btn" aria-label="Close" title="Close (Esc)" @click="emit('close')">
          <Icon name="close" :size="20" />
        </button>
      </header>

      <div class="aala-editor__main">
        <button v-if="items.length > 1" type="button" class="aala-icon-btn aala-editor__nav" aria-label="Previous" @click="step(-1)">
          <Icon name="back" :size="24" />
        </button>
        <p v-if="failed" class="aala-state aala-editor__stage">This file cannot be previewed in the browser.</p>
        <CropStage
          v-else-if="kind !== 'audio'"
          class="aala-editor__stage"
          :frame-width="frame.w"
          :frame-height="frame.h"
          :rotate="draft.rotate"
          :mirror="draft.mirror"
          :crop="draft.crop"
          :ratio="ratio"
          @crop="setCrop"
        >
          <img v-if="kind === 'image'" :key="item.id" :src="fileUrl(item.path)" alt="" draggable="false" @load="onImageLoad" @error="failed = true" />
          <video
            v-else
            ref="media"
            :key="item.id"
            :src="fileUrl(item.path)"
            preload="auto"
            playsinline
            :muted="item.muted === true"
            @loadedmetadata="onMediaMeta"
            @error="failed = true"
          />
        </CropStage>
        <div v-else class="aala-editor__stage aala-editor__audio">
          <Icon name="audio" :size="48" />
          <audio ref="media" :key="item.id" :src="fileUrl(item.path)" preload="auto" @loadedmetadata="onMediaMeta" @error="failed = true" />
        </div>
        <button v-if="items.length > 1" type="button" class="aala-icon-btn aala-editor__nav" aria-label="Next" @click="step(1)">
          <Icon name="forward" :size="24" />
        </button>
      </div>

      <div v-if="kind !== 'audio' && !failed" class="aala-editor__tools">
        <div class="aala-segmented" role="group" aria-label="Crop aspect">
          <button
            v-for="entry in RATIOS"
            :key="entry.key"
            type="button"
            class="aala-icon-btn aala-icon-btn--text"
            :class="{ 'aala-icon-btn--on': ratioKey === entry.key }"
            :aria-pressed="ratioKey === entry.key"
            @click="chooseRatio(entry.key)"
          >
            {{ entry.label }}
          </button>
        </div>
        <button type="button" class="aala-icon-btn" title="Rotate left" aria-label="Rotate left" @click="turn(false)">
          <Icon name="rotate-ccw" :size="16" />
        </button>
        <button type="button" class="aala-icon-btn" title="Rotate right" aria-label="Rotate right" @click="turn(true)">
          <Icon name="rotate-cw" :size="16" />
        </button>
        <button
          type="button"
          class="aala-icon-btn"
          :class="{ 'aala-icon-btn--on': draft.mirror }"
          :aria-pressed="draft.mirror"
          title="Mirror"
          aria-label="Mirror"
          @click="flip"
        >
          <Icon name="mirror" :size="16" />
        </button>
        <span class="aala-editor__size">{{ sizeLabel }}</span>
      </div>

      <div v-if="kind !== 'image' && !failed" class="aala-editor__timeline">
        <TrimBar
          v-if="canTrim && duration > 0"
          :duration="duration"
          :start="trimStart"
          :end="trimEnd"
          :current="current"
          :min-gap="kind === 'video' && fps ? 1 / fps : 0.05"
          :peaks="peaks"
          @range="setRange"
          @seek="seek"
        >
          <button type="button" class="aala-icon-btn" :aria-label="playing ? 'Pause' : 'Play'" :title="playing ? 'Pause (Space)' : 'Play (Space)'" @click="togglePlay">
            <Icon :name="playing ? 'pause' : 'play'" :size="18" />
          </button>
        </TrimBar>
        <button v-if="!(canTrim && duration > 0)" type="button" class="aala-icon-btn" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
          <Icon :name="playing ? 'pause' : 'play'" :size="18" />
        </button>
        <span v-if="!(canTrim && duration > 0)" class="aala-editor__note">{{ duration > 0 ? 'Frame rate unknown, trim is unavailable.' : 'Loading…' }}</span>
      </div>

      <footer class="aala-editor__foot">
        <span class="aala-editor__hint">
          {{ kind === 'audio' ? 'Drag the handles to trim.' : 'Drag on the picture to crop. Click outside the box to clear it.' }}
        </span>
        <span class="aala-spacer" />
        <button type="button" class="aala-btn" @click="clearAll">Reset</button>
        <button type="button" class="aala-btn" @click="emit('close')">Cancel</button>
        <button type="button" class="aala-btn aala-btn--primary" :disabled="!dirty" @click="apply">Apply</button>
      </footer>
    </div>
  </Teleport>
</template>
