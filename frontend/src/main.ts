import styles from './styles/aala-media.css?inline';
import { getApp } from './comfy/host';
import { PREF_SETTINGS } from './comfy/prefs';
import { createMediaStateWidget } from './comfy/widget-bridge';
import { listenForManagerChanges, patchSplitter, SPLITTER_TYPE, type GraphNode } from './splitter/list-splitter';

const STYLE_ID = 'aala-media-styles';

if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = styles;
  document.head.appendChild(style);
}

getApp().registerExtension({
  name: 'Aala.MediaManager',
  settings: PREF_SETTINGS,
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === SPLITTER_TYPE) {
      patchSplitter(nodeType as { prototype: GraphNode });
    }
  },
  getCustomWidgets() {
    return {
      AALA_MEDIA_STATE: (node, inputName) => createMediaStateWidget(node, inputName),
    };
  },
});

listenForManagerChanges();
