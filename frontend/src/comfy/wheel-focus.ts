import { getApp } from './host';

// Click-to-activate wheel: a click inside a widget makes it the one active widget, whose lists take the
// wheel; any other click releases it. Over an inactive widget, and with Ctrl/Cmd, the wheel goes to the
// canvas. Window capture listeners run before the Vue Nodes TransformPane forwarding.

const ROOT_SELECTOR = '[data-aala-wheel-root]';
const ACTIVE_CLASS = 'aala-media--active';
let users = 0;
let active: HTMLElement | null = null;

function setActive(root: HTMLElement | null): void {
  if (root === active) {
    return;
  }
  active?.classList.remove(ACTIVE_CLASS);
  active = root;
  active?.classList.add(ACTIVE_CLASS);
}

function forwardToCanvas(event: WheelEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const { clientX, clientY, deltaX, deltaY, ctrlKey, metaKey, shiftKey } = event;
  getApp().canvas?.canvas?.dispatchEvent(
    new WheelEvent('wheel', { clientX, clientY, deltaX, deltaY, ctrlKey, metaKey, shiftKey }),
  );
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const root = target?.closest<HTMLElement>(ROOT_SELECTOR);
  if (root) {
    setActive(root);
  } else if (!target?.closest('.aala-media')) {
    // Teleported dialogs and menus carry .aala-media too; clicks there keep the current widget active.
    setActive(null);
  }
}

function onWheel(event: WheelEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const root = target?.closest<HTMLElement>(ROOT_SELECTOR);
  if (!root) {
    return;
  }
  if (event.ctrlKey || event.metaKey || root !== active) {
    forwardToCanvas(event);
    return;
  }
  event.stopPropagation();
}

/** Registers a widget root; the first one installs the window listeners, the returned function releases it. */
export function useWheelFocus(root: HTMLElement): () => void {
  root.dataset.aalaWheelRoot = '';
  if (users === 0) {
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }
  users += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (active === root) {
      setActive(null);
    }
    users -= 1;
    if (users === 0) {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('wheel', onWheel, { capture: true });
    }
  };
}
