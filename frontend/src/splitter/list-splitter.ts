import { getApp } from '../comfy/host';
import { KINDS, type MediaKind } from '../state/schema';
import { MEDIA_STATE_EVENT, type MediaStateEventDetail } from './events';

const SPLITTER_TYPE = 'AalaListSplitter';
const MANAGER_TYPE = 'AalaMediaManager';
const MAX_SLOTS = 100;
const ANY_TYPE = '*';
const OUTPUT_KINDS: MediaKind[] = [...KINDS];
const KIND_LABELS: Record<MediaKind, string> = { image: 'IMAGES', video: 'VIDEOS', audio: 'AUDIO' };

interface Widget {
  name: string;
  value: unknown;
  disabled?: boolean;
  hidden?: boolean;
  tooltip?: string;
  callback?: (value: unknown) => void;
}

interface Slot {
  name: string;
  label?: string;
  localized_name?: string;
  type: string;
  links?: unknown[] | null;
}

interface Link {
  origin_id: number | string;
  origin_slot: number;
  target_id: number | string;
  target_slot: number;
  type?: string;
}

interface Graph {
  getNodeById(id: number | string): GraphNode | null;
  getLink?(id: unknown): Link | null | undefined;
  _nodes?: GraphNode[];
}

declare global {
  interface Window {
    LiteGraph?: { isValidConnection(from: string, to: string): boolean };
  }
}

export interface GraphNode {
  id: number | string;
  type: string;
  title?: string;
  graph?: Graph | null;
  inputs?: Slot[];
  outputs: Slot[];
  widgets?: Widget[];
  size: [number, number];
  getInputLink(slot: number): Link | null;
  computeSize(): [number, number];
  setSize(size: [number, number]): void;
  addOutput(name: string, type: string): Slot;
  removeOutput(slot: number): void;
  disconnectOutput(slot: number, target?: GraphNode): boolean;
  setDirtyCanvas?(foreground: boolean, background?: boolean): void;
  onNodeCreated?(): void;
  onConfigure?(info: unknown): void;
  onConnectionsChange?(type: number, index: number, connected: boolean, link: unknown, slot: unknown): void;
}

interface Source {
  node: GraphNode;
  kind: MediaKind;
}

const INPUT_SLOT_TYPE = 1;

function slotsWidget(node: GraphNode): Widget | undefined {
  return node.widgets?.find((widget) => widget.name === 'slots');
}

// Walks back through legacy Reroute nodes; native link reroutes keep the real origin on the link.
// origin is null when the link comes from a node this graph cannot resolve, such as a subgraph input.
function upstream(node: GraphNode): { origin: GraphNode | null; slot: number; type: string } | null {
  let current = node;
  for (let hops = 0; hops < 32; hops++) {
    if (!current.graph) {
      return null;
    }
    const link = current.getInputLink(0);
    if (!link) {
      return null;
    }
    const origin = current.graph.getNodeById(link.origin_id);
    if (!origin) {
      return { origin: null, slot: link.origin_slot, type: link.type || ANY_TYPE };
    }
    if (origin.type === 'Reroute') {
      current = origin;
      continue;
    }
    return { origin, slot: link.origin_slot, type: link.type || ANY_TYPE };
  }
  return null;
}

function managerSource(node: GraphNode): Source | null {
  const found = upstream(node);
  if (!found?.origin || found.origin.type !== MANAGER_TYPE) {
    return null;
  }
  const kind = OUTPUT_KINDS[found.slot];
  return kind ? { node: found.origin, kind } : null;
}

function managerLimit(source: Source): number | null {
  const widget = source.node.widgets?.find((item) => item.name === 'media_state');
  try {
    const limit = JSON.parse(String(widget?.value ?? '')).limits?.[source.kind];
    return Number.isInteger(limit) ? limit : null;
  } catch {
    return null;
  }
}

// Socket labels follow the incoming list type: image 0, image 1, ... ("item" while unconnected).
function socketPrefix(type: string): string {
  const first = type.split(',')[0].trim();
  return !first || first === ANY_TYPE ? 'item' : first.toLowerCase();
}

// Drops outgoing links whose target cannot take the new type, as core MatchType nodes do.
// Skipped while a graph loads: target inputs (such as autogrow slots) are not rebuilt yet.
function dropIncompatibleLinks(node: GraphNode, type: string): void {
  const graph = node.graph;
  const liteGraph = window.LiteGraph;
  if (!graph?.getLink || !liteGraph || type === ANY_TYPE || getApp().configuringGraph) {
    return;
  }
  node.outputs.forEach((output, index) => {
    for (const linkId of [...(output.links ?? [])]) {
      const link = graph.getLink?.(linkId);
      const target = link ? graph.getNodeById(link.target_id) : null;
      const targetType = target?.inputs?.[link!.target_slot]?.type;
      if (target && targetType && !liteGraph.isValidConnection(type, targetType)) {
        node.disconnectOutput(index, target);
      }
    }
  });
}

function resizeOutputs(node: GraphNode, count: number, type: string, layoutChanged: boolean): void {
  const changed = layoutChanged || node.outputs.length !== count;
  while (node.outputs.length > count) {
    node.removeOutput(node.outputs.length - 1);
  }
  while (node.outputs.length < count) {
    node.addOutput(String(node.outputs.length), type);
  }
  if (node.outputs.some((output) => output.type !== type)) {
    dropIncompatibleLinks(node, type);
  }
  const prefix = socketPrefix(type);
  node.outputs.forEach((output, index) => {
    output.type = type;
    output.label = `${prefix} ${index}`;
    output.localized_name = output.label;
  });
  if (changed) {
    const [, height] = node.computeSize();
    node.setSize([node.size[0], height]);
  }
  node.setDirtyCanvas?.(true, true);
}

export function syncSplitter(node: GraphNode): void {
  const widget = slotsWidget(node);
  if (!widget) {
    return;
  }
  const found = upstream(node);
  const source = managerSource(node);
  const limit = source ? managerLimit(source) : null;
  // Slots are only set by hand for lists that do not come from a Media Manager.
  const hidden = !found || source !== null;
  const visibilityChanged = !!widget.hidden !== hidden;
  widget.hidden = hidden;

  if (source && limit !== null) {
    const slots = Math.max(1, Math.min(limit, MAX_SLOTS));
    widget.value = slots;
    widget.disabled = true;
    const managerName = source.node.title || 'AALA Media Manager';
    widget.tooltip =
      `Follows Max of ${KIND_LABELS[source.kind]} on "${managerName}"` + (limit > MAX_SLOTS ? ` (capped at ${MAX_SLOTS})` : '');
  } else {
    widget.disabled = false;
    widget.tooltip = undefined;
  }
  const count = Math.max(1, Math.min(Number(widget.value) || 1, MAX_SLOTS));
  resizeOutputs(node, count, found?.type ?? ANY_TYPE, visibilityChanged);
}

function splittersFollowing(manager: GraphNode): GraphNode[] {
  const nodes = manager.graph?._nodes ?? [];
  return nodes.filter((node) => node.type === SPLITTER_TYPE && managerSource(node)?.node === manager);
}

export function patchSplitter(nodeType: { prototype: GraphNode }): void {
  const proto = nodeType.prototype;

  const onNodeCreated = proto.onNodeCreated;
  proto.onNodeCreated = function (this: GraphNode) {
    onNodeCreated?.call(this);
    const widget = slotsWidget(this);
    if (widget) {
      const callback = widget.callback;
      widget.callback = (value: unknown) => {
        callback?.call(widget, value);
        syncSplitter(this);
      };
    }
    syncSplitter(this);
  };

  const onConfigure = proto.onConfigure;
  proto.onConfigure = function (this: GraphNode, info: unknown) {
    onConfigure?.call(this, info);
    // Links are restored after every node is configured.
    queueMicrotask(() => syncSplitter(this));
  };

  const onConnectionsChange = proto.onConnectionsChange;
  proto.onConnectionsChange = function (this: GraphNode, type, index, connected, link, slot) {
    onConnectionsChange?.call(this, type, index, connected, link, slot);
    if (type === INPUT_SLOT_TYPE && index === 0) {
      syncSplitter(this);
    }
  };
}

export function listenForManagerChanges(): void {
  window.addEventListener(MEDIA_STATE_EVENT, (event) => {
    const manager = (event as CustomEvent<MediaStateEventDetail>).detail.node as GraphNode;
    splittersFollowing(manager).forEach(syncSplitter);
  });
}

export { SPLITTER_TYPE };
