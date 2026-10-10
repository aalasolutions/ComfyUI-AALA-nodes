<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { clampRect, type Rect, type Rotation } from '../../state/edit';

type Mode = 'new' | 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_PX = 16;
const CORNERS: Mode[] = ['nw', 'ne', 'sw', 'se'];
const EDGES: Mode[] = ['n', 's', 'e', 'w'];

const props = defineProps<{
  frameWidth: number;
  frameHeight: number;
  rotate: Rotation;
  mirror: boolean;
  crop: Rect | null;
  ratio: number | null;
}>();
const emit = defineEmits<{ crop: [rect: Rect | null] }>();

const root = ref<HTMLElement | null>(null);
const box = ref<HTMLElement | null>(null);
const avail = ref({ w: 0, h: 0 });
const dragging = ref(false);
let observer: ResizeObserver | null = null;

const turned = computed(() => props.rotate % 180 !== 0);
const oriented = computed(() =>
  turned.value ? { w: props.frameHeight, h: props.frameWidth } : { w: props.frameWidth, h: props.frameHeight },
);
const scale = computed(() =>
  oriented.value.w && oriented.value.h && avail.value.w && avail.value.h
    ? Math.min(avail.value.w / oriented.value.w, avail.value.h / oriented.value.h)
    : 0,
);
const boxStyle = computed(() => ({
  width: `${oriented.value.w * scale.value}px`,
  height: `${oriented.value.h * scale.value}px`,
  visibility: scale.value ? ('visible' as const) : ('hidden' as const),
}));
const mediaStyle = computed(() => ({
  width: `${props.frameWidth * scale.value}px`,
  height: `${props.frameHeight * scale.value}px`,
  transform: `translate(-50%, -50%) ${props.mirror ? 'scaleX(-1) ' : ''}rotate(${props.rotate}deg)`,
}));
const rectStyle = computed(() => {
  const rect = props.crop;
  return rect
    ? { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }
    : null;
});
const handles = computed(() => (props.ratio ? CORNERS : [...CORNERS, ...EDGES]));

function pointAt(event: PointerEvent): { x: number; y: number } {
  const rect = box.value!.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function spanRect(anchor: { x: number; y: number }, point: { x: number; y: number }, minimum = false): Rect {
  const { w: ow, h: oh } = oriented.value;
  const dirX = point.x >= anchor.x ? 1 : -1;
  const dirY = point.y >= anchor.y ? 1 : -1;
  let w = Math.abs(point.x - anchor.x) * ow;
  let h = Math.abs(point.y - anchor.y) * oh;
  if (props.ratio) {
    if (w / Math.max(h, 1e-9) > props.ratio) {
      w = h * props.ratio;
    } else {
      h = w / props.ratio;
    }
    const roomW = (dirX > 0 ? 1 - anchor.x : anchor.x) * ow;
    const roomH = (dirY > 0 ? 1 - anchor.y : anchor.y) * oh;
    const fit = Math.min(1, roomW / Math.max(w, 1e-9), roomH / Math.max(h, 1e-9));
    w *= fit;
    h *= fit;
  }
  if (minimum && props.ratio) {
    w = Math.max(w, MIN_PX, MIN_PX * props.ratio);
    h = w / props.ratio;
  } else if (minimum) {
    w = Math.max(w, MIN_PX);
    h = Math.max(h, MIN_PX);
  }
  const nw = w / ow;
  const nh = h / oh;
  return { x: dirX > 0 ? anchor.x : anchor.x - nw, y: dirY > 0 ? anchor.y : anchor.y - nh, w: nw, h: nh };
}

function edgeRect(start: Rect, mode: Mode, point: { x: number; y: number }): Rect {
  const minW = MIN_PX / oriented.value.w;
  const minH = MIN_PX / oriented.value.h;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (mode.includes('w')) left = Math.min(point.x, right - minW);
  if (mode.includes('e')) right = Math.max(point.x, left + minW);
  if (mode.includes('n')) top = Math.min(point.y, bottom - minH);
  if (mode.includes('s')) bottom = Math.max(point.y, top + minH);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top });
}

function begin(event: PointerEvent, mode: Mode): void {
  if (event.button !== 0 || !scale.value) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const origin = pointAt(event);
  const start: Rect = props.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const anchor =
    mode === 'new'
      ? origin
      : { x: mode.includes('w') ? start.x + start.w : start.x, y: mode.includes('n') ? start.y + start.h : start.y };
  let moved = false;
  dragging.value = true;

  const update = (move: PointerEvent) => {
    const point = pointAt(move);
    moved ||= Math.abs(point.x - origin.x) + Math.abs(point.y - origin.y) > 0.003;
    if (!moved) {
      return;
    }
    if (mode === 'move') {
      emit('crop', clampRect({ ...start, x: start.x + point.x - origin.x, y: start.y + point.y - origin.y }));
    } else if (mode === 'new' || (props.ratio && CORNERS.includes(mode))) {
      emit('crop', clampRect(spanRect(anchor, point, mode !== 'new')));
    } else {
      emit('crop', edgeRect(start, mode, point));
    }
  };
  const stop = () => {
    dragging.value = false;
    target.removeEventListener('pointermove', update);
    target.removeEventListener('pointerup', stop);
    target.removeEventListener('pointercancel', stop);
    const rect = props.crop;
    if (mode === 'new' && (!moved || !rect || rect.w * oriented.value.w < MIN_PX || rect.h * oriented.value.h < MIN_PX)) {
      emit('crop', null);
    }
  };
  target.addEventListener('pointermove', update);
  target.addEventListener('pointerup', stop);
  target.addEventListener('pointercancel', stop);
}

onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    avail.value = { w: entry.contentRect.width, h: entry.contentRect.height };
  });
  observer.observe(root.value!);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="root" class="aala-crop">
    <div ref="box" class="aala-crop__box" :style="boxStyle" @pointerdown="begin($event, 'new')">
      <div class="aala-crop__media" :style="mediaStyle">
        <slot />
      </div>
      <div v-if="rectStyle" class="aala-crop__rect" :class="{ 'aala-crop__rect--dragging': dragging }" :style="rectStyle" @pointerdown="begin($event, 'move')">
        <span class="aala-crop__thirds" />
        <span
          v-for="handle in handles"
          :key="handle"
          class="aala-crop__handle"
          :class="`aala-crop__handle--${handle}`"
          @pointerdown="begin($event, handle)"
        />
      </div>
    </div>
  </div>
</template>
