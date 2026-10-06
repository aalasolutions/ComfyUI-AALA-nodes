import { createApp, reactive } from 'vue';
import MediaManagerWidget from '../components/manager/MediaManagerWidget.vue';
import { createMediaStore } from '../state/store';
import { emitMediaStateChanged } from '../splitter/events';
import { recordGraphChange, type ComfyNode, type CustomWidgetResult } from './host';
import { useWheelFocus } from './wheel-focus';

const WIDGET_MIN_HEIGHT = 220;
// Room for a one-line group header (title, count, Max, Add, menu) and a list card with its controls.
const WIDGET_MIN_WIDTH = 340;

export interface ExecutionRuntime {
  missing: string[];
  runs: number;
}

interface LiveWidget {
  node: ComfyNode;
  element: HTMLElement;
}

const liveWidgets = new Set<LiveWidget>();

// Vue Nodes mode reuses a node's component when undo recreates a node with the same id, and keeps showing
// the removed widget's element. Hand that slot to the replacement widget so the node does not go blank.
function adoptReplacement(removed: LiveWidget, graph: object | null | undefined): void {
  if (!removed.element.isConnected) {
    return;
  }
  for (const candidate of liveWidgets) {
    const sameGraph = !graph || candidate.node.graph === graph;
    if (
      candidate.node !== removed.node &&
      candidate.node.id === removed.node.id &&
      sameGraph &&
      !candidate.element.isConnected
    ) {
      removed.element.replaceWith(candidate.element);
      return;
    }
  }
}

export function createMediaStateWidget(node: ComfyNode, inputName: string): CustomWidgetResult {
  const element = document.createElement('div');
  element.className = 'aala-media';
  const releaseWheel = useWheelFocus(element);

  const store = createMediaStore(() => {
    emitMediaStateChanged(node);
    recordGraphChange(node);
  });
  const widget = node.addDOMWidget<string>(inputName, 'aala-media-state', element, {
    getValue: () => store.serialize(),
    setValue: (value) => {
      store.replace(value);
      emitMediaStateChanged(node);
    },
    getMinHeight: () => WIDGET_MIN_HEIGHT,
    hideOnZoom: false,
  });

  // Last Run's UI output: paths skipped because they were missing or unreadable.
  const runtime = reactive<ExecutionRuntime>({ missing: [], runs: 0 });
  const previousOnExecuted = node.onExecuted;
  node.onExecuted = function onExecuted(this: ComfyNode, output) {
    previousOnExecuted?.call(this, output);
    const skipped = [output?.missing, output?.unreadable].flatMap((paths) => (Array.isArray(paths) ? paths : []));
    runtime.missing = skipped.filter((path): path is string => typeof path === 'string');
    runtime.runs += 1;
  };

  const vueApp = createApp(MediaManagerWidget, { store, runtime });
  vueApp.mount(element);

  const live: LiveWidget = { node, element };
  liveWidgets.add(live);

  const previousOnRemoved = node.onRemoved;
  node.onRemoved = function onRemoved(this: ComfyNode) {
    const graph = this.graph;
    previousOnRemoved?.call(this);
    setTimeout(() => {
      liveWidgets.delete(live);
      adoptReplacement(live, graph);
      vueApp.unmount();
      releaseWheel();
    });
  };

  return { widget: widget as CustomWidgetResult['widget'], minWidth: WIDGET_MIN_WIDTH, minHeight: WIDGET_MIN_HEIGHT };
}
