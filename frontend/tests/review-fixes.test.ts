import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ListPage } from '../src/api/fs';

const pages = new Map<string, ListPage>();
vi.mock('../src/api/fs', async (original) => ({
  ...(await original<typeof import('../src/api/fs')>()),
  listFolder: vi.fn(async (path: string) => {
    const page = pages.get(path);
    if (!page) {
      throw new Error(`no page for ${path}`);
    }
    return page;
  }),
}));

const { useFolderListing } = await import('../src/composables/useFolderListing');
const { createMediaStore } = await import('../src/state/store');
const { outputIndexes, createItem } = await import('../src/state/items');

const page = (path: string, mtime = 1): ListPage => ({ path, parent: '/', mtime, entries: [], skipped: 0 });

describe('folder listing', () => {
  beforeEach(() => pages.clear());

  it('path bar navigation to a cached folder lands there (keepOnError)', async () => {
    pages.set('/vf', page('/vf'));
    pages.set('/in', page('/in'));
    const listing = useFolderListing(ref(false));
    await listing.load('/vf');
    await listing.load('/in');
    expect(listing.state.path).toBe('/in');
    await listing.load('/vf', { keepOnError: true });
    expect(listing.state.path).toBe('/vf');
  });

  it('a failed path bar navigation keeps the current folder', async () => {
    pages.set('/in', page('/in'));
    const listing = useFolderListing(ref(false));
    await listing.load('/in');
    await expect(listing.load('/nope', { keepOnError: true })).rejects.toBeTruthy();
    expect(listing.state.path).toBe('/in');
  });
});

describe('store commit', () => {
  it('records no undo step when nothing changed', () => {
    const onCommit = vi.fn();
    const store = createMediaStore(onCommit);
    store.addItems([{ path: '/a.png', kind: 'image' }, { path: '/b.png', kind: 'image' }]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [a] = store.data.state.groups.image;
    store.moveItem('image', a.id, 0);
    store.setActive('image', new Set([a.id]), true);
    store.setLimit('image', 9);
    store.setMuted('image', new Set([a.id]), true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    store.moveItem('image', a.id, 1);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});

describe('output indexes', () => {
  it('skips missing items and muted audio without shifting later items', () => {
    const images = ['/1.png', '/2.png', '/3.png'].map((path) => createItem({ path, kind: 'image' }, true));
    const indexes = outputIndexes(images, (item) => item.path === '/2.png');
    expect(images.map((item) => indexes.get(item.id))).toEqual([0, undefined, 1]);

    const audio = ['/a.wav', '/b.wav'].map((path) => createItem({ path, kind: 'audio' }, true));
    audio[0].muted = true;
    const audioIndexes = outputIndexes(audio);
    expect(audio.map((item) => audioIndexes.get(item.id))).toEqual([undefined, 0]);

    const video = createItem({ path: '/v.mp4', kind: 'video' }, true);
    video.muted = true;
    expect(outputIndexes([video]).get(video.id)).toBe(0);
  });
});
