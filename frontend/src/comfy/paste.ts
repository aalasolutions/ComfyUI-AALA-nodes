import { hasKeyboardScope, isTextInput } from '../composables/useKeyboardScope';
import { fetchApi, getApp, type ComfyNode } from './host';

export const PASTE_SUBFOLDER = 'pasted';

interface ClipboardEntry {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

export interface ClipboardSource {
  items?: ArrayLike<ClipboardEntry> | null;
  files?: ArrayLike<File> | null;
}

export interface UploadedImage {
  name: string;
  subfolder: string;
}

/** Extension of a pasted image: from its file name, else from its MIME subtype. Lowercase, no dot. */
export function imageExtension(file: Pick<File, 'name' | 'type'>): string {
  const dot = file.name.lastIndexOf('.');
  if (dot > 0) {
    return file.name.slice(dot + 1).toLowerCase();
  }
  return (file.type.split('/')[1] ?? '').toLowerCase();
}

/** Image files on a clipboard: bitmap items and copied files, deduplicated. Non-image content is left out. */
export function clipboardImages(source: ClipboardSource | null | undefined): File[] {
  const found: File[] = [];
  const seen = new Set<string>();
  const take = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) {
      return;
    }
    const key = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push(file);
    }
  };
  for (const entry of Array.from(source?.items ?? [])) {
    if (entry.kind === 'file' && entry.type.startsWith('image/')) {
      take(entry.getAsFile());
    }
  }
  Array.from(source?.files ?? []).forEach(take);
  return found;
}

/** Splits images into ones the pack can load and ones it cannot, by extension. */
export function splitSupported(files: File[], extensions: readonly string[]): { supported: File[]; unsupported: File[] } {
  const known = new Set(extensions);
  const supported: File[] = [];
  const unsupported: File[] = [];
  files.forEach((file) => (known.has(imageExtension(file)) ? supported : unsupported).push(file));
  return { supported, unsupported };
}

/** Same request as core Load Image paste: POST /upload/image with the file and subfolder "pasted" in input. */
export async function uploadPastedImage(file: File): Promise<UploadedImage> {
  const named = file.name.includes('.') ? file : new File([file], `image.${imageExtension(file)}`, { type: file.type });
  const body = new FormData();
  body.append('image', named);
  body.append('subfolder', PASTE_SUBFOLDER);
  const response = await fetchApi('/upload/image', { method: 'POST', body });
  if (response.status !== 200) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const result = (await response.json()) as UploadedImage;
  return { name: result.name, subfolder: result.subfolder ?? '' };
}

export function uploadedPath(inputDir: string, image: UploadedImage): string {
  return [inputDir.replace(/\/+$/, ''), image.subfolder, image.name].filter((part) => part !== '').join('/');
}

/** Images from the async clipboard API, for the Paste menu entry. Throws when the browser denies access. */
export async function readClipboardImages(): Promise<File[]> {
  const files: File[] = [];
  for (const entry of await navigator.clipboard.read()) {
    const type = entry.types.find((value) => value.startsWith('image/'));
    if (type) {
      const blob = await entry.getType(type);
      files.push(new File([blob], `image.${imageExtension({ name: '', type })}`, { type }));
    }
  }
  return files;
}

function isEditable(target: EventTarget | null): boolean {
  return isTextInput(target) || (target instanceof HTMLElement && target.isContentEditable);
}

/** A paste belongs to the widget that holds focus; with focus outside every widget, to the only selected node. */
export function isPasteTarget(node: ComfyNode, element: HTMLElement, event: Event): boolean {
  const target = event.target;
  if (isEditable(target) || hasKeyboardScope()) {
    return false;
  }
  if (target instanceof Element && target.closest('.aala-media')) {
    return element.contains(target);
  }
  const selected = Object.values(getApp().canvas?.selected_nodes ?? {});
  return selected.length === 1 && selected[0] === node;
}
