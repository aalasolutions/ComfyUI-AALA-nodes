<script setup lang="ts">
import { computed } from 'vue';
import { baseName, type MediaMeta } from '../../api/fs';
import { describeMeta, formatDuration, ratioLabel } from '../../browser/listing';
import { en } from '../../i18n/en';
import { OUTPUT_PREFIX } from '../../state/items';
import type { MediaItem, MediaKind } from '../../state/schema';
import Icon from '../ui/Icon.vue';
import Thumb from '../ui/Thumb.vue';

const props = defineProps<{
  item: Readonly<MediaItem>;
  kind: MediaKind;
  meta: MediaMeta | null;
  outputIndex: number | undefined;
  selected: boolean;
  missing: string | null;
  skip: 'muted' | 'missing' | null;
  layout: 'list' | 'grid';
  dragging: boolean;
}>();
const emit = defineEmits<{
  toggleActive: [];
  toggleMute: [];
  options: [event: MouseEvent];
  preview: [];
  select: [event: MouseEvent];
  relink: [];
  dragStart: [event: PointerEvent];
  move: [delta: number];
}>();

interface EditInfo {
  crop?: unknown;
  trim?: { start_frame?: number; end_frame?: number; start?: number; end?: number } | null;
}

const name = computed(() => baseName(props.item.path));
const muted = computed(() => props.item.muted === true);
// The output position at Run; an active item that Run skips shows why instead.
const tag = computed(() =>
  props.outputIndex !== undefined ? `${OUTPUT_PREFIX[props.kind]} ${props.outputIndex}` : props.item.active && props.skip ? props.skip : 'off',
);
const info = computed(() => describeMeta(props.kind, props.meta));
const ratio = computed(() =>
  props.kind !== 'audio' && props.meta?.width && props.meta.height ? ratioLabel(props.meta.width, props.meta.height) : '',
);

// Edit badges for state written by later editor phases (crop, trim, split parts).
const editBadges = computed(() => {
  const edit = (props.item.edit ?? {}) as EditInfo;
  const badges: string[] = [];
  if (edit.crop) {
    badges.push('cropped');
  }
  const trim = edit.trim;
  if (trim) {
    const fps = props.meta?.fps?.split('/').map(Number);
    const seconds =
      trim.end !== undefined && trim.start !== undefined
        ? trim.end - trim.start
        : fps && fps[0] && fps[1] && trim.end_frame !== undefined && trim.start_frame !== undefined
          ? ((trim.end_frame - trim.start_frame) * fps[1]) / fps[0]
          : null;
    badges.push(seconds === null ? 'trimmed' : `trimmed ${formatDuration(seconds)}`);
  }
  if (typeof props.item.part === 'number' && typeof props.item.parts === 'number') {
    badges.push(`${props.item.part}/${props.item.parts}`);
  }
  return badges;
});

// The whole card drags, except from the preview and the card's buttons and inputs.
function onPointerDown(event: PointerEvent): void {
  if (!(event.target as Element).closest('button, input, select, textarea, a')) {
    emit('dragStart', event);
  }
}

function onKey(event: KeyboardEvent): void {
  const back = event.key === 'ArrowUp' || (props.layout === 'grid' && event.key === 'ArrowLeft');
  const forward = event.key === 'ArrowDown' || (props.layout === 'grid' && event.key === 'ArrowRight');
  if (event.altKey && (back || forward)) {
    event.preventDefault();
    event.stopPropagation();
    emit('move', back ? -1 : 1);
  } else if (event.key === 'Enter' && event.target === event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    emit('preview');
  }
}
</script>

<template>
  <div
    class="aala-card"
    :class="[
      `aala-card--${layout}`,
      {
        'aala-card--off': !item.active,
        'aala-card--selected': selected,
        'aala-card--missing': missing,
        'aala-card--dragging': dragging,
      },
    ]"
    :data-sort-id="item.id"
    tabindex="0"
    :aria-label="`${name}, ${item.active ? tag : 'inactive'}`"
    @click="emit('select', $event)"
    @pointerdown="onPointerDown"
    @contextmenu.prevent.stop="emit('options', $event)"
    @keydown="onKey"
  >
    <span class="aala-card__handle" title="Drag to reorder (Option/Alt+Up or Option/Alt+Down)" @click.stop>
      <Icon name="drag" :size="14" />
    </span>
    <button type="button" class="aala-card__preview" :title="`Preview ${name}`" @click.stop="emit('preview')">
      <Icon v-if="missing" class="aala-card__missing-icon" :name="kind" :size="20" />
      <Thumb v-else :path="item.path" :kind="kind" :mtime="meta?.mtime ?? 0" :size="256" />
      <span class="aala-tag" :class="{ 'aala-tag--off': outputIndex === undefined }">{{ tag }}</span>
    </button>
    <div class="aala-card__body">
      <span class="aala-card__name aala-ellipsis" :title="item.path">{{ name }}</span>
      <span v-if="missing" class="aala-card__missing">
        <Icon name="warning" :size="12" />
        <span class="aala-ellipsis" :title="missing">{{ missing }}</span>
        <button type="button" class="aala-btn aala-btn--small" @click.stop="emit('relink')">{{ en.relink }}</button>
      </span>
      <span v-else class="aala-card__info">
        <span v-if="info" class="aala-ellipsis">{{ info }}</span>
        <span v-if="ratio" class="aala-badge">{{ ratio }}</span>
        <span v-for="badge in editBadges" :key="badge" class="aala-badge">{{ badge }}</span>
        <span v-if="muted" class="aala-badge">muted</span>
      </span>
    </div>
    <div class="aala-card__controls" @click.stop>
      <button
        type="button"
        class="aala-icon-btn aala-power"
        :class="{ 'aala-power--on': item.active }"
        :aria-pressed="item.active"
        :title="item.active ? 'Active: click to bypass' : 'Bypassed: click to activate'"
        aria-label="Active"
        @click="emit('toggleActive')"
      >
        <Icon name="power" :size="14" />
      </button>
      <button
        v-if="kind !== 'image'"
        type="button"
        class="aala-icon-btn"
        :class="{ 'aala-icon-btn--on': muted }"
        :aria-pressed="muted"
        :title="muted ? 'Muted: click to unmute' : 'Mute'"
        aria-label="Mute"
        @click="emit('toggleMute')"
      >
        <Icon :name="muted ? 'mute' : 'volume'" :size="14" />
      </button>
      <button type="button" class="aala-icon-btn" title="Options" aria-label="Options" @click="emit('options', $event)">
        <Icon name="more" :size="14" />
      </button>
    </div>
  </div>
</template>
