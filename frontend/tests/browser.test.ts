import { describe, expect, it } from 'vitest';
import type { Entry, FileEntry } from '../src/api/fs';
import { filesOf, filterEntries, sortEntries } from '../src/browser/listing';
import * as sel from '../src/browser/selection';

const f = (name: string, size = 1, mtime = 1, kind: FileEntry['kind'] = 'image'): FileEntry => ({
  type: 'file',
  name,
  path: `/x/${name}`,
  kind,
  size,
  mtime,
});
const d = (name: string, mtime = 1): Entry => ({ type: 'dir', name, path: `/x/${name}`, mtime });

describe('sorting and filtering', () => {
  const entries: Entry[] = [f('clip10.mp4', 5, 3, 'video'), d('b'), f('clip2.mp4', 9, 1, 'video'), d('a'), f('z.png', 1, 2)];

  it('natural name sort with folders first, both directions', () => {
    expect(sortEntries(entries, { key: 'name', dir: 'asc' }).map((e) => e.name)).toEqual(['a', 'b', 'clip2.mp4', 'clip10.mp4', 'z.png']);
    expect(sortEntries(entries, { key: 'name', dir: 'desc' }).map((e) => e.name)).toEqual(['b', 'a', 'z.png', 'clip10.mp4', 'clip2.mp4']);
  });

  it('sorts files by size, date and kind', () => {
    const names = (key: 'size' | 'mtime' | 'kind') => filesOf(sortEntries(entries, { key, dir: 'asc' })).map((e) => e.name);
    expect(names('size')).toEqual(['z.png', 'clip10.mp4', 'clip2.mp4']);
    expect(names('mtime')).toEqual(['clip2.mp4', 'z.png', 'clip10.mp4']);
    expect(names('kind')).toEqual(['z.png', 'clip2.mp4', 'clip10.mp4']);
  });

  it('filters by query and kind but keeps folders for kind filters', () => {
    expect(filterEntries(entries, 'CLIP', 'all').map((e) => e.name)).toEqual(['clip10.mp4', 'clip2.mp4']);
    expect(filterEntries(entries, '', 'image').map((e) => e.name)).toEqual(['b', 'a', 'z.png']);
  });
});

describe('selection', () => {
  const files = [f('1'), f('2'), f('3'), f('4')];

  it('click, toggle, range, all and invert', () => {
    let selection = sel.selectOnly(files[0]);
    selection = sel.toggle(selection, files[2]);
    expect([...selection.keys()]).toEqual(['/x/1', '/x/3']);
    selection = sel.toggle(selection, files[0]);
    expect([...selection.keys()]).toEqual(['/x/3']);
    expect(sel.selectRange(new Map(), files, 3, 1).size).toBe(3);
    expect(sel.selectAll(new Map(), files).size).toBe(4);
    expect([...sel.invert(sel.selectOnly(files[1]), files).keys()]).toEqual(['/x/1', '/x/3', '/x/4']);
  });

  it('keeps entries from other folders when selecting here', () => {
    const elsewhere: FileEntry = { ...f('far'), path: '/y/far' };
    const selection = sel.selectAll(sel.selectOnly(elsewhere), files);
    expect(selection.has('/y/far')).toBe(true);
    expect(sel.invert(selection, files).has('/y/far')).toBe(true);
  });
});
