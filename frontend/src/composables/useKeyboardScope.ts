import { onBeforeUnmount, watch, type Ref } from 'vue';

type KeyHandler = (event: KeyboardEvent) => void;

// Only the newest open scope (dialog, menu, lightbox) receives keys. Events are taken in the window capture
// phase so ComfyUI shortcuts never see them; default actions such as typing in an input still happen.
const scopes: KeyHandler[] = [];

function onKey(event: KeyboardEvent): void {
  const handler = scopes[scopes.length - 1];
  if (!handler) {
    return;
  }
  event.stopPropagation();
  if (event.type === 'keydown' && !event.isComposing) {
    handler(event);
  }
}

function onClipboard(event: Event): void {
  if (scopes.length > 0) {
    event.stopPropagation();
  }
}

function attach(handler: KeyHandler): void {
  if (scopes.length === 0) {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    for (const type of ['copy', 'cut', 'paste']) {
      window.addEventListener(type, onClipboard, true);
    }
  }
  scopes.push(handler);
}

function detach(handler: KeyHandler): void {
  const index = scopes.lastIndexOf(handler);
  if (index >= 0) {
    scopes.splice(index, 1);
  }
  if (scopes.length === 0) {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    for (const type of ['copy', 'cut', 'paste']) {
      window.removeEventListener(type, onClipboard, true);
    }
  }
}

export function useKeyboardScope(active: Ref<boolean>, handler: KeyHandler): void {
  let attached = false;
  const sync = (on: boolean) => {
    if (on && !attached) {
      attach(handler);
    } else if (!on && attached) {
      detach(handler);
    }
    attached = on;
  };
  watch(active, sync, { immediate: true });
  onBeforeUnmount(() => sync(false));
}

export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function isMod(event: KeyboardEvent | MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}
