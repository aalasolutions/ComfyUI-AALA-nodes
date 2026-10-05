<script setup lang="ts">
import type { StatusTone } from '../../state/store';

defineProps<{ tone: StatusTone; text: string; dismissible?: boolean }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div class="aala-status" :class="`aala-status--${tone}`" :role="tone === 'error' ? 'alert' : 'status'">
    <span class="aala-status__text">{{ text }}</span>
    <slot />
    <button v-if="dismissible" type="button" class="aala-status__close" aria-label="Dismiss" @click="$emit('dismiss')">
      ×
    </button>
  </div>
</template>
