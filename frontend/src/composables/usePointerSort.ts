import { onBeforeUnmount, ref, type Ref } from 'vue';

const EDGE_PX = 32;
const SCROLL_STEP = 8;

/**
 * Pointer-event sorting (works the same in canvas mode and Vue Nodes mode). Cards carry `data-sort-id` and
 * `data-sort-index` (position in the full list, since the list may be virtualized). `dropIndex` is the insertion
 * point in the full list, or null when the pointer is outside the list.
 */
export function usePointerSort(
  list: Ref<HTMLElement | null>,
  axis: Ref<'x' | 'y'>,
  onDrop: (id: string, insertAt: number) => void,
) {
  const draggingId = ref<string | null>(null);
  const dropIndex = ref<number | null>(null);
  let pointer = { x: 0, y: 0 };
  let frame = 0;
  let handle: HTMLElement | null = null;
  let pointerId = -1;

  function cards(): HTMLElement[] {
    return list.value ? [...list.value.querySelectorAll<HTMLElement>('[data-sort-id]')] : [];
  }

  // The group's own scroll area when it has one, else the widget.
  function scroller(): HTMLElement | null {
    return list.value?.closest<HTMLElement>('.aala-items-scroll, .aala-media') ?? null;
  }

  function locate(): void {
    const bounds = (scroller() ?? list.value)?.getBoundingClientRect();
    if (
      !bounds ||
      pointer.x < bounds.left ||
      pointer.x > bounds.right ||
      pointer.y < bounds.top - EDGE_PX ||
      pointer.y > bounds.bottom + EDGE_PX
    ) {
      dropIndex.value = null;
      return;
    }
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const card of cards()) {
      const rect = card.getBoundingClientRect();
      const dx = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right);
      const dy = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = card;
      }
    }
    if (!best) {
      dropIndex.value = null;
      return;
    }
    const rect = best.getBoundingClientRect();
    const before = axis.value === 'y' ? pointer.y < rect.top + rect.height / 2 : pointer.x < rect.left + rect.width / 2;
    const index = Number(best.dataset.sortIndex);
    dropIndex.value = before ? index : index + 1;
  }

  function autoScroll(): void {
    const element = scroller();
    if (element && draggingId.value) {
      const rect = element.getBoundingClientRect();
      if (pointer.y < rect.top + EDGE_PX) {
        element.scrollTop -= SCROLL_STEP;
      } else if (pointer.y > rect.bottom - EDGE_PX) {
        element.scrollTop += SCROLL_STEP;
      }
      locate();
      frame = requestAnimationFrame(autoScroll);
    }
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerId === pointerId) {
      pointer = { x: event.clientX, y: event.clientY };
      locate();
    }
  }

  function finish(commit: boolean): void {
    const id = draggingId.value;
    const insert = dropIndex.value;
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    if (handle?.isConnected && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    handle = null;
    draggingId.value = null;
    dropIndex.value = null;
    if (commit && id !== null && insert !== null) {
      onDrop(id, insert);
    }
  }

  function onUp(event: PointerEvent): void {
    if (event.pointerId === pointerId) {
      finish(true);
    }
  }

  function onCancel(event: PointerEvent): void {
    if (event.pointerId === pointerId) {
      finish(false);
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      finish(false);
    }
  }

  function start(event: PointerEvent, id: string): void {
    if (event.button !== 0 || draggingId.value) {
      return;
    }
    event.preventDefault();
    handle = event.currentTarget as HTMLElement;
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    // Window capture phase: still delivered if virtualization unmounts the dragged card, and ahead of the
    // Vue Nodes wrapper that stops pointer propagation.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    pointer = { x: event.clientX, y: event.clientY };
    draggingId.value = id;
    locate();
    frame = requestAnimationFrame(autoScroll);
  }

  onBeforeUnmount(() => finish(false));

  return { draggingId, dropIndex, start };
}
