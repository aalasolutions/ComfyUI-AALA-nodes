<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowReactive, watch } from 'vue';
import { getPlaces, isMeta, nearestExistingFolder, parentPath, probePaths, type FileEntry, type MediaMeta, type Places, type ProbeResult } from '../../api/fs';
import type { BrowserRequest } from '../../browser/request';
import { en } from '../../i18n/en';
import { distributePanes, paneSizesFrom, resizePanes, type Pane } from '../../state/panes';
import { KINDS, type MediaItem, type MediaKind, type PaneSizes } from '../../state/schema';
import type { MediaStore } from '../../state/store';
import FileBrowserDialog from '../browser/FileBrowserDialog.vue';
import Icon from '../ui/Icon.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import Lightbox from './Lightbox.vue';
import MediaGroup, { type GroupNotice } from './MediaGroup.vue';
import { outputIndexes } from '../../state/items';
import type { ExecutionRuntime } from '../../comfy/widget-bridge';
import { clipboardImages, imageExtension, readClipboardImages, splitSupported, uploadedPath, uploadPastedImage } from '../../comfy/paste';

const props = defineProps<{ store: MediaStore; runtime: ExecutionRuntime; isPasteTarget: (event: Event) => boolean }>();

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
  // Capture phase on window runs before ComfyUI's document paste listener, which would add a Load Image node.
  window.addEventListener('paste', onPaste, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('paste', onPaste, true);
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

function probedMeta(file: FileEntry, results: Record<string, ProbeResult> | null): MediaMeta {
  const result = results?.[file.path];
  return isMeta(result) ? result : { size: file.size, mtime: file.mtime };
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
  if (request.mode === 'replace') {
    const file = files[0];
    props.store.replacePath(request.kind, request.itemId, file.path, probedMeta(file, results));
    notices[request.kind] = results ? null : { tone: 'warning', text: en.probeFailed };
    return;
  }
  addFiles(files, results);
}

function addFiles(files: FileEntry[], results: Record<string, ProbeResult> | null): void {
  const kinds = [...new Set(files.map((file) => file.kind))];
  const report = props.store.addItems(files.map((file) => ({ path: file.path, kind: file.kind, meta: probedMeta(file, results) })));
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

function onPaste(event: ClipboardEvent): void {
  if (readOnly.value || !props.isPasteTarget(event)) {
    return;
  }
  const files = clipboardImages(event.clipboardData);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void pasteImages(files);
}

async function pasteFromClipboard(): Promise<void> {
  let files: File[];
  try {
    files = await readClipboardImages();
  } catch {
    notices.image = { tone: 'error', text: en.clipboardDenied };
    return;
  }
  if (files.length === 0) {
    notices.image = { tone: 'info', text: en.clipboardEmpty };
    return;
  }
  await pasteImages(files);
}

/** Uploads pasted images to the input folder like core Load Image paste, then adds them in one undo step. */
async function pasteImages(files: File[]): Promise<void> {
  let places: Places;
  try {
    places = await getPlaces();
  } catch {
    notices.image = { tone: 'error', text: en.errors.network };
    return;
  }
  const { supported, unsupported } = splitSupported(files, places.kinds.image);
  const uploads = await Promise.allSettled(supported.map(uploadPastedImage));
  const mtime = Date.now() / 1000;
  const entries: FileEntry[] = uploads.flatMap((upload, index) =>
    upload.status === 'fulfilled'
      ? [{ type: 'file', name: upload.value.name, path: uploadedPath(places.comfy.input, upload.value), kind: 'image', size: supported[index].size, mtime }]
      : [],
  );
  if (entries.length > 0) {
    addFiles(entries, await probeFiles(entries));
  }
  const failed = uploads.length - entries.length;
  const problem: GroupNotice | null =
    failed > 0
      ? { tone: 'error', text: en.pasteFailed(failed) }
      : unsupported.length > 0
        ? { tone: 'warning', text: en.pasteUnsupported([...new Set(unsupported.map(imageExtension))]) }
        : null;
  if (problem) {
    const added = entries.length > 0 ? notices.image : null;
    notices.image = added ? { ...problem, text: `${problem.text}; ${added.text}` } : problem;
  }
}

const lightboxItems = computed(() => (lightbox.value ? state.value.groups[lightbox.value.kind] : []));

// Panes: the open lists share the widget height; dividers between them save proportions in ui.sizes.
type GroupView = InstanceType<typeof MediaGroup>;
const manager = ref<HTMLElement | null>(null);
const groupViews = shallowReactive<Partial<Record<MediaKind, GroupView | null>>>({});
// Stable ref callbacks: inline ones would reset the entry to null on every render.
const groupRef = Object.fromEntries(
  KINDS.map((kind) => [
    kind,
    (view: unknown) => {
      groupViews[kind] = view as GroupView | null;
    },
  ]),
) as Record<MediaKind, (view: unknown) => void>;
const available = ref(0);
const dragSizes = ref<PaneSizes | null>(null);
const resizing = ref<MediaKind | null>(null);

const panes = computed<Pane[]>(() =>
  KINDS.flatMap((kind) => {
    const pane = groupViews[kind]?.pane;
    return pane ? [{ kind, ...pane }] : [];
  }),
);
const paneHeights = computed(() => distributePanes(panes.value, available.value, dragSizes.value ?? state.value.ui.sizes ?? null));
// Each open list after the first gets a divider shared with the previous open list.
const dividerAbove = computed(() => {
  const above: Partial<Record<MediaKind, MediaKind>> = {};
  for (let index = 1; index < panes.value.length; index += 1) {
    above[panes.value[index].kind] = panes.value[index - 1].kind;
  }
  return above;
});

function measure(): void {
  const element = manager.value;
  const root = element?.parentElement;
  if (!element || !root) {
    return;
  }
  const lists = panes.value.reduce((sum, pane) => sum + (groupViews[pane.kind]?.scroller?.offsetHeight ?? 0), 0);
  available.value = Math.max(0, root.clientHeight - (element.offsetHeight - lists));
}

let measureFrame = 0;
function scheduleMeasure(): void {
  if (measureFrame === 0) {
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      measure();
    });
  }
}

let sizeObserver: ResizeObserver | null = null;
onMounted(() => {
  sizeObserver = new ResizeObserver(scheduleMeasure);
  if (manager.value) {
    sizeObserver.observe(manager.value);
    if (manager.value.parentElement) {
      sizeObserver.observe(manager.value.parentElement);
    }
  }
  measure();
});
onBeforeUnmount(() => {
  sizeObserver?.disconnect();
  cancelAnimationFrame(measureFrame);
});

function startResize(event: PointerEvent, above: MediaKind, below: MediaKind): void {
  const handle = event.currentTarget as HTMLElement;
  const top = panes.value.find((pane) => pane.kind === above);
  const bottom = panes.value.find((pane) => pane.kind === below);
  if (event.button !== 0 || !top || !bottom || !manager.value) {
    return;
  }
  const base = paneSizesFrom(paneHeights.value, state.value.ui.sizes ?? null, available.value);
  const heights = distributePanes(panes.value, available.value, base);
  const abovePane = { ...top, height: heights[above] ?? 0 };
  const belowPane = { ...bottom, height: heights[below] ?? 0 };
  // The canvas may zoom the widget; pointer deltas are in screen pixels.
  const scale = manager.value.offsetHeight ? manager.value.getBoundingClientRect().height / manager.value.offsetHeight : 1;
  const startY = event.clientY;

  const onMove = (move: PointerEvent) => {
    const delta = (move.clientY - startY) / (scale || 1);
    const sizes = resizePanes(base, abovePane, belowPane, delta);
    dragSizes.value = distributePanes(panes.value, available.value, sizes)[above] === abovePane.height ? null : sizes;
  };
  const finish = (keep: boolean) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    handle.removeEventListener('lostpointercapture', onUp);
    const sizes = dragSizes.value;
    dragSizes.value = null;
    resizing.value = null;
    if (keep && sizes) {
      props.store.setPaneSizes(sizes);
    }
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  handle.setPointerCapture(event.pointerId);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  handle.addEventListener('lostpointercapture', onUp);
  resizing.value = below;
}
</script>

<template>
  <div ref="manager" class="aala-manager" :class="{ 'aala-manager--resizing': resizing }" @pointerdown.stop>
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
      <template v-for="kind in KINDS" :key="kind">
        <div
          v-if="dividerAbove[kind]"
          class="aala-pane-divider"
          :class="{ 'aala-pane-divider--active': resizing === kind }"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize"
          @pointerdown.stop.prevent="startResize($event, dividerAbove[kind]!, kind)"
        />
        <MediaGroup
          :ref="groupRef[kind]"
          :store="store"
          :kind="kind"
          :notice="notices[kind]"
          :meta-of="metaOf"
          :missing-text="missingText"
          :pane-height="paneHeights[kind] ?? null"
          @add="openAdd(kind)"
          @replace="openReplace(kind, $event, parentPath($event.path))"
          @relink="relink(kind, $event)"
          @preview="lightbox = { kind, index: $event }"
          @notify="notices[kind] = $event"
          @paste="pasteFromClipboard"
        />
      </template>
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
      @apply="(id, edit) => store.setEdit(lightbox!.kind, id, edit)"
    />
  </div>
</template>
