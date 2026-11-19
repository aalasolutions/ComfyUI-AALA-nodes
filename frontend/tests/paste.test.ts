import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyNode } from '../src/comfy/host';
import { clipboardImages, imageExtension, isPasteTarget, splitSupported, uploadedPath } from '../src/comfy/paste';
import * as items from '../src/state/items';
import { defaultState } from '../src/state/schema';

const canvas: { selected_nodes: Record<string, unknown> } = { selected_nodes: {} };
vi.mock('../src/comfy/host', async (original) => ({
  ...(await original<typeof import('../src/comfy/host')>()),
  getApp: () => ({ canvas }),
}));

const png = (name = 'image.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png', lastModified: 1 });
const item = (file: File | null, kind = 'file') => ({ kind, type: file?.type ?? 'text/plain', getAsFile: () => file });

describe('clipboard image extraction', () => {
  it('takes bitmap items', () => {
    const bitmap = png();
    expect(clipboardImages({ items: [item(bitmap)], files: [] })).toEqual([bitmap]);
  });

  it('takes copied files and drops non-images', () => {
    const photo = png('photo.png');
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    expect(clipboardImages({ items: [], files: [photo, text] })).toEqual([photo]);
  });

  it('keeps one copy when a file is listed in items and files, and ignores string items', () => {
    const a = png('a.png');
    const sameA = png('a.png');
    const b = new File([new Uint8Array([9])], 'b.jpg', { type: 'image/jpeg', lastModified: 2 });
    const result = clipboardImages({ items: [item(a), item(null, 'string')], files: [sameA, b] });
    expect(result).toEqual([a, b]);
  });

  it('returns nothing for text-only or missing clipboard data', () => {
    expect(clipboardImages({ items: [item(null, 'string')], files: [] })).toEqual([]);
    expect(clipboardImages(null)).toEqual([]);
  });
});

describe('pasted image naming and support', () => {
  it('reads the extension from the name, else the MIME subtype', () => {
    expect(imageExtension({ name: 'Shot.JPG', type: 'image/jpeg' })).toBe('jpg');
    expect(imageExtension({ name: '', type: 'image/webp' })).toBe('webp');
  });

  it('splits unsupported types out', () => {
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    const shot = png();
    expect(splitSupported([shot, svg], ['png', 'jpg'])).toEqual({ supported: [shot], unsupported: [svg] });
  });

  it('builds the absolute input path from the upload response', () => {
    expect(uploadedPath('/c/input/', { name: 'image (1).png', subfolder: 'pasted' })).toBe('/c/input/pasted/image (1).png');
    expect(uploadedPath('/c/input', { name: 'a.png', subfolder: '' })).toBe('/c/input/a.png');
  });
});

describe('adding pasted images', () => {
  it('appends at the end and adds inactive once Max is full', () => {
    const state = defaultState();
    state.limits.image = 2;
    items.addItems(state, [{ path: '/a.png', kind: 'image' }]);
    const report = items.addItems(state, [
      { path: '/in/pasted/image.png', kind: 'image' },
      { path: '/in/pasted/image (1).png', kind: 'image' },
    ]);
    expect(report.image).toEqual({ added: 2, inactive: 1 });
    expect(state.groups.image.map((entry) => [entry.path, entry.active])).toEqual([
      ['/a.png', true],
      ['/in/pasted/image.png', true],
      ['/in/pasted/image (1).png', false],
    ]);
  });
});

class FakeElement {
  isContentEditable = false;
  constructor(
    readonly className = '',
    readonly parent: FakeElement | null = null,
  ) {}
  contains(other: FakeElement): boolean {
    for (let at: FakeElement | null = other; at; at = at.parent) {
      if (at === this) {
        return true;
      }
    }
    return false;
  }
  closest(selector: string): FakeElement | null {
    const name = selector.slice(1);
    for (let at: FakeElement | null = this; at; at = at.parent) {
      if (at.className.split(' ').includes(name)) {
        return at;
      }
    }
    return null;
  }
}

describe('paste target', () => {
  const nodeA = { id: 1 } as unknown as ComfyNode;
  const nodeB = { id: 2 } as unknown as ComfyNode;
  const body = new FakeElement();
  const widgetA = new FakeElement('aala-media', body);
  const widgetB = new FakeElement('aala-media', body);
  const cardA = new FakeElement('aala-card', widgetA);
  const owns = (node: ComfyNode, widget: FakeElement, target: FakeElement) =>
    isPasteTarget(node, widget as unknown as HTMLElement, { target } as unknown as Event);

  beforeEach(() => {
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLInputElement', class {});
    vi.stubGlobal('HTMLTextAreaElement', class {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('goes to the widget that holds focus, not to the selected node', () => {
    canvas.selected_nodes = { 2: nodeB };
    expect(owns(nodeA, widgetA, cardA)).toBe(true);
    expect(owns(nodeB, widgetB, cardA)).toBe(false);
  });

  it('goes to the only selected node when focus is outside every widget', () => {
    canvas.selected_nodes = { 1: nodeA };
    expect(owns(nodeA, widgetA, body)).toBe(true);
    expect(owns(nodeB, widgetB, body)).toBe(false);
    canvas.selected_nodes = { 2: nodeB };
    expect(owns(nodeA, widgetA, body)).toBe(false);
    expect(owns(nodeB, widgetB, body)).toBe(true);
  });
});
