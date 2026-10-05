<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowReactive, watch } from 'vue';
import { isMeta, nearestExistingFolder, parentPath, probePaths, type FileEntry, type MediaMeta, type ProbeResult } from '../../api/fs';
import type { BrowserRequest } from '../../browser/request';
import { en } from '../../i18n/en';
import { KINDS, type MediaItem, type MediaKind } from '../../state/schema';
import type { MediaStore } from '../../state/store';
import FileBrowserDialog from '../browser/FileBrowserDialog.vue';
import Icon from '../ui/Icon.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import Lightbox from './Lightbox.vue';
import MediaGroup, { type GroupNotice } from './MediaGroup.vue';
import { outputIndexes } from '../../state/items';
import type { ExecutionRuntime } from '../../comfy/widget-bridge';

const props = defineProps<{ store: MediaStore; runtime: ExecutionRuntime }>();

const readOnly = computed(() => props.store.data.readOnlyRaw !== null);
const state = computed(() => props.store.data.state);
const browser = ref<BrowserRequest | null>(null);
const lightbox = ref<{ kind: MediaKind; index: number } | null>(null);
const notices = reactive<Record<MediaKind, GroupNotice | null>>({ image: null, video: null, audio: null });
// Probe results from this session, used for display and the missing state; never written to the workflow.
const live = shallowReactive(new Map<string, ProbeResult>());
// Paths the last Run skipped; a path leaves the set once a probe reads it again.
const skippedByRun = shallowReactive(new Set<string>());
let reprobing = false;

const allPaths = computed(() => KINDS.flatMap((kind) => state.value.groups[kind].map((item) => item.path)));
const addedPaths = computed<ReadonlySet<string>>(() => new Set(allPaths.value));

watch(
  allPaths,
  async (paths) => {
    const unknown = [...new Set(paths)].filter((path) => !live.has(path));
    if (unknown.length === 0) {
      return;
    }
    try {
      await probeInto(unknown);
    } catch {
      // Display falls back to stored meta; the missing state waits for the next successful probe.
    }
  },
  { immediate: true },
);

async function probeInto(paths: string[]): Promise<void> {
  const results = await probePaths(paths);
  Object.entries(results).forEach(([path, result]) => {
    live.set(path, result);
    if (isMeta(result)) {
      skippedByRun.delete(path);
    }
  });
}

/** Probes every current path again: files can disappear or come back while the workflow is open. */
async function reprobe(): Promise<void> {
  const paths = [...new Set(allPaths.value)];
  if (reprobing || paths.length === 0) {
    return;
  }
  reprobing = true;
  try {
    await probeInto(paths);
  } catch {
    // Keep the previous results until the next successful probe.
  } finally {
    reprobing = false;
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') {
    void reprobe();
  }
}

watch(
  () => props.runtime.runs,
  () => {
    skippedByRun.clear();
    props.runtime.missing.forEach((path) => skippedByRun.add(path));
    void reprobe();
  },
);

onMounted(() => {
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
});

function metaOf(item: Readonly<MediaItem>): MediaMeta | null {
  const result = live.get(item.path);
  return isMeta(result) ? result : ((item.meta as MediaMeta | null | undefined) ?? null);
}

/** Why an item cannot be used at Run, or null when it is fine. */
function missingText(item: Readonly<MediaItem>): string | null {
  const result = live.get(item.path);
  if (result && 'missing' in result) {
    return en.missing;
  }
  return skippedByRun.has(item.path) ? en.skippedLastRun : null;
}

function isMissing(item: Readonly<MediaItem>): boolean {
  return missingText(item) !== null;
}

function openAdd(kind: MediaKind | null): void {
  browser.value = { mode: 'add', kind };
}

function openReplace(kind: MediaKind, item: Readonly<MediaItem>, startPath: string | null): void {
  browser.value = { mode: 'replace', kind, itemId: item.id, startPath };
}

async function relink(kind: MediaKind, item: Readonly<MediaItem>): Promise<void> {
  openReplace(kind, item, await nearestExistingFolder(item.path));
}

async function probeFiles(files: FileEntry[]): Promise<Record<string, ProbeResult> | null> {
  try {
    const results = await probePaths(files.map((file) => file.path));
    Object.entries(results).forEach(([path, result]) => live.set(path, result));
    return results;
  } catch {
    return null;
  }
}

async function onBrowserConfirm(files: FileEntry[]): Promise<void> {
  const request = browser.value;
  browser.value = null;
  if (!request) {
    return;
  }
  const kinds = [...new Set(files.map((file) => file.kind))];
  if (files.length > 20) {
    kinds.forEach((kind) => (notices[kind] = { tone: 'info', text: `Reading details of ${files.length} files…` }));
  }
  const results = await probeFiles(files);
  const metaFor = (file: FileEntry): MediaMeta => {
    const result = results?.[file.path];
    return isMeta(result) ? result : { size: file.size, mtime: file.mtime };
  };

  if (request.mode === 'replace') {
    const file = files[0];
    props.store.replacePath(request.kind, request.itemId, file.path, metaFor(file));
    notices[request.kind] = results ? null : { tone: 'warning', text: en.probeFailed };
    return;
  }
  const report = props.store.addItems(files.map((file) => ({ path: file.path, kind: file.kind, meta: metaFor(file) })));
  for (const kind of kinds) {
    const inactive = report?.[kind].inactive ?? 0;
    notices[kind] =
      inactive > 0
        ? { tone: 'warning', text: en.addedInactive(inactive, state.value.limits[kind]) }
        : results
          ? null
          : { tone: 'warning', text: en.probeFailed };
  }
}

const lightboxItems = computed(() => (lightbox.value ? state.value.groups[lightbox.value.kind] : []));

function onWheel(event: WheelEvent): void {
  const scroller = event.currentTarget as HTMLElement | null;
  const root = scroller?.parentElement;
  if (!root) {
    return;
  }
  const canScrollDown = root.scrollTop + root.clientHeight < root.scrollHeight - 1;
  const canScrollUp = root.scrollTop > 0;
  if ((event.deltaY > 0 && canScrollDown) || (event.deltaY < 0 && canScrollUp)) {
    event.stopPropagation();
  }
}
</script>

<template>
  <div class="aala-manager" @pointerdown.stop @wheel="onWheel">
    <StatusBanner
      v-if="store.data.status"
      :tone="store.data.status.tone"
      :text="store.data.status.text"
      :dismissible="!readOnly"
      @dismiss="store.setStatus(null)"
    />
    <template v-if="!readOnly">
      <div class="aala-manager__bar">
        <button type="button" class="aala-btn aala-btn--small" title="Add images, videos or audio" @click="openAdd(null)">
          <Icon name="plus" :size="12" /> Add media
        </button>
        <span class="aala-spacer" />
        <div class="aala-segmented" role="group" aria-label="Layout">
          <button
            type="button"
            class="aala-icon-btn"
            :class="{ 'aala-icon-btn--on': state.ui.layout === 'list' }"
            :aria-pressed="state.ui.layout === 'list'"
            title="List"
            aria-label="List layout"
            @click="store.setLayout('list')"
          >
            <Icon name="list" :size="14" />
          </button>
          <button
            type="button"
            class="aala-icon-btn"
            :class="{ 'aala-icon-btn--on': state.ui.layout === 'grid' }"
            :aria-pressed="state.ui.layout === 'grid'"
            title="Grid"
            aria-label="Grid layout"
            @click="store.setLayout('grid')"
          >
            <Icon name="grid" :size="14" />
          </button>
        </div>
      </div>
      <MediaGroup
        v-for="kind in KINDS"
        :key="kind"
        :store="store"
        :kind="kind"
        :notice="notices[kind]"
        :meta-of="metaOf"
        :missing-text="missingText"
        @add="openAdd(kind)"
        @replace="openReplace(kind, $event, parentPath($event.path))"
        @relink="relink(kind, $event)"
        @preview="lightbox = { kind, index: $event }"
        @notify="notices[kind] = $event"
      />
    </template>
    <FileBrowserDialog
      v-if="browser"
      :request="browser"
      :added-paths="addedPaths"
      @confirm="onBrowserConfirm"
      @close="browser = null"
    />
    <Lightbox
      v-if="lightbox && lightboxItems.length"
      :items="lightboxItems"
      :index="Math.min(lightbox.index, lightboxItems.length - 1)"
      :kind="lightbox.kind"
      :output-indexes="outputIndexes(lightboxItems, isMissing)"
      :meta-of="metaOf"
      @close="lightbox = null"
      @step="lightbox = { kind: lightbox!.kind, index: $event }"
    />
  </div>
</template>
