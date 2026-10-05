export const MEDIA_STATE_EVENT = 'aala-media:state-changed';

export interface MediaStateEventDetail {
  node: unknown;
}

export function emitMediaStateChanged(node: unknown): void {
  window.dispatchEvent(new CustomEvent<MediaStateEventDetail>(MEDIA_STATE_EVENT, { detail: { node } }));
}
