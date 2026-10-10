<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatSeconds } from '../../state/edit';

const props = defineProps<{
  duration: number;
  start: number;
  end: number;
  current: number;
  minGap: number;
  peaks: number[] | null;
}>();
const emit = defineEmits<{ range: [start: number, end: number]; seek: [seconds: number] }>();

const track = ref<HTMLElement | null>(null);
const pct = (seconds: number) => `${props.duration > 0 ? (seconds / props.duration) * 100 : 0}%`;

const bars = computed(() => {
  const values = props.peaks;
  if (!values || values.length < 2) {
    return [];
  }
  const count = values.length / 2;
  return Array.from({ length: count }, (_, index) => {
    const amplitude = Math.min(1, Math.max(Math.abs(values[index * 2]), Math.abs(values[index * 2 + 1])));
    const height = Math.max(1, amplitude * 38);
    const at = ((index + 0.5) / count) * props.duration;
    return { x: (index * 100) / count, w: (100 / count) * 0.7, y: 20 - height / 2, h: height, kept: at >= props.start && at <= props.end };
  });
});

function secondsAt(event: PointerEvent): number {
  const rect = track.value!.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * props.duration;
}

function drag(event: PointerEvent, handle: 'start' | 'end' | 'seek'): void {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const update = (move: PointerEvent) => {
    const at = secondsAt(move);
    if (handle === 'start') {
      const start = Math.min(at, props.end - props.minGap);
      emit('range', Math.max(0, start), props.end);
      emit('seek', Math.max(0, start));
    } else if (handle === 'end') {
      const end = Math.max(at, props.start + props.minGap);
      emit('range', props.start, Math.min(props.duration, end));
      emit('seek', Math.min(props.duration, end));
    } else {
      emit('seek', at);
    }
  };
  update(event);
  const stop = () => {
    target.removeEventListener('pointermove', update);
    target.removeEventListener('pointerup', stop);
    target.removeEventListener('pointercancel', stop);
  };
  target.addEventListener('pointermove', update);
  target.addEventListener('pointerup', stop);
  target.addEventListener('pointercancel', stop);
}
</script>

<template>
  <div class="aala-trim">
    <div class="aala-trim__lead"><slot /></div>
    <div ref="track" class="aala-trim__track" :class="{ 'aala-trim__track--wave': bars.length }" @pointerdown="drag($event, 'seek')">
      <svg v-if="bars.length" class="aala-trim__wave" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <rect
          v-for="(bar, index) in bars"
          :key="index"
          :x="bar.x"
          :y="bar.y"
          :width="bar.w"
          :height="bar.h"
          :class="{ 'aala-trim__bar--cut': !bar.kept }"
        />
      </svg>
      <div class="aala-trim__cut" :style="{ left: 0, width: pct(start) }" />
      <div class="aala-trim__cut" :style="{ left: pct(end), right: 0 }" />
      <div class="aala-trim__kept" :style="{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }" />
      <div class="aala-trim__playhead" :style="{ left: pct(current) }" />
      <button
        type="button"
        class="aala-trim__handle aala-trim__handle--start"
        :style="{ left: pct(start) }"
        aria-label="Trim start"
        @pointerdown="drag($event, 'start')"
      />
      <button
        type="button"
        class="aala-trim__handle aala-trim__handle--end"
        :style="{ left: pct(end) }"
        aria-label="Trim end"
        @pointerdown="drag($event, 'end')"
      />
    </div>
    <div class="aala-trim__times">
      <span>{{ formatSeconds(start) }}</span>
      <span>kept {{ formatSeconds(end - start) }} of {{ formatSeconds(duration) }}</span>
      <span>{{ formatSeconds(end) }}</span>
    </div>
  </div>
</template>
