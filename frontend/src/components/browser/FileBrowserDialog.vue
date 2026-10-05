<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, toRef } from 'vue';
import { baseName, getPlaces, listFolder, parentPath, type Entry, type FileEntry, type Places } from '../../api/fs';
import { filesOf, filterEntries, sortEntries, type KindFilter } from '../../browser/listing';
import type { BrowserRequest } from '../../browser/request';
import * as sel from '../../browser/selection';
import { getPref, RECENT_LIMIT, setPref, type SortKey, type ThumbSize } from '../../comfy/prefs';
import { collectRecursive, useFolderListing } from '../../composables/useFolderListing';
import { isMod, isTextInput, useKeyboardScope } from '../../composables/useKeyboardScope';
import { en, KIND_LABEL } from '../../i18n/en';
import { KINDS } from '../../state/schema';
import type { StatusTone } from '../../state/store';
import Icon from '../ui/Icon.vue';
import Menu, { type MenuItem } from '../ui/Menu.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import FileGrid from './FileGrid.vue';
import FileList from './FileList.vue';
import PathBar from './PathBar.vue';
import PlacesSidebar from './PlacesSidebar.vue';

const props = defineProps<{ request: BrowserRequest; addedPaths: ReadonlySet<string> }>();
const emit = defineEmits<{ confirm: [files: FileEntry[]]; close: [] }>();

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', mtime: 'Date modified', size: 'Size', kind: 'Kind' };
const SKELETONS = 24;
const idPrefix = `aala-fb-${Math.random().toString(36).slice(2, 8)}`;

const prefs = reactive({
  favorites: getPref('favorites'),
  recent: getPref('recent'),
  view: getPref('view'),
  sort: getPref('sort'),
  thumbSize: getPref('thumbSize'),
  showHidden: getPref('showHidden'),
});
const dialogSize = getPref('dialogSize');

const places = ref<Places | null>(null);
const listing = useFolderListing(toRef(prefs, 'showHidden'));
const history = ref<string[]>([]);
const historyIndex = ref(-1);
const query = ref('');
const kindFilter = ref<KindFilter>(props.request.kind ?? 'all');
const selection = shallowRef<sel.Selection>(new Map());
const anchor = ref<string | null>(null);
const focusIndex = ref(-1);
const editingPath = ref(false);
const pathDraft = ref('');
const pathError = ref<string | null>(null);
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
const notice = ref<{ tone: StatusTone; text: string; confirm?: () => void } | null>(null);
const dialog = ref<HTMLElement | null>(null);
const view = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const grid = ref<InstanceType<typeof FileGrid> | null>(null);
let folderTask: AbortController | null = null;

const singlePick = computed(() => props.request.mode === 'replace');
const visible = computed<Entry[]>(() =>
  sortEntries(filterEntries(listing.entries.value, query.value, kindFilter.value), prefs.sort),
);
const visibleFiles = computed(() => filesOf(visible.value));
const isFavorite = computed(() => prefs.favorites.includes(listing.state.path));
const canAdd = computed(() => selection.value.size > 0 && (!singlePick.value || selection.value.size === 1));
const confirmLabel = computed(() => (singlePick.value ? en.replaceWith : en.addItems(selection.value.size)));
const title = computed(() => (singlePick.value ? `Choose a replacement ${props.request.kind} file` : 'Add media'));

const emptyText = computed(() => {
  if (listing.entries.value.length === 0) {
    return listing.state.skipped > 0 ? en.noMedia : en.folderEmpty;
  }
  if (query.value.trim()) {
    return en.noMatches(query.value.trim());
  }
  return kindFilter.value === 'all' ? en.noMedia : en.noKind(KIND_LABEL[kindFilter.value]);
});

const statusText = computed(() => `${visible.value.length} of ${listing.entries.value.length} items`);

const sizeStyle = computed(() =>
  dialogSize ? { width: `${dialogSize.w}px`, height: `${dialogSize.h}px` } : { width: '80vw', height: '80vh' },
);

async function navigate(path: string, mode: 'push' | 'history' = 'push', keepOnError = false): Promise<void> {
  cancelFolderTask();
  let result;
  try {
    result = await listing.load(path, { keepOnError });
  } catch (error) {
    pathError.value = en.pathError((error as Error).message);
    return;
  }
  if (result === 'cancelled') {
    return;
  }
  query.value = '';
  editingPath.value = false;
  pathError.value = null;
  focusIndex.value = visible.value.length > 0 ? 0 : -1;
  const actual = listing.state.path;
  if (mode === 'push' && history.value[historyIndex.value] !== actual) {
    history.value = [...history.value.slice(0, historyIndex.value + 1), actual];
    historyIndex.value = history.value.length - 1;
  }
  if (result === 'ok') {
    prefs.recent = [actual, ...prefs.recent.filter((entry) => entry !== actual)].slice(0, RECENT_LIMIT);
    setPref('recent', prefs.recent);
  }
}

function goHistory(delta: number): void {
  const next = historyIndex.value + delta;
  if (next >= 0 && next < history.value.length) {
    historyIndex.value = next;
    void navigate(history.value[next], 'history');
  }
}

function goUp(): void {
  const parent = listing.state.parent ?? parentPath(listing.state.path);
  if (parent && parent !== listing.state.path) {
    void navigate(parent);
  }
}

function goHome(): void {
  if (places.value) {
    void navigate(places.value.home);
  }
}

function refresh(): void {
  void listing.load(listing.state.path, { force: true });
}

function startEditPath(): void {
  pathDraft.value = listing.state.path;
  pathError.value = null;
  editingPath.value = true;
}

function submitPath(): void {
  const raw = pathDraft.value.trim();
  if (raw) {
    void navigate(raw, 'push', true);
  }
}

function stopEditPath(): void {
  editingPath.value = false;
  pathError.value = null;
  focusView();
}

function toggleFavorite(): void {
  const path = listing.state.path;
  prefs.favorites = isFavorite.value ? prefs.favorites.filter((entry) => entry !== path) : [...prefs.favorites, path];
  setPref('favorites', prefs.favorites);
}

function removeFavorite(path: string): void {
  prefs.favorites = prefs.favorites.filter((entry) => entry !== path);
  setPref('favorites', prefs.favorites);
}

function setView(next: 'grid' | 'list'): void {
  prefs.view = next;
  setPref('view', next);
}

function setThumbSize(size: ThumbSize): void {
  prefs.thumbSize = size;
  setPref('thumbSize', size);
}

function setSort(key: SortKey, dir = prefs.sort.dir): void {
  prefs.sort = { key, dir };
  setPref('sort', prefs.sort);
}

function sortByHeader(key: SortKey): void {
  setSort(key, prefs.sort.key === key && prefs.sort.dir === 'asc' ? 'desc' : 'asc');
}

function toggleHidden(): void {
  prefs.showHidden = !prefs.showHidden;
  setPref('showHidden', prefs.showHidden);
  void listing.load(listing.state.path);
}

function openSortMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const mark = (on: boolean) => (on ? '✓ ' : ' ');
  menu.value = {
    x: rect.left,
    y: rect.bottom + 2,
    items: [
      ...(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
        label: `${mark(prefs.sort.key === key)}${SORT_LABELS[key]}`,
        action: () => setSort(key),
      })),
      { label: `${mark(prefs.sort.dir === 'asc')}Ascending`, action: () => setSort(prefs.sort.key, 'asc') },
      { label: `${mark(prefs.sort.dir === 'desc')}Descending`, action: () => setSort(prefs.sort.key, 'desc') },
    ],
  };
}

function fileIndex(path: string | null): number {
  return path === null ? -1 : visibleFiles.value.findIndex((file) => file.path === path);
}

function selectFile(file: FileEntry, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
  if (singlePick.value) {
    selection.value = sel.selectOnly(file);
  } else if (event.shiftKey && fileIndex(anchor.value) >= 0) {
    selection.value = sel.selectRange(selection.value, visibleFiles.value, fileIndex(anchor.value), fileIndex(file.path));
    return;
  } else if (isMod(event as MouseEvent)) {
    selection.value = sel.toggle(selection.value, file);
  } else {
    selection.value = sel.selectOnly(file);
  }
  anchor.value = file.path;
}

function onItemClick(index: number, event: MouseEvent): void {
  focusIndex.value = index;
  focusView();
  const entry = visible.value[index];
  if (entry?.type === 'file') {
    selectFile(entry, event);
  }
}

function onItemToggle(index: number): void {
  const entry = visible.value[index];
  if (entry?.type !== 'file') {
    return;
  }
  focusIndex.value = index;
  selection.value = singlePick.value ? sel.selectOnly(entry) : sel.toggle(selection.value, entry);
  anchor.value = entry.path;
}

function openEntry(index: number): void {
  const entry = visible.value[index];
  if (entry?.type === 'dir') {
    void navigate(entry.path);
  } else if (entry) {
    confirm([entry]);
  }
}

function onItemContext(index: number, event: MouseEvent): void {
  focusIndex.value = index;
  const entry = visible.value[index];
  if (!entry) {
    return;
  }
  const items: MenuItem[] =
    entry.type === 'dir'
      ? [
          { label: 'Open', action: () => navigate(entry.path) },
          { label: 'Add all media in folder', action: () => addFolder(entry.path), disabled: singlePick.value },
          { label: 'Add recursively…', action: () => addRecursive(entry.path), disabled: singlePick.value },
          {
            label: prefs.favorites.includes(entry.path) ? 'Remove from favorites' : 'Add to favorites',
            action: () => {
              prefs.favorites = prefs.favorites.includes(entry.path)
                ? prefs.favorites.filter((path) => path !== entry.path)
                : [...prefs.favorites, entry.path];
              setPref('favorites', prefs.favorites);
            },
          },
        ]
      : [
          { label: singlePick.value ? en.replaceWith : 'Add this file', action: () => confirm([entry]) },
          {
            label: selection.value.has(entry.path) ? 'Deselect' : 'Select',
            action: () => onItemToggle(index),
          },
        ];
  menu.value = { x: event.clientX, y: event.clientY, items };
}

function accepts(file: FileEntry): boolean {
  return kindFilter.value === 'all' || file.kind === kindFilter.value;
}

function cancelFolderTask(): void {
  folderTask?.abort();
  folderTask = null;
  if (notice.value?.confirm || notice.value?.tone === 'info') {
    notice.value = null;
  }
}

async function addFolder(path: string): Promise<void> {
  cancelFolderTask();
  try {
    const files = filesOf((await listFolder(path, { hidden: prefs.showHidden })).entries).filter(accepts);
    if (files.length === 0) {
      notice.value = { tone: 'info', text: en.noMedia };
    } else {
      confirm(files);
    }
  } catch (error) {
    notice.value = { tone: 'error', text: (error as Error).message };
  }
}

async function addRecursive(path: string): Promise<void> {
  cancelFolderTask();
  const task = new AbortController();
  folderTask = task;
  notice.value = { tone: 'info', text: en.recursiveCounting(0) };
  try {
    const files = await collectRecursive(path, {
      hidden: prefs.showHidden,
      accept: accepts,
      signal: task.signal,
      onProgress: (count) => {
        if (folderTask === task) {
          notice.value = { tone: 'info', text: en.recursiveCounting(count) };
        }
      },
    });
    if (folderTask !== task) {
      return;
    }
    folderTask = null;
    notice.value =
      files.length === 0
        ? { tone: 'info', text: en.recursiveNone }
        : { tone: 'warning', text: en.recursiveConfirm(files.length, baseName(path)), confirm: () => confirm(files) };
  } catch (error) {
    if ((error as Error).name !== 'AbortError' && folderTask === task) {
      notice.value = { tone: 'error', text: (error as Error).message };
    }
  }
}

function confirm(files: FileEntry[]): void {
  const chosen = singlePick.value ? files.filter((file) => file.kind === props.request.kind).slice(0, 1) : files;
  if (chosen.length > 0) {
    emit('confirm', chosen);
  }
}

function confirmSelection(): void {
  if (canAdd.value) {
    confirm([...selection.value.values()]);
  }
}

function focusView(): void {
  void nextTick(() => view.value?.focus({ preventScroll: true }));
}

function moveFocus(event: KeyboardEvent): boolean {
  const columns = prefs.view === 'grid' ? (grid.value?.columns ?? 1) : 1;
  const deltas: Record<string, number> = { ArrowUp: -columns, ArrowDown: columns };
  if (prefs.view === 'grid') {
    deltas.ArrowLeft = -1;
    deltas.ArrowRight = 1;
  }
  const delta = deltas[event.key];
  if (delta === undefined || visible.value.length === 0) {
    return false;
  }
  event.preventDefault();
  const previous = visible.value[focusIndex.value];
  const next = Math.max(0, Math.min(visible.value.length - 1, focusIndex.value < 0 ? 0 : focusIndex.value + delta));
  focusIndex.value = next;
  const entry = visible.value[next];
  if (event.shiftKey && !singlePick.value && entry.type === 'file') {
    if (fileIndex(anchor.value) < 0 && previous?.type === 'file') {
      anchor.value = previous.path;
    }
    const from = fileIndex(anchor.value);
    selection.value = sel.selectRange(selection.value, visibleFiles.value, from < 0 ? fileIndex(entry.path) : from, fileIndex(entry.path));
  }
  return true;
}

function onKey(event: KeyboardEvent): void {
  if (menu.value) {
    return;
  }
  const target = event.target as HTMLElement | null;
  const role = target?.dataset?.role;
  const mod = isMod(event);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (key === 'Escape') {
    event.preventDefault();
    if (role === 'path') {
      stopEditPath();
    } else if (role === 'search' && query.value) {
      query.value = '';
    } else if (folderTask || notice.value?.confirm) {
      cancelFolderTask();
    } else {
      emit('close');
    }
    return;
  }
  if (role === 'path') {
    if (key === 'Enter') {
      event.preventDefault();
      submitPath();
    }
    return;
  }
  if (mod && (key === 'f' || key === 'l' || key === 'r')) {
    event.preventDefault();
    if (key === 'f') {
      search.value?.focus();
      search.value?.select();
    } else if (key === 'l') {
      startEditPath();
    } else {
      refresh();
    }
    return;
  }
  if (role === 'search') {
    if (key === 'ArrowDown' || key === 'Enter') {
      event.preventDefault();
      focusIndex.value = Math.max(0, focusIndex.value);
      focusView();
    }
    return;
  }
  if (isTextInput(target)) {
    return;
  }
  if (mod && key === 'a') {
    event.preventDefault();
    if (!singlePick.value) {
      selection.value = sel.selectAll(selection.value, visibleFiles.value);
    }
    return;
  }
  if (key === 'Backspace' || (mod && key === 'ArrowUp')) {
    event.preventDefault();
    goUp();
    return;
  }
  // Buttons and other controls in the dialog keep their native keys; focus outside the dialog acts as the view.
  if (target && dialog.value?.contains(target) && !view.value?.contains(target)) {
    return;
  }
  if (moveFocus(event)) {
    return;
  }
  const entry = visible.value[focusIndex.value];
  if (key === 'Enter' && entry) {
    event.preventDefault();
    if (entry.type === 'dir') {
      void navigate(entry.path);
    } else if (selection.value.size > 0 && selection.value.has(entry.path)) {
      confirmSelection();
    } else {
      confirm([entry]);
    }
  } else if (key === ' ' && entry?.type === 'file') {
    event.preventDefault();
    onItemToggle(focusIndex.value);
  }
}

useKeyboardScope(ref(true), onKey);

function saveSize(): void {
  const element = dialog.value;
  if (!element) {
    return;
  }
  const size = { w: element.offsetWidth, h: element.offsetHeight };
  const current = getPref('dialogSize');
  const initial = dialogSize ?? null;
  const reference = current ?? initial;
  if (reference ? Math.abs(reference.w - size.w) > 2 || Math.abs(reference.h - size.h) > 2 : element.style.width !== '80vw' || element.style.height !== '80vh') {
    setPref('dialogSize', size);
  }
}

onMounted(async () => {
  focusView();
  try {
    places.value = await getPlaces();
  } catch (error) {
    notice.value = { tone: 'error', text: (error as Error).message };
    return;
  }
  const request = props.request;
  if (request.mode === 'replace' && request.startPath) {
    await navigate(request.startPath);
    if (!listing.state.error) {
      focusView();
      return;
    }
  }
  await navigate(places.value.start);
  focusView();
});
</script>

<template>
  <Teleport to="body">
    <div class="aala-media aala-backdrop">
      <div
        ref="dialog"
        class="aala-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :style="sizeStyle"
        @pointerup="saveSize"
      >
        <header class="aala-dialog__head">
          <div class="aala-toolbar">
            <button type="button" class="aala-icon-btn" title="Back" aria-label="Back" :disabled="historyIndex <= 0" @click="goHistory(-1)">
              <Icon name="back" />
            </button>
            <button
              type="button"
              class="aala-icon-btn"
              title="Forward"
              aria-label="Forward"
              :disabled="historyIndex >= history.length - 1"
              @click="goHistory(1)"
            >
              <Icon name="forward" />
            </button>
            <button type="button" class="aala-icon-btn" title="Up (Backspace)" aria-label="Up" :disabled="!listing.state.parent" @click="goUp">
              <Icon name="up" />
            </button>
            <button type="button" class="aala-icon-btn" title="Refresh (Cmd+R)" aria-label="Refresh" @click="refresh">
              <Icon name="refresh" />
            </button>
            <PathBar
              v-model:draft="pathDraft"
              :path="listing.state.path"
              :editing="editingPath"
              :error="pathError"
              @navigate="navigate"
              @edit="startEditPath"
            />
            <button
              type="button"
              class="aala-icon-btn"
              :class="{ 'aala-icon-btn--on': isFavorite }"
              :title="isFavorite ? 'Remove from favorites' : 'Add to favorites'"
              :aria-pressed="isFavorite"
              aria-label="Favorite this folder"
              @click="toggleFavorite"
            >
              <Icon name="star" />
            </button>
            <button type="button" class="aala-icon-btn" title="Close (Escape)" aria-label="Close" @click="emit('close')">
              <Icon name="close" />
            </button>
          </div>
          <div class="aala-toolbar aala-toolbar--filters">
            <label class="aala-search">
              <Icon name="search" :size="14" />
              <input ref="search" v-model="query" type="search" placeholder="Search this folder" aria-label="Search" data-role="search" />
            </label>
            <div v-if="!singlePick" class="aala-chips" role="group" aria-label="Kind filter">
              <button
                v-for="kind in ['all', ...KINDS] as KindFilter[]"
                :key="kind"
                type="button"
                class="aala-chip"
                :class="{ 'aala-chip--on': kindFilter === kind }"
                :aria-pressed="kindFilter === kind"
                @click="kindFilter = kind"
              >
                {{ kind === 'all' ? 'All' : KIND_LABEL[kind] }}
              </button>
            </div>
            <span class="aala-spacer" />
            <button type="button" class="aala-btn" title="Sort" @click="openSortMenu">
              <Icon name="sort" :size="14" />
              {{ SORT_LABELS[prefs.sort.key] }} {{ prefs.sort.dir === 'asc' ? '▲' : '▼' }}
            </button>
            <div class="aala-segmented" role="group" aria-label="View">
              <button type="button" class="aala-icon-btn" :class="{ 'aala-icon-btn--on': prefs.view === 'grid' }" title="Grid" aria-label="Grid view" @click="setView('grid')">
                <Icon name="grid" />
              </button>
              <button type="button" class="aala-icon-btn" :class="{ 'aala-icon-btn--on': prefs.view === 'list' }" title="List" aria-label="List view" @click="setView('list')">
                <Icon name="list" />
              </button>
            </div>
            <div v-if="prefs.view === 'grid'" class="aala-segmented" role="group" aria-label="Thumbnail size">
              <button
                v-for="size in ['s', 'm', 'l'] as ThumbSize[]"
                :key="size"
                type="button"
                class="aala-icon-btn aala-icon-btn--text"
                :class="{ 'aala-icon-btn--on': prefs.thumbSize === size }"
                :aria-label="`Thumbnail size ${size}`"
                @click="setThumbSize(size)"
              >
                {{ size.toUpperCase() }}
              </button>
            </div>
            <button
              type="button"
              class="aala-icon-btn"
              :class="{ 'aala-icon-btn--on': prefs.showHidden }"
              :aria-pressed="prefs.showHidden"
              title="Show hidden files"
              aria-label="Show hidden files"
              @click="toggleHidden"
            >
              <Icon name="eye" />
            </button>
          </div>
        </header>

        <div class="aala-dialog__body">
          <PlacesSidebar
            :places="places"
            :favorites="prefs.favorites"
            :recent="prefs.recent"
            :current="listing.state.path"
            @navigate="navigate"
            @remove-favorite="removeFavorite"
          />
          <div class="aala-dialog__main">
            <StatusBanner v-if="notice" :tone="notice.tone" :text="notice.text" :dismissible="!notice.confirm" @dismiss="cancelFolderTask(); notice = null">
              <template v-if="notice.confirm">
                <button type="button" class="aala-btn aala-btn--primary" @click="notice.confirm()">Add</button>
                <button type="button" class="aala-btn" @click="notice = null">Cancel</button>
              </template>
            </StatusBanner>
            <div
              ref="view"
              class="aala-view"
              tabindex="0"
              role="grid"
              :aria-multiselectable="!singlePick"
              :aria-activedescendant="focusIndex >= 0 ? `${idPrefix}-${focusIndex}` : undefined"
              aria-label="Folder contents"
            >
              <div v-if="listing.state.error" class="aala-state aala-state--error" role="alert">
                <Icon name="warning" :size="28" />
                <p>{{ en.errors[listing.state.error.code] ?? en.errors.io_error }}</p>
                <p class="aala-state__detail">{{ listing.state.error.message }}</p>
                <div class="aala-state__actions">
                  <button type="button" class="aala-btn aala-btn--primary" @click="navigate(listing.state.path, 'history')">Retry</button>
                  <button type="button" class="aala-btn" @click="goHome">Go to Home</button>
                </div>
              </div>
              <div v-else-if="listing.state.loading && listing.entries.value.length === 0" class="aala-skeletons" aria-busy="true">
                <span v-for="index in SKELETONS" :key="index" class="aala-skeleton" />
              </div>
              <div v-else-if="visible.length === 0" class="aala-state">
                <Icon name="folder" :size="28" />
                <p>{{ emptyText }}</p>
              </div>
              <FileGrid
                v-else-if="prefs.view === 'grid'"
                ref="grid"
                :entries="visible"
                :focus-index="focusIndex"
                :selection="selection"
                :added-paths="addedPaths"
                :thumb-size="prefs.thumbSize"
                :id-prefix="idPrefix"
                @item-click="onItemClick"
                @item-open="openEntry"
                @item-toggle="onItemToggle"
                @item-context="onItemContext"
              />
              <FileList
                v-else
                :entries="visible"
                :focus-index="focusIndex"
                :selection="selection"
                :added-paths="addedPaths"
                :sort="prefs.sort"
                :id-prefix="idPrefix"
                @item-click="onItemClick"
                @item-open="openEntry"
                @item-toggle="onItemToggle"
                @item-context="onItemContext"
                @sort-by="sortByHeader"
              />
            </div>
          </div>
        </div>

        <footer class="aala-dialog__foot">
          <span class="aala-dialog__status">{{ statusText }}</span>
          <template v-if="!singlePick">
            <button type="button" class="aala-btn aala-btn--ghost" :disabled="visibleFiles.length === 0" title="Select all (Cmd+A)" @click="selection = sel.selectAll(selection, visibleFiles)">Select all</button>
            <button type="button" class="aala-btn aala-btn--ghost" :disabled="visibleFiles.length === 0" @click="selection = sel.invert(selection, visibleFiles)">Invert</button>
          </template>
          <button type="button" class="aala-btn aala-btn--ghost" :disabled="selection.size === 0" @click="selection = new Map()">Clear</button>
          <span class="aala-spacer" />
          <strong class="aala-dialog__count">{{ en.selected(selection.size) }}</strong>
          <button type="button" class="aala-btn" @click="emit('close')">Cancel</button>
          <button type="button" class="aala-btn aala-btn--primary" :disabled="!canAdd" @click="confirmSelection">{{ confirmLabel }}</button>
        </footer>
      </div>
      <Menu v-if="menu" :items="menu.items" :x="menu.x" :y="menu.y" @close="menu = null" />
    </div>
  </Teleport>
</template>
