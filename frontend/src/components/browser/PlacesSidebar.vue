<script setup lang="ts">
import { computed } from 'vue';
import { baseName, type Place, type Places } from '../../api/fs';
import Icon from '../ui/Icon.vue';

const props = defineProps<{ places: Places | null; favorites: string[]; recent: string[]; current: string }>();
const emit = defineEmits<{ navigate: [path: string]; removeFavorite: [path: string] }>();

interface Section {
  title: string;
  icon: string;
  items: Place[];
  removable?: boolean;
}

const toPlaces = (paths: string[]): Place[] => paths.map((path) => ({ label: baseName(path), path }));

const sections = computed<Section[]>(() => {
  const places = props.places;
  const list: Section[] = [];
  if (places) {
    list.push({
      title: 'ComfyUI',
      icon: 'folder',
      items: [
        { label: 'Input', path: places.comfy.input },
        { label: 'Output', path: places.comfy.output },
        { label: 'Temp', path: places.comfy.temp },
      ],
    });
    list.push({ title: 'Places', icon: 'home', items: places.places });
    if (places.volumes.length > 0) {
      list.push({ title: 'Volumes', icon: 'drive', items: places.volumes });
    }
  }
  list.push({ title: 'Favorites', icon: 'star', items: toPlaces(props.favorites), removable: true });
  list.push({ title: 'Recent', icon: 'clock', items: toPlaces(props.recent) });
  return list;
});
</script>

<template>
  <nav class="aala-places" aria-label="Places">
    <section v-for="section in sections" :key="section.title" class="aala-places__section">
      <h3 class="aala-places__title">{{ section.title }}</h3>
      <p v-if="section.items.length === 0" class="aala-places__empty">None yet</p>
      <div
        v-for="place in section.items"
        :key="place.path"
        class="aala-places__row"
        :class="{ 'aala-places__row--current': place.path === current }"
      >
        <button type="button" class="aala-places__item" :title="place.path" @click="emit('navigate', place.path)">
          <Icon :name="section.icon" :size="14" />
          <span class="aala-ellipsis">{{ place.label }}</span>
        </button>
        <button
          v-if="section.removable"
          type="button"
          class="aala-icon-btn aala-places__remove"
          :aria-label="`Remove ${place.label} from favorites`"
          title="Remove from favorites"
          @click="emit('removeFavorite', place.path)"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>
    </section>
  </nav>
</template>
