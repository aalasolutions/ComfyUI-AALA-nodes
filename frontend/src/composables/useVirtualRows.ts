import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

const OVERSCAN_ROWS = 3;

/** Row windowing for a fixed-height grid or list inside a scroll container. */
export function useVirtualRows(
  scroller: Ref<HTMLElement | null>,
  options: { count: Ref<number>; rowHeight: Ref<number>; minColumnWidth: Ref<number> },
) {
  const width = ref(0);
  const height = ref(0);
  const scrollTop = ref(0);
  let observer: ResizeObserver | null = null;

  const columns = computed(() =>
    options.minColumnWidth.value > 0 ? Math.max(1, Math.floor(width.value / options.minColumnWidth.value)) : 1,
  );
  const rowCount = computed(() => Math.ceil(options.count.value / columns.value));
  const startRow = computed(() => Math.max(0, Math.floor(scrollTop.value / options.rowHeight.value) - OVERSCAN_ROWS));
  const endRow = computed(() =>
    Math.min(rowCount.value, Math.ceil((scrollTop.value + height.value) / options.rowHeight.value) + OVERSCAN_ROWS),
  );
  const range = computed(() => ({
    start: startRow.value * columns.value,
    end: Math.min(options.count.value, endRow.value * columns.value),
  }));
  const padTop = computed(() => startRow.value * options.rowHeight.value);
  const padBottom = computed(() => Math.max(0, (rowCount.value - endRow.value) * options.rowHeight.value));

  function onScroll(): void {
    scrollTop.value = scroller.value?.scrollTop ?? 0;
  }

  /** Scrolls just enough to show the item at `index`. */
  function reveal(index: number): void {
    const element = scroller.value;
    if (!element) {
      return;
    }
    const top = Math.floor(index / columns.value) * options.rowHeight.value;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + options.rowHeight.value > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + options.rowHeight.value - element.clientHeight;
    }
    onScroll();
  }

  // Follows the element, which may appear later (a collapsed group mounts its list on expand).
  let attached: HTMLElement | null = null;
  function attach(element: HTMLElement | null): void {
    if (attached === element) {
      return;
    }
    attached?.removeEventListener('scroll', onScroll);
    observer?.disconnect();
    observer = null;
    attached = element;
    if (!element) {
      return;
    }
    element.addEventListener('scroll', onScroll, { passive: true });
    observer = new ResizeObserver(() => {
      width.value = element.clientWidth;
      height.value = element.clientHeight;
    });
    observer.observe(element);
    width.value = element.clientWidth;
    height.value = element.clientHeight;
    scrollTop.value = element.scrollTop;
  }

  onMounted(() => attach(scroller.value));
  watch(scroller, attach, { flush: 'post' });
  onBeforeUnmount(() => attach(null));

  return { columns, range, padTop, padBottom, reveal };
}
