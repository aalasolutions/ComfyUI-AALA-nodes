import { reactive } from 'vue';
import { apiURL, fetchApi } from '../comfy/host';
import type { MediaKind } from '../state/schema';

const BASE = '/aala-media/fs';
const PROBE_BATCH = 500;
const PROBE_DELAY_MS = 180;

export interface Place {
  label: string;
  path: string;
}

export interface Places {
  home: string;
  start: string;
  places: Place[];
  volumes: Place[];
  comfy: { input: string; output: string; temp: string };
  kinds: Record<MediaKind, string[]>;
}

export interface DirEntry {
  type: 'dir';
  name: string;
  path: string;
  mtime: number;
}

export interface FileEntry {
  type: 'file';
  name: string;
  path: string;
  kind: MediaKind;
  size: number;
  mtime: number;
}

export type Entry = DirEntry | FileEntry;

export interface ListPage {
  path: string;
  parent: string | null;
  mtime: number;
  entries: Entry[];
  skipped: number;
}

export interface MediaMeta {
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  fps?: string;
  frames?: number;
  duration?: number;
  has_audio?: boolean;
  sample_rate?: number;
  channels?: number;
}

export type ProbeResult = MediaMeta | { missing: true } | { error: string };

export interface Peaks {
  sample_rate: number;
  duration: number;
  channels: number;
  peaks: number[];
}

export class FsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchApi(`${BASE}${route}`, init);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw error;
    }
    throw new FsRequestError('network', 'Could not reach the ComfyUI server.', 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : 'io_error';
    const message = typeof body?.message === 'string' ? body.message : `Request failed (${response.status})`;
    throw new FsRequestError(code, message, response.status);
  }
  return body as T;
}

let placesPromise: Promise<Places> | null = null;

export function getPlaces(): Promise<Places> {
  placesPromise ??= request<Places>('/places').catch((error) => {
    placesPromise = null;
    throw error;
  });
  return placesPromise;
}

export function listFolder(path: string, options: { signal?: AbortSignal } = {}): Promise<ListPage> {
  const query = new URLSearchParams({ path });
  return request<ListPage>(`/list?${query}`, { signal: options.signal });
}

export async function probePaths(paths: string[]): Promise<Record<string, ProbeResult>> {
  const result: Record<string, ProbeResult> = {};
  for (let start = 0; start < paths.length; start += PROBE_BATCH) {
    const chunk = paths.slice(start, start + PROBE_BATCH);
    Object.assign(
      result,
      await request<Record<string, ProbeResult>>('/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      }),
    );
  }
  return result;
}

export function isMeta(result: ProbeResult | undefined): result is MediaMeta {
  return !!result && !('missing' in result) && !('error' in result);
}

// Shared lazy probe cache for display. Keyed by path and mtime so a changed file is probed again.
const probeCache = reactive(new Map<string, ProbeResult | null>());
const probeQueue = new Set<string>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;

function probeKey(path: string, mtime: number): string {
  return `${mtime}|${path}`;
}

export function cachedProbe(path: string, mtime: number): ProbeResult | null | undefined {
  return probeCache.get(probeKey(path, mtime));
}

export function wantProbe(path: string, mtime: number): void {
  const key = probeKey(path, mtime);
  if (probeCache.has(key)) {
    return;
  }
  probeQueue.add(key);
  probeTimer ??= setTimeout(flushProbes, PROBE_DELAY_MS);
}

async function flushProbes(): Promise<void> {
  probeTimer = null;
  const keys = [...probeQueue];
  probeQueue.clear();
  for (const key of keys) {
    probeCache.set(key, null);
  }
  const paths = keys.map((key) => key.slice(key.indexOf('|') + 1));
  try {
    const results = await probePaths(paths);
    keys.forEach((key, index) => probeCache.set(key, results[paths[index]] ?? { error: 'no result' }));
  } catch {
    keys.forEach((key) => probeCache.delete(key));
  }
}

const peaksCache = new Map<string, Promise<Peaks | null>>();

export function getPeaks(path: string, mtime: number, buckets: number): Promise<Peaks | null> {
  const key = `${mtime}|${buckets}|${path}`;
  let pending = peaksCache.get(key);
  if (!pending) {
    const query = new URLSearchParams({ path, buckets: String(buckets) });
    pending = request<Peaks>(`/peaks?${query}`).catch(() => null);
    peaksCache.set(key, pending);
  }
  return pending;
}

export function thumbUrl(path: string, mtime: number, size = 256): string {
  return apiURL(`${BASE}/thumb?${new URLSearchParams({ path, size: String(size), v: String(mtime) })}`);
}

export function fileUrl(path: string): string {
  return apiURL(`${BASE}/file?${new URLSearchParams({ path })}`);
}

export function parentPath(path: string): string | null {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const index = trimmed.lastIndexOf('/');
  if (index < 0 || trimmed === '/') {
    return null;
  }
  return index === 0 ? '/' : trimmed.slice(0, index);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}

export async function nearestExistingFolder(path: string): Promise<string | null> {
  let candidate = parentPath(path);
  while (candidate) {
    try {
      await listFolder(candidate);
      return candidate;
    } catch {
      candidate = parentPath(candidate);
    }
  }
  return null;
}
