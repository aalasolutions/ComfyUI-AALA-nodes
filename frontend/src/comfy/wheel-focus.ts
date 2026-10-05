import { isTextInput } from '../composables/useKeyboardScope';

// Vue Nodes mode forwards every wheel over a node to the canvas in its own capture listener, unless the
// target sits in a [data-capture-wheel="true"] element that contains the focused element. This window
// capture listener runs first: it focuses our scroller while it keeps the wheel, and releases focus at
// the ends so the canvas zooms there.

const SELECTOR = '[data-capture-wheel="true"]';
const LATCH_MS = 200;
let users = 0;
let latched: HTMLElement | null = null;
let lastWheelAt = 0;

function canScroll(element: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) {
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  }
  return deltaY < 0 && element.scrollTop > 0;
}

/** True while a scroll that started in this element is still going, so fast scrolls past the end do not zoom the canvas. */
export function keepWheel(element: HTMLElement, deltaY: number): boolean {
  const now = performance.now();
  if (latched === element && now - lastWheelAt < LATCH_MS) {
    lastWheelAt = now;
    return true;
  }
  if (canScroll(element, deltaY)) {
    latched = element;
    lastWheelAt = now;
    return true;
  }
  if (latched === element) {
    latched = null;
  }
  return false;
}

function onWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const scroller = target?.closest<HTMLElement>(SELECTOR);
  if (!scroller || !scroller.closest('.aala-media')) {
    return;
  }
  const active = document.activeElement;
  const focusedInside = !!active && scroller.contains(active);
  if (isTextInput(active) && active?.closest('.aala-media')) {
    return;
  }
  if (keepWheel(scroller, event.deltaY)) {
    if (!focusedInside) {
      scroller.focus({ preventScroll: true });
    }
  } else if (focusedInside && active instanceof HTMLElement) {
    active.blur();
  }
}

export function markWheelScroller(element: HTMLElement): void {
  element.dataset.captureWheel = 'true';
  element.tabIndex = -1;
}

/** Installs the listener for the first widget on the page; the returned function releases it. */
export function useWheelFocus(): () => void {
  if (users === 0) {
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  }
  users += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    users -= 1;
    if (users === 0) {
      window.removeEventListener('wheel', onWheel, { capture: true });
    }
  };
}
