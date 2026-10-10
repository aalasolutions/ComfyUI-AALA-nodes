import { reactive, shallowRef } from 'vue';
import { FsRequestError, listFolder, type Entry, type FileEntry, type ListPage } from '../api/fs';

// Guards against symlink cycles, whose paths grow without repeating.
const MAX_DEPTH = 32;

export type LoadResult = 'ok' | 'error' | 'cancelled';

// Listings per folder, shared by all dialogs on the page.
const cache = new Map<string, ListPage>();

function toFsError(error: unknown): FsRequestError {
  return error instanceof FsRequestError ? error : new FsRequestError('io_error', String(error), 500);
}

/** Folder listing with a client cache (refreshed in the background), cancellation and inline errors. */
export function useFolderListing() {
  const state = reactive({
    path: '',
    parent: null as string | null,
    skipped: 0,
    loading: false,
    error: null as FsRequestError | null,
  });
  // Large arrays stay shallow so tens of thousands of entries are not made deeply reactive.
  const entries = shallowRef<Entry[]>([]);
  let generation = 0;
  let controller: AbortController | null = null;

  function apply(page: ListPage): void {
    state.path = page.path;
    state.parent = page.parent;
    state.skipped = page.skipped;
    state.error = null;
    entries.value = page.entries;
  }

  /**
   * Loads `path`. A cached listing shows at once and is replaced when the server reports a newer folder mtime.
   * With `keepOnError`, a failure leaves the current listing untouched and is thrown to the caller (path bar);
   * otherwise the error is shown in place of the listing.
   */
  async function load(path: string, options: { keepOnError?: boolean; force?: boolean } = {}): Promise<LoadResult> {
    controller?.abort();
    const ticket = ++generation;
    const local = new AbortController();
    controller = local;
    const cached = options.force ? undefined : cache.get(path);
    // With keepOnError the cached listing is not shown up front, so the fresh page must always be applied.
    const shown = cached && !options.keepOnError ? cached : undefined;
    if (shown) {
      apply(shown);
    }
    state.loading = true;

    let page: ListPage;
    try {
      page = await listFolder(path, { signal: local.signal });
    } catch (error) {
      if (ticket !== generation || (error as Error).name === 'AbortError') {
        return 'cancelled';
      }
      state.loading = false;
      const failure = toFsError(error);
      if (options.keepOnError) {
        throw failure;
      }
      cache.delete(path);
      state.path = path;
      state.parent = null;
      state.error = failure;
      entries.value = [];
      return 'error';
    }
    if (ticket !== generation) {
      return 'cancelled';
    }
    state.loading = false;
    cache.set(page.path, page);
    if (!shown || shown.mtime !== page.mtime || shown.path !== page.path) {
      apply(page);
    }
    return 'ok';
  }

  return { state, entries, load };
}

/** Collects media files under `path`, breadth first. `onProgress` receives the running count. */
export async function collectRecursive(
  path: string,
  options: { accept: (file: FileEntry) => boolean; signal: AbortSignal; onProgress: (count: number) => void },
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  const queue: [string, number][] = [[path, 0]];
  while (queue.length > 0) {
    const [folder, depth] = queue.shift() as [string, number];
    let entries: Entry[];
    try {
      entries = (await listFolder(folder, { signal: options.signal })).entries;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.type === 'dir') {
        if (depth < MAX_DEPTH) {
          queue.push([entry.path, depth + 1]);
        }
      } else if (options.accept(entry)) {
        files.push(entry);
      }
    }
    options.onProgress(files.length);
  }
  return files;
}
