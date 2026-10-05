import type { MediaKind } from '../state/schema';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const KIND_LABEL: Record<MediaKind, string> = { image: 'Images', video: 'Videos', audio: 'Audio' };
export const KIND_SINGULAR: Record<MediaKind, string> = { image: 'image', video: 'video', audio: 'audio file' };

export const en = {
  limitFull: (limit: number) => `limit ${limit} is full`,
  addedInactive: (count: number, limit: number) => `limit ${limit} is full: ${plural(count, 'item')} added inactive`,
  activatedPartly: (done: number, blocked: number, limit: number) =>
    `limit ${limit} is full: activated ${done}, ${blocked} left inactive`,
  deactivated: (count: number) => `Limit lowered: ${plural(count, 'item')} deactivated from the bottom`,
  removeAllConfirm: (count: number, label: string) => `Remove all ${count} ${label.toLowerCase()}?`,
  pathCopied: 'Path copied',
  copyFailed: 'Could not copy the path',
  probeFailed: 'Could not read file details; added without them',
  missing: 'File not found',
  skippedLastRun: 'Missing or unreadable at the last run',
  relink: 'Relink',
  noItems: (label: string) => `No ${label.toLowerCase()} yet.`,
  selected: (count: number) => `${count} selected`,
  addItems: (count: number) => `Add ${plural(count, 'item')}`,
  replaceWith: 'Use this file',
  folderEmpty: 'This folder is empty.',
  noMedia: 'No media in this folder.',
  noKind: (label: string) => `No ${label.toLowerCase()} in this folder.`,
  noMatches: (query: string) => `No matches for "${query}".`,
  recursiveCounting: (count: number) => `Counting media: ${count} found so far`,
  recursiveConfirm: (count: number, folder: string) => `Add ${plural(count, 'file')} from "${folder}" and its subfolders?`,
  recursiveNone: 'No media found in this folder or its subfolders.',
  errors: {
    not_found: 'This folder does not exist.',
    permission_denied:
      'Permission denied. On macOS, grant the app running ComfyUI access in System Settings, Privacy & Security, Files and Folders (or Full Disk Access).',
    not_a_directory: 'This path is not a folder.',
    bad_request: 'The request was not valid.',
    io_error: 'The folder could not be read.',
    network: 'Could not reach the ComfyUI server.',
  } as Record<string, string>,
  pathError: (message: string) => `Cannot open: ${message}`,
};
