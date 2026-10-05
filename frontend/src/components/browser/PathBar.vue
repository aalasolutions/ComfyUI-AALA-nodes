<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Menu, { type MenuItem } from '../ui/Menu.vue';

const SEGMENT_WIDTH = 110;

const props = defineProps<{ path: string; editing: boolean; error: string | null }>();
const draft = defineModel<string>('draft', { required: true });
const emit = defineEmits<{ navigate: [path: string]; edit: [] }>();

const bar = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const width = ref(0);
const overflowMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
let observer: ResizeObserver | null = null;

const segments = computed(() => {
  const parts = props.path.split('/').filter(Boolean);
  const list = [{ label: '/', path: '/' }];
  parts.forEach((part, index) => list.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` }));
  return list;
});

// Root and the last segments stay visible; the middle collapses into an overflow menu when space is short.
const layout = computed(() => {
  const all = segments.value;
  const fit = Math.max(2, Math.floor(width.value / SEGMENT_WIDTH));
  if (all.length <= fit) {
    return { hidden: [], shown: all.slice(1) };
  }
  const tail = Math.max(1, fit - 1);
  return { hidden: all.slice(1, all.length - tail), shown: all.slice(all.length - tail) };
});

function openOverflow(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  overflowMenu.value = {
    x: rect.left,
    y: rect.bottom + 2,
    items: layout.value.hidden.map((segment) => ({ label: segment.label, action: () => emit('navigate', segment.path) })),
  };
}

watch(
  () => props.editing,
  async (editing) => {
    if (editing) {
      await nextTick();
      input.value?.focus();
      input.value?.select();
    }
  },
);

onMounted(() => {
  if (bar.value) {
    observer = new ResizeObserver(() => (width.value = bar.value?.clientWidth ?? 0));
    observer.observe(bar.value);
  }
});

onBeforeUnmount(() => observer?.disconnect());

defineExpose({ input });
</script>

<template>
  <div ref="bar" class="aala-pathbar" :class="{ 'aala-pathbar--error': error }">
    <input
      v-if="editing"
      ref="input"
      v-model="draft"
      class="aala-pathbar__input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label="Folder path"
      placeholder="Type an absolute path, ~ for home"
      data-role="path"
    />
    <div v-else class="aala-crumbs" :title="path" @click.self="emit('edit')">
      <button type="button" class="aala-crumbs__item" @click="emit('navigate', '/')">/</button>
      <template v-if="layout.hidden.length">
        <button type="button" class="aala-crumbs__item" aria-label="Show hidden path segments" @click="openOverflow">…</button>
        <span class="aala-crumbs__sep">/</span>
      </template>
      <template v-for="(segment, index) in layout.shown" :key="segment.path">
        <span v-if="index > 0" class="aala-crumbs__sep">/</span>
        <button type="button" class="aala-crumbs__item aala-ellipsis" :title="segment.path" @click="emit('navigate', segment.path)">
          {{ segment.label }}
        </button>
      </template>
    </div>
    <p v-if="error" class="aala-pathbar__error" role="alert">{{ error }}</p>
    <Menu v-if="overflowMenu" :items="overflowMenu.items" :x="overflowMenu.x" :y="overflowMenu.y" @close="overflowMenu = null" />
  </div>
</template>
