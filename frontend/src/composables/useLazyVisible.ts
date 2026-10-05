import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/** Calls `onVisible` once the element has stayed in view for `dwellMs`; leaving the view first cancels it. */
export function useLazyVisible(element: Ref<HTMLElement | null>, dwellMs: number, onVisible: () => void): void {
  let observer: IntersectionObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMounted(() => {
    if (!element.value) {
      return;
    }
    observer = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer);
        if (entry?.isIntersecting) {
          timer = setTimeout(() => {
            observer?.disconnect();
            onVisible();
          }, dwellMs);
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(element.value);
  });

  onBeforeUnmount(() => {
    clearTimeout(timer);
    observer?.disconnect();
  });
}
