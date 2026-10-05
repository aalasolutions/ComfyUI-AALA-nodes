// Minimal typed surface of the ComfyUI frontend (verified against 1.49.6) used by this pack.

export interface DomWidgetOptions<V> {
  getValue?: () => V;
  setValue?: (value: V) => void;
  getMinHeight?: () => number;
  hideOnZoom?: boolean;
}

export interface DomWidget<V> {
  name: string;
  value: V;
  element: HTMLElement;
}

export interface ComfyNode {
  id: number | string;
  graph?: object | null;
  addDOMWidget<V>(name: string, type: string, element: HTMLElement, options?: DomWidgetOptions<V>): DomWidget<V>;
  onRemoved?: () => void;
  onExecuted?: (output: Record<string, unknown> | undefined) => void;
  setDirtyCanvas?: (foreground: boolean, background?: boolean) => void;
}

export interface CustomWidgetResult {
  widget: DomWidget<unknown>;
  minWidth?: number;
  minHeight?: number;
}

export type CustomWidgetFactory = (node: ComfyNode, inputName: string, inputData: unknown) => CustomWidgetResult;

export interface SettingDefinition {
  id: string;
  name: string;
  type: 'hidden';
  defaultValue: unknown;
}

export interface ComfyExtension {
  name: string;
  settings?: SettingDefinition[];
  getCustomWidgets?: () => Record<string, CustomWidgetFactory>;
  beforeRegisterNodeDef?: (nodeType: { prototype: unknown }, nodeData: { name: string }) => void;
}

interface SettingStore {
  get(id: string): unknown;
  set(id: string, value: unknown): Promise<void>;
}

interface ComfyApi {
  apiURL(route: string): string;
  fetchApi(route: string, options?: RequestInit): Promise<Response>;
}

interface ChangeTracker {
  captureCanvasState?: () => void;
  checkState?: () => void;
}

export interface ComfyApp {
  registerExtension(extension: ComfyExtension): void;
  extensionManager?: {
    workflow?: { activeWorkflow?: { changeTracker?: ChangeTracker | null } | null };
    setting?: SettingStore;
  };
}

declare global {
  interface Window {
    comfyAPI: { app: { app: ComfyApp }; api?: { api?: ComfyApi } };
  }
}

export function getApp(): ComfyApp {
  return window.comfyAPI.app.app;
}

export function recordGraphChange(node: ComfyNode): void {
  node.setDirtyCanvas?.(true, true);
  const tracker = getApp().extensionManager?.workflow?.activeWorkflow?.changeTracker;
  if (tracker?.captureCanvasState) {
    tracker.captureCanvasState();
  } else {
    tracker?.checkState?.();
  }
}

function getApi(): ComfyApi | undefined {
  return window.comfyAPI.api?.api;
}

export function apiURL(route: string): string {
  return getApi()?.apiURL(route) ?? route;
}

export function fetchApi(route: string, options?: RequestInit): Promise<Response> {
  const api = getApi();
  return api ? api.fetchApi(route, options) : fetch(route, options);
}

export function getSettingStore(): SettingStore | undefined {
  return getApp().extensionManager?.setting;
}
