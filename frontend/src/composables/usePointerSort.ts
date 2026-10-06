import { onBeforeUnmount, ref, type Ref } from 'vue';

const EDGE_PX = 32;
const SCROLL_STEP = 8;
const THRESHOLD_PX = 4;

/** The slot a card shows in while the card at `from` is dragged to slot `to`. */
export function sortSlot(index: number, from: number, to: number): number {
  if (index === from) {
    return to;
  }
  if (from < to && index > from && index <= to) {
    return index - 1;
  }
  if (to < from && index >= to && index < from) {
    return index + 1;
  }
  return index;
}

// A click that follows a real drag would select the card; the next pointerdown disarms it if no click comes.
function swallowNextClick(): void {
  const off = () => {
    window.removeEventListener('click', eat, true);
    window.removeEventListener('pointerdown', off, true);
  };
  const eat = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    off();
  };
  window.addEventListener('click', eat, true);
  window.addEventListener('pointerdown', off, true);
}

/**
 * Pointer-event sorting (works the same in canvas mode and Vue Nodes mode). Cards carry `data-sort-id` and
 * `data-sort-index` (position in the full list, since the list may be virtualized). `dropIndex` is the insertion
 * point in the full list, or null when the pointer is outside the list. Hit testing uses layout offsets, so
 * cards shifted by transforms while making room do not move the target.
 */
export function usePointerSort(list: Ref<HTMLElement | null>, onDrop: (id: string, insertAt: number) => void) {
  const draggingId = ref<string | null>(null);
  const dropIndex = ref<number | null>(null);
  let pointer = { x: 0, y: 0 };
  let origin = { x: 0, y: 0 };
  let frame = 0;
  let card: HTMLElement | null = null;
  let pendingId: string | null = null;
  let from = -1;
  let pointerId = -1;
  let ghost: HTMLElement | null = null;
  let ghostRect = { left: 0, top: 0, scale: 1 };

  function cards(): HTMLElement[] {
    return list.value ? [...list.value.querySelectorAll<HTMLElement>('[data-sort-id]')] : [];
  }

  // The group's own scroll area when it has one, else the widget.
  function scroller(): HTMLElement | null {
    return list.value?.closest<HTMLElement>('.aala-items-scroll, .aala-media') ?? null;
  }

  function locate(): void {
    const element = list.value;
    const bounds = (scroller() ?? element)?.getBoundingClientRect();
    if (
      !element ||
      !bounds ||
      pointer.x < bounds.left ||
      pointer.x > bounds.right ||
      pointer.y < bounds.top - EDGE_PX ||
      pointer.y > bounds.bottom + EDGE_PX
    ) {
      dropIndex.value = null;
      return;
    }
    // Offsets are relative to the list (position: relative) and unscaled; the canvas may zoom the widget.
    const base = element.getBoundingClientRect();
    const scale = element.offsetWidth ? base.width / element.offsetWidth : 1;
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const item of cards()) {
      const left = base.left + item.offsetLeft * scale;
      const top = base.top + item.offsetTop * scale;
      const dx = Math.max(left - pointer.x, 0, pointer.x - (left + item.offsetWidth * scale));
      const dy = Math.max(top - pointer.y, 0, pointer.y - (top + item.offsetHeight * scale));
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    if (!best) {
      dropIndex.value = null;
      return;
    }
    const slot = Number(best.dataset.sortIndex);
    dropIndex.value = slot > from ? slot + 1 : slot;
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

  function moveGhost(): void {
    if (ghost) {
      const { left, top, scale } = ghostRect;
      ghost.style.transform = `translate(${left + pointer.x - origin.x}px, ${top + pointer.y - origin.y}px) scale(${scale})`;
    }
  }

  // A copy of the card on body, styled by its own .aala-media root so it is not clipped by the node.
  function makeGhost(source: HTMLElement): void {
    const rect = source.getBoundingClientRect();
    const copy = source.cloneNode(true) as HTMLElement;
    copy.removeAttribute('data-sort-id');
    copy.removeAttribute('data-sort-index');
    copy.removeAttribute('tabindex');
    copy.removeAttribute('style');
    copy.style.width = `${source.offsetWidth}px`;
    ghost = document.createElement('div');
    ghost.className = 'aala-media aala-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.appendChild(copy);
    ghostRect = { left: rect.left, top: rect.top, scale: source.offsetWidth ? rect.width / source.offsetWidth : 1 };
    document.body.appendChild(ghost);
    moveGhost();
  }

  function begin(): void {
    if (!card || pendingId === null) {
      return;
    }
    from = Number(card.dataset.sortIndex);
    makeGhost(card);
    card.setPointerCapture(pointerId);
    getSelection()?.removeAllRanges();
    window.addEventListener('keydown', onKey, true);
    draggingId.value = pendingId;
    locate();
    frame = requestAnimationFrame(autoScroll);
  }

  function onMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) {
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    if (draggingId.value) {
      moveGhost();
      locate();
    } else if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) >= THRESHOLD_PX) {
      begin();
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
    if (card?.isConnected && card.hasPointerCapture(pointerId)) {
      card.releasePointerCapture(pointerId);
    }
    ghost?.remove();
    ghost = null;
    card = null;
    pendingId = null;
    draggingId.value = null;
    dropIndex.value = null;
    if (id !== null) {
      swallowNextClick();
    }
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

  /** Arms a drag on pointerdown; it starts once the pointer moves past the threshold, so a click still selects. */
  function start(event: PointerEvent, id: string): void {
    if (event.button !== 0 || pendingId !== null) {
      return;
    }
    card = event.currentTarget as HTMLElement;
    pendingId = id;
    pointerId = event.pointerId;
    // Window capture phase: still delivered if virtualization unmounts the dragged card, and ahead of the
    // Vue Nodes wrapper that stops pointer propagation.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    pointer = origin = { x: event.clientX, y: event.clientY };
  }

  onBeforeUnmount(() => finish(false));

  return { draggingId, dropIndex, start };
}
