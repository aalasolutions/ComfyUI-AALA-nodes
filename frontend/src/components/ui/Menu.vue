<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useKeyboardScope } from '../../composables/useKeyboardScope';

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

const props = defineProps<{ items: MenuItem[]; x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const focused = ref(-1);
const position = ref({ left: props.x, top: props.y });
const enabled = computed(() => props.items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0));

function choose(item: MenuItem): void {
  if (item.disabled) {
    return;
  }
  emit('close');
  item.action();
}

function step(delta: number): void {
  const list = enabled.value;
  if (list.length === 0) {
    return;
  }
  const at = list.indexOf(focused.value);
  focused.value = list[(at + delta + list.length) % list.length];
  root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]')[focused.value]?.focus();
}

useKeyboardScope(ref(true), (event) => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    emit('close');
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    step(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    step(-1);
  } else if ((event.key === 'Enter' || event.key === ' ') && focused.value >= 0) {
    event.preventDefault();
    choose(props.items[focused.value]);
  }
});

onMounted(async () => {
  await nextTick();
  const rect = root.value?.getBoundingClientRect();
  if (rect) {
    position.value = {
      left: Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 4)),
    };
  }
  step(1);
});
</script>

<template>
  <Teleport to="body">
    <div class="aala-media aala-layer" @pointerdown.self="emit('close')" @contextmenu.prevent.self="emit('close')">
      <div
        ref="root"
        class="aala-menu"
        role="menu"
        :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      >
        <button
          v-for="(item, index) in items"
          :key="item.label"
          type="button"
          role="menuitem"
          class="aala-menu__item"
          :class="{ 'aala-menu__item--danger': item.danger }"
          :disabled="item.disabled"
          :tabindex="index === focused ? 0 : -1"
          @click="choose(item)"
          @pointerenter="focused = index"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
