// =======================================================
// FICHIER : src/js/panels/mainsettings.js (VERSION FINALE COMPLÈTE)
// RÔLE    : Gère le panneau de configuration, avec tous les chemins restaurés et fonctionnels.
// =======================================================

import { getManualHtml, initializeManualPanel} from './text_content/manual.js';
import { applyUiSettings } from '../../../ui.js';
import { getUpdatesHtml } from './text_content/updates.js';
import { defaultTemplates, templateMeta, parseTemplateToLines, serializeLines, getPreview } from '../../utils/formulaTemplates.js';

export const getSettings = () => window.electronAPI.getSettings();

function getHelpContentHtml() {
  return `
    <div class="bg-gray-900 border-2 border-green-700 rounded-lg shadow-xl text-green-400 flex flex-col w-full max-w-4xl h-full max-h-[90vh]">
      <div class="flex justify-between items-center p-4 border-b border-green-800 flex-shrink-0">
        <h2 class="text-2xl font-bold text-white">Toolbox Help</h2>
        <button id="close-help-modal" class="text-4xl transition-colors" style="color: var(--border-primary);">×</button>
      </div>
      <div class="p-6 overflow-y-auto">
        ${getManualHtml()}
      </div>
    </div>
  `;
}

export function getSettingsPanelHtml() {
  const arrowSVG = `<svg class="w-4 h-4 transition-transform duration-300 toggle-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>`;

  return `
    <div class="p-6 h-full flex flex-col">
      <h1 class="text-4xl font-bold text-white mb-8 flex-shrink-0">Settings</h1>
      <div id="settings-form" class="space-y-6 flex-grow overflow-y-auto pr-2">

        <div id="updates-panel" class="control-group">
          <div class="control-label-toggle"><span>Updates and Fixes</span>${arrowSVG}</div>
          ${getUpdatesHtml()}
        </div>

        <div id="paths-panel" class="control-group">
          <div class="control-label-toggle"><span>Access Paths</span>${arrowSVG}</div>
          <div class="p-4 pb-6 overflow-hidden space-y-4">
            
            <div class="space-y-3 p-4 border border-gray-700 rounded-md">
                <h3 class="text-md font-bold text-white mb-2">General Data</h3>
                <p class="text-xs text-gray-400 mb-3">Root folder for app data (Mesh-out, STL-out, CSV-out will be auto-created).</p>
                <div><label class="block mb-2">Data Root Folder</label><div class="flex space-x-2"><input type="text" id="setting-dataRoot" class="form-input flex-grow"><button data-path-for="setting-dataRoot" data-dialog="directory" class="path-select-btn action-btn">Browse...</button></div></div>
            </div>

            <div class="space-y-4 mt-4 pb-2">
              <div><label class="block mb-2">Path to ${window.electronAPI?.platform === 'win32' ? 'gmsh.exe' : 'gmsh'}</label><div class="flex space-x-2"><input type="text" id="setting-gmsh" class="form-input flex-grow"><button data-path-for="setting-gmsh" data-dialog="file-exe" class="path-select-btn action-btn">Browse...</button></div></div>
              <div><label class="block mb-2">Downloads Folder (.step)</label><div class="flex space-x-2"><input type="text" id="setting-downloads" class="form-input flex-grow"><button data-path-for="setting-downloads" data-dialog="directory" class="path-select-btn action-btn">Browse...</button></div></div>
            </div>
          </div>
        </div>

        <div id="display-panel" class="control-group">
          <div class="control-label-toggle"><span>Display & Windows</span>${arrowSVG}</div>
          <div class="p-4 overflow-hidden space-y-6">
            <div class="space-y-3"><h3 class="text-lg font-semibold text-white">Interface Size</h3><div class="flex items-center space-x-4"><button data-zoom="0.8" class="zoom-btn action-btn">Small</button><button data-zoom="1.0" class="zoom-btn action-btn">Normal</button><button data-zoom="1.2" class="zoom-btn action-btn">Large</button></div></div>
            <div class="space-y-3">
              <h3 class="text-lg font-semibold text-white">Windows</h3>
              <div class="flex items-center justify-between"><label>Keep tool windows on top</label><label class="relative inline-flex items-center cursor-pointer"><input type="checkbox" id="setting-always-on-top" class="sr-only peer"><div class="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div></label></div>
              <div class="flex items-center justify-between">
                <label>Show startup disclaimer</label>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" id="setting-show-startup-info" class="sr-only peer">
                  <div class="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div>
                </label>
              </div>
            </div>
            <div class="space-y-3">
              <h3 class="text-lg font-semibold text-white">UI Options</h3>
              <div class="flex items-center justify-between">
                <label for="setting-ui-theme">Global Theme</label>
                <select id="setting-ui-theme" class="form-input w-48">
                  <option value="default">(Default)</option>
                  <option value="theme-dark-blue">Blue</option>
                  <option value="theme-high-contrast">White</option>
                </select>
              </div>
              <div class="flex items-center justify-between">
                <label for="setting-ui-reduced-motion">Reduce animations</label>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" id="setting-ui-reduced-motion" class="form-toggle">
                  <div class="toggle-switch-bg"></div>
                </label>
              </div>
              <div class="flex items-center justify-between">
                <label for="setting-ui-button-skin">Button skin</label>
                <select id="setting-ui-button-skin" class="form-input w-48">
                  <option value="striped">Striped (default)</option>
                  <option value="solid">Solid</option>
                </select>
              </div>
              <div class="space-y-3">
                <h3 class="text-lg font-semibold text-white">Sidebar module order</h3>
                <p class="text-xs text-gray-400">Select a module and move it up or down.</p>
                <div class="flex items-center gap-3">
                  <select id="setting-module-order" class="form-input flex-grow" size="8" style="height: 240px; min-height: 240px; line-height: 1.8;" aria-label="Module order"></select>
                  <div class="flex flex-col gap-2">
                    <button type="button" id="module-order-up" class="action-btn" title="Move up">Up</button>
                    <button type="button" id="module-order-down" class="action-btn" title="Move down">Down</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="templates-panel" class="control-group">
          <div class="control-label-toggle"><span>Formula Templates</span>${arrowSVG}</div>
          <div class="p-4 pb-6 overflow-hidden">
            <div id="template-editors" class="space-y-2"></div>
          </div>
        </div>

        <div id="hotkeys-panel" class="control-group">
          <div class="control-label-toggle"><span>Shortcuts</span>${arrowSVG}</div>
          <div class="p-4 pb-6 overflow-hidden">
            
            <!-- Waveguide Studio Shortcuts Sub-Panel -->
            <div class="control-group mb-4">
              <div class="control-label-toggle bg-gray-800 p-2 rounded"><span>Waveguide Studio</span>${arrowSVG}</div>
              <div class="p-4 pb-6 overflow-hidden">
                <p class="text-xs text-gray-400 mb-3">Shortcuts for Waveguide Studio operations.</p>
                <div class="grid grid-cols-2 gap-x-8 gap-y-3 mb-4">
                  <div><label>Split Horizontal/Vertical</label><input type="text" id="setting-hotkey-split" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Show/Hide 3D Surface</label><input type="text" id="setting-hotkey-surface" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Show/Hide Points</label><input type="text" id="setting-hotkey-points" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Export Window</label><input type="text" id="setting-hotkey-export" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Open/Close Panels</label><input type="text" id="setting-hotkey-togglePanels" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Build Interface</label><input type="text" id="setting-hotkey-buildInterface" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                </div>
              </div>
            </div>

            <!-- Horn Studio Shortcuts Sub-Panel -->
            <div class="control-group mb-4">
              <div class="control-label-toggle bg-gray-800 p-2 rounded"><span>Horn Studio</span>${arrowSVG}</div>
              <div class="p-4 pb-6 overflow-hidden">
                <p class="text-xs text-gray-400 mb-3">Shortcuts for Horn Studio operations.</p>
                <div class="grid grid-cols-2 gap-x-8 gap-y-3 mb-4">
                  <div><label>Split Horizontal/Vertical</label><input type="text" id="setting-hotkey-hsSplit" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Show Interface</label><input type="text" id="setting-hotkey-hsInterface" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Open/Close Panels</label><input type="text" id="setting-hotkey-hsTogglePanels" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Export Menu</label><input type="text" id="setting-hotkey-hsExport" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Reset Parameters</label><input type="text" id="setting-hotkey-hsReset" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                </div>
              </div>
            </div>

            <!-- BEM Solver Shortcuts Sub-Panel -->
            <div class="control-group mb-4">
              <div class="control-label-toggle bg-gray-800 p-2 rounded"><span>BEM Solver</span>${arrowSVG}</div>
              <div class="p-4 pb-6 overflow-hidden">
                <p class="text-xs text-gray-400 mb-3">Shortcuts for BEM Solver visibility.</p>
                <div class="grid grid-cols-2 gap-x-8 gap-y-3 mb-4">
                  <div><label>Show/Hide All Elements</label><input type="text" id="setting-hotkey-bemToggleElements" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Show/Hide All Observation Fields</label><input type="text" id="setting-hotkey-bemToggleFields" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                </div>
              </div>
            </div>

            <!-- Main Shortcuts Sub-Panel -->
            <div class="control-group mb-4">
              <div class="control-label-toggle bg-gray-800 p-2 rounded"><span>Main Shortcuts</span>${arrowSVG}</div>
              <div class="p-4 pb-6 overflow-hidden">
                <p class="text-xs text-gray-400 mb-3">General application shortcuts.</p>
                <div class="grid grid-cols-2 gap-x-8 gap-y-3 mb-4">
                  <div><label>Close Window/Panel</label><input type="text" id="setting-hotkey-escape" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Minimize Window</label><input type="text" id="setting-hotkey-minimize" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                  <div><label>Save Module Page</label><input type="text" id="setting-hotkey-saveModule" class="form-input w-full hotkey-input" placeholder="Press keys" autocomplete="off"></div>
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>

      <div class="flex-shrink-0 pt-4 space-y-2">
        <button id="save-settings-btn" class="w-full px-4 py-2 border border-red-500 text-red-500 rounded-md hover:bg-red-500 hover:text-white">Save</button>
        <div class="flex space-x-2"><button id="show-help-btn" class="w-full px-4 py-2 border border-red-500 text-red-500 rounded-md hover:bg-red-500 hover:text-white">Help</button><button id="reset-settings-btn" class="w-full px-4 py-2 border border-red-500 text-red-500 rounded-md hover:bg-red-500 hover:text-white">Reset</button></div>
      </div>
    </div>
  `;
}

export function initializeSettingsPanel(rootElement) {
  const get = (sel) => rootElement.querySelector(sel);
  const getAll = (sel) => rootElement.querySelectorAll(sel);

  async function applyFeatureVisibility() {
    const features = await window.electronAPI.getFeatures();
  }

  function adjustTextareaHeight(textarea) {
    if (!textarea) return;
    textarea.style.boxSizing = 'border-box';
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }

  // Fonction pour recalculer la hauteur des parents
  function updateParentHeights(element) {
    let parent = element.parentElement;
    while (parent && parent !== rootElement) {
      if (parent.style.maxHeight && parent.style.maxHeight !== '0px' && parent.style.maxHeight !== 'none') {
        parent.style.maxHeight = parent.scrollHeight + 'px';
      }
      parent = parent.parentElement;
    }
  }

  getAll('.control-label-toggle').forEach(header => {
    const content = header.nextElementSibling;
    const arrow = header.querySelector('.toggle-arrow');
    const parentGroup = header.closest('.control-group');
    
    // Initialiser l'état : updates-panel ouvert, le reste fermé
    if (parentGroup && parentGroup.id === 'updates-panel') {
      content.style.maxHeight = content.scrollHeight + 'px';
      arrow?.classList.add('rotate-180');
    } else {
      content.style.maxHeight = '0px';
      arrow?.classList.remove('rotate-180');
    }
    
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = content.style.maxHeight && content.style.maxHeight !== '0px';
      
      if (isOpen) {
        content.style.maxHeight = '0px';
        arrow?.classList.remove('rotate-180');
        setTimeout(() => updateParentHeights(content), 350);
      } else {
        content.style.maxHeight = content.scrollHeight + 'px';
        arrow?.classList.add('rotate-180');
        setTimeout(() => updateParentHeights(content), 350);
      }
    });
  });

  const pathInputs = {
    gmsh: get('#setting-gmsh'),
    downloads: get('#setting-downloads'),
    dataRoot: get('#setting-dataRoot')
  };
  const hotkeyInputs = { split: get('#setting-hotkey-split'), surface: get('#setting-hotkey-surface'), points: get('#setting-hotkey-points'), export: get('#setting-hotkey-export'), togglePanels: get('#setting-hotkey-togglePanels'), buildInterface: get('#setting-hotkey-buildInterface'), hsTogglePanels: get('#setting-hotkey-hsTogglePanels'), hsSplit: get('#setting-hotkey-hsSplit'), hsInterface: get('#setting-hotkey-hsInterface'), hsExport: get('#setting-hotkey-hsExport'), hsReset: get('#setting-hotkey-hsReset'), bemToggleElements: get('#setting-hotkey-bemToggleElements'), bemToggleFields: get('#setting-hotkey-bemToggleFields'), escape: get('#setting-hotkey-escape'), minimize: get('#setting-hotkey-minimize'), saveModule: get('#setting-hotkey-saveModule') };
  const saveBtn = get('#save-settings-btn');
  const resetBtn = get('#reset-settings-btn');
  const helpBtn = get('#show-help-btn');
  const zoomButtons = getAll('.zoom-btn');
  const alwaysOnTopToggle = get('#setting-always-on-top');
  const showStartupInfoToggle = get('#setting-show-startup-info');
  const themeSelect = get('#setting-ui-theme');
  const reducedMotionToggle = get('#setting-ui-reduced-motion');
  const buttonSkinSelect = get('#setting-ui-button-skin');
  const moduleOrderSelect = get('#setting-module-order');
  const moduleOrderUpBtn = get('#module-order-up');
  const moduleOrderDownBtn = get('#module-order-down');
  const moduleLabels = {
    geometry: 'Geometry', power: 'Calculator', mesh: 'Mesh & Frequency', drivers: 'Driver DB',
    notes: 'Notes', horn: 'Horn Expansion', akabak_lem: 'Akabak LEM', hornstudio: 'Horn Studio',
    directivity: 'BEM Solver', waveguide: 'Waveguide Studio', settings: 'Configuration'
  };
  const defaultModuleOrder = Object.keys(moduleLabels);
  let moduleOrder = [...defaultModuleOrder];

  function renderModuleOrder() {
    if (!moduleOrderSelect) return;
    moduleOrderSelect.innerHTML = '';
    moduleOrder.forEach(moduleName => {
      const option = document.createElement('option');
      option.value = moduleName;
      option.textContent = moduleLabels[moduleName] || moduleName;
      moduleOrderSelect.appendChild(option);
    });
    moduleOrderSelect.selectedIndex = Math.min(moduleOrderSelect.selectedIndex, moduleOrder.length - 1);
  }

  function moveModule(delta) {
    const index = moduleOrderSelect?.selectedIndex ?? -1;
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= moduleOrder.length) return;
    [moduleOrder[index], moduleOrder[targetIndex]] = [moduleOrder[targetIndex], moduleOrder[index]];
    renderModuleOrder();
    moduleOrderSelect.selectedIndex = targetIndex;
  }

  moduleOrderUpBtn?.addEventListener('click', () => moveModule(-1));
  moduleOrderDownBtn?.addEventListener('click', () => moveModule(1));
  // --- Template Editor System ---
  function escAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function createGridLine(param, value, container) {
    const div = document.createElement('div');
    div.className = 'template-line';
    div.style.cssText = 'display:grid; grid-template-columns:minmax(60px,auto) 16px 1fr 28px; align-items:center; gap:8px; padding:4px 0;';
    div.innerHTML = `
      <input type="text" class="template-param form-input font-mono" style="height:30px; font-size:13px; text-align:center; padding:4px 8px;" value="${escAttr(param)}" spellcheck="false" placeholder="param">
      <span style="color:var(--border-subtle); font-family:monospace; text-align:center; user-select:none;">=</span>
      <input type="text" class="template-value form-input font-mono" style="height:30px; font-size:13px; padding:4px 8px;" value="${escAttr(value)}" spellcheck="false" placeholder="value">
      <button class="template-remove-line" style="width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:var(--radius-md); border:1px solid transparent; color:var(--text-muted); opacity:0; cursor:pointer; transition:all 150ms; background:transparent; font-size:16px;" title="Remove line">&times;</button>`;
    div.addEventListener('mouseenter', () => { div.querySelector('.template-remove-line').style.opacity = '1'; });
    div.addEventListener('mouseleave', () => { div.querySelector('.template-remove-line').style.opacity = '0'; });
    container.appendChild(div);
  }

  function buildTemplateEditors() {
    const container = get('#template-editors');
    if (!container) return;
    container.innerHTML = '';
    let currentGroup = null;
    Object.entries(templateMeta).forEach(([key, meta]) => {
      if (meta.group !== currentGroup) {
        if (currentGroup) {
          const sep = document.createElement('div');
          sep.style.cssText = 'height:1px; background:var(--border-subtle); margin:16px 0; opacity:0.4;';
          container.appendChild(sep);
        }
        currentGroup = meta.group;
        const heading = document.createElement('h3');
        heading.textContent = meta.group;
        heading.style.cssText = 'font-size:15px; font-weight:600; color:var(--text-body); margin:0 0 8px 0; letter-spacing:0.02em;';
        container.appendChild(heading);
      }
      const card = document.createElement('div');
      card.dataset.templateKey = key;
      card.style.cssText = 'margin-bottom:12px; border-radius:var(--radius-lg); border:1px solid var(--border-subtle); background:var(--card-bg); overflow:hidden; transition:border-color 150ms;';
      card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--border-primary)'; });
      card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border-subtle)'; });

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 16px; border-bottom:1px solid var(--border-subtle); background:rgba(0,0,0,0.15);';
      header.innerHTML = `
        <span style="font-size:13px; font-weight:500; color:var(--text-body); letter-spacing:0.01em;">${meta.label}</span>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="template-preview-btn" style="font-size:11px; padding:3px 10px; border-radius:var(--radius-md); border:1px solid var(--border-subtle); color:var(--text-muted); background:transparent; cursor:pointer; transition:all 150ms; letter-spacing:0.02em;">Preview</button>
          <button class="template-reset-btn" style="font-size:11px; padding:3px 10px; border-radius:var(--radius-md); border:1px solid var(--border-subtle); color:var(--text-muted); background:transparent; cursor:pointer; transition:all 150ms; letter-spacing:0.02em;">Reset</button>
        </div>`;
      card.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.style.cssText = 'padding:12px 16px;';
      if (meta.mode === 'grid') {
        body.innerHTML = '<div class="template-lines" style="display:flex; flex-direction:column; gap:2px;"></div>';
      } else {
        body.innerHTML = '<textarea class="template-code-editor form-input font-mono" style="width:100%; min-height:120px; font-size:13px; line-height:1.6; padding:10px 12px; resize:vertical; height:auto;" spellcheck="false" rows="6"></textarea>';
      }
      card.appendChild(body);

      // Preview area (hidden by default)
      const previewArea = document.createElement('div');
      previewArea.className = 'template-preview-area hidden';
      previewArea.style.cssText = 'padding:0 16px 12px;';
      previewArea.innerHTML = `
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px; letter-spacing:0.02em;">Output preview (segment #3) :</div>
        <pre style="background:var(--bg-input); border-radius:var(--radius-md); border:1px solid var(--border-subtle); padding:10px 12px; font-family:monospace; font-size:12px; color:var(--border-primary); white-space:pre; overflow-x:auto; line-height:1.6; margin:0;"></pre>`;
      card.appendChild(previewArea);

      // Footer
      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 16px 10px; border-top:1px solid rgba(255,255,255,0.03);';
      const varBadgesHtml = meta.vars.map(v => `<span style="font-size:10px; padding:2px 8px; border-radius:var(--radius-md); background:var(--bg-input); color:var(--text-muted); font-family:monospace; border:1px solid var(--border-subtle); letter-spacing:0.03em;">${v}</span>`).join('');
      footer.innerHTML = `
        ${meta.mode === 'grid' ? '<button class="template-add-line-btn" style="font-size:12px; color:var(--text-muted); background:transparent; border:none; cursor:pointer; padding:2px 4px; transition:color 150ms; letter-spacing:0.01em;">+ Add line</button>' : '<span></span>'}
        <div style="display:flex; gap:6px; flex-wrap:wrap;">${varBadgesHtml}</div>`;
      card.appendChild(footer);

      container.appendChild(card);

      const ta = card.querySelector('.template-code-editor');
      if (ta) ta.addEventListener('input', () => adjustTextareaHeight(ta));
    });

    // Hover effects for small buttons
    container.addEventListener('mouseover', (e) => {
      if (e.target.classList.contains('template-preview-btn')) { e.target.style.color = 'var(--border-primary)'; e.target.style.borderColor = 'var(--border-primary)'; }
      if (e.target.classList.contains('template-reset-btn')) { e.target.style.color = '#f87171'; e.target.style.borderColor = '#f87171'; }
      if (e.target.classList.contains('template-add-line-btn')) { e.target.style.color = 'var(--border-primary)'; }
      if (e.target.classList.contains('template-remove-line')) { e.target.style.color = '#f87171'; e.target.style.borderColor = '#f87171'; }
    });
    container.addEventListener('mouseout', (e) => {
      if (e.target.classList.contains('template-preview-btn') || e.target.classList.contains('template-reset-btn')) { e.target.style.color = 'var(--text-muted)'; e.target.style.borderColor = 'var(--border-subtle)'; }
      if (e.target.classList.contains('template-add-line-btn')) { e.target.style.color = 'var(--text-muted)'; }
      if (e.target.classList.contains('template-remove-line')) { e.target.style.color = 'var(--text-muted)'; e.target.style.borderColor = 'transparent'; }
    });

    container.addEventListener('click', (e) => {
      const target = e.target;
      const card = target.closest('[data-template-key]');
      if (!card) return;
      const key = card.dataset.templateKey;
      const meta = templateMeta[key];
      if (target.classList.contains('template-preview-btn')) {
        const area = card.querySelector('.template-preview-area');
        const pre = area.querySelector('pre');
        if (!area.classList.contains('hidden')) { area.classList.add('hidden'); target.textContent = 'Preview'; }
        else {
          let str;
          if (meta.mode === 'grid') {
            const lines = []; card.querySelectorAll('.template-line').forEach(el => { const p = el.querySelector('.template-param').value.trim(); const v = el.querySelector('.template-value').value.trim(); if (p) lines.push({param:p, value:v}); });
            str = serializeLines(lines);
          } else { str = card.querySelector('.template-code-editor').value; }
          pre.textContent = getPreview(str, 3);
          area.classList.remove('hidden');
          target.textContent = 'Hide';
        }
        updateParentHeights(card);
      } else if (target.classList.contains('template-reset-btn')) {
        const def = defaultTemplates[key];
        if (meta.mode === 'grid') {
          const lc = card.querySelector('.template-lines'); lc.innerHTML = '';
          parseTemplateToLines(def).forEach(l => createGridLine(l.param, l.value, lc));
        } else { const ta = card.querySelector('.template-code-editor'); ta.value = def; adjustTextareaHeight(ta); }
        updateParentHeights(card);
      } else if (target.classList.contains('template-add-line-btn')) {
        const lc = card.querySelector('.template-lines');
        createGridLine('', '', lc);
        lc.lastElementChild.querySelector('.template-param').focus();
        updateParentHeights(card);
      } else if (target.classList.contains('template-remove-line')) {
        const line = target.closest('.template-line');
        const lc = line.parentElement;
        if (lc.querySelectorAll('.template-line').length > 1) { line.remove(); updateParentHeights(card); }
      }
    });
  }

  function loadTemplateValues(templates) {
    Object.entries(templateMeta).forEach(([key, meta]) => {
      const card = rootElement.querySelector(`[data-template-key="${key}"]`);
      if (!card) return;
      const val = templates?.[key] || defaultTemplates[key];
      if (meta.mode === 'grid') {
        const lc = card.querySelector('.template-lines'); lc.innerHTML = '';
        parseTemplateToLines(val).forEach(l => createGridLine(l.param, l.value, lc));
      } else { const ta = card.querySelector('.template-code-editor'); if (ta) { ta.value = val; adjustTextareaHeight(ta); } }
    });
  }

  function collectTemplateValues() {
    const result = {};
    Object.entries(templateMeta).forEach(([key, meta]) => {
      const card = rootElement.querySelector(`[data-template-key="${key}"]`);
      if (!card) return;
      if (meta.mode === 'grid') {
        const lines = []; card.querySelectorAll('.template-line').forEach(el => { const p = el.querySelector('.template-param').value.trim(); const v = el.querySelector('.template-value').value.trim(); if (p) lines.push({param:p, value:v}); });
        result[key] = serializeLines(lines);
      } else { result[key] = card.querySelector('.template-code-editor')?.value || defaultTemplates[key]; }
    });
    return result;
  }

  const normalizeShortcut = (event) => {
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');

    const key = event.key.toLowerCase();
    const isModifierOnly = ['control', 'shift', 'alt', 'meta'].includes(key);
    if (!isModifierOnly) {
      if (key === ' ') parts.push('space');
      else parts.push(key);
    }

    if (parts.length === 0) return '';
    return parts.join('+');
  };

  const formatShortcutDisplay = (shortcut) => shortcut.split('+').map(part => {
    if (!part) return '';
    if (part.length === 1) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join('+');

  Object.values(hotkeyInputs).forEach(input => {
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') return; // allow navigation
      e.preventDefault();

      // Effacer si Backspace/Delete sans modificateurs
      if (['Backspace', 'Delete'].includes(e.key) && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        input.value = '';
        delete input.dataset.shortcutRaw;
        return;
      }

      const normalized = normalizeShortcut(e);
      if (!normalized) return;

      input.dataset.shortcutRaw = normalized.toLowerCase();
      input.value = formatShortcutDisplay(normalized);
    });
  });

  let currentSettings = {};

  async function loadCurrentSettings() {
    currentSettings = await getSettings();
    if (!currentSettings) currentSettings = {};
    if (!currentSettings.templates) currentSettings.templates = {};
    Object.entries(pathInputs).forEach(([k, el]) => { if (el) el.value = currentSettings.paths?.[k] || ''; });
    Object.entries(hotkeyInputs).forEach(([k, el]) => {
      if (!el) return;
      const saved = currentSettings.hotkeys?.[k] || '';
      el.value = saved ? formatShortcutDisplay(saved) : '';
      if (saved) el.dataset.shortcutRaw = saved.toLowerCase(); else delete el.dataset.shortcutRaw;
    });
    if (alwaysOnTopToggle) alwaysOnTopToggle.checked = !!currentSettings.popupsAlwaysOnTop;
    if (showStartupInfoToggle) showStartupInfoToggle.checked = currentSettings.showStartupInfo !== false;
    const ui = currentSettings.ui || { theme: 'default', reducedMotion: false, buttonSkin: 'striped', moduleOrder: defaultModuleOrder };
    if (themeSelect) themeSelect.value = ['default', 'theme-dark-blue', 'theme-high-contrast'].includes(ui.theme) ? ui.theme : 'default';
    if (reducedMotionToggle) reducedMotionToggle.checked = !!ui.reducedMotion;
    if (buttonSkinSelect) buttonSkinSelect.value = ui.buttonSkin || 'striped';
    moduleOrder = (ui.moduleOrder || []).filter(name => moduleLabels[name]);
    defaultModuleOrder.forEach(name => { if (!moduleOrder.includes(name)) moduleOrder.push(name); });
    renderModuleOrder();
    loadTemplateValues(currentSettings.templates);
    applyUiSettings(ui);
  }

  // Appliquer le thème en temps réel quand on change le sélecteur
  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      const ui = {
        theme: themeSelect.value || 'default',
        reducedMotion: reducedMotionToggle?.checked || false,
        buttonSkin: buttonSkinSelect?.value || 'striped'
      };
      applyUiSettings(ui);
    });
  }

  if (buttonSkinSelect) {
    buttonSkinSelect.addEventListener('change', () => {
      const ui = {
        theme: themeSelect?.value || 'default',
        reducedMotion: reducedMotionToggle?.checked || false,
        buttonSkin: buttonSkinSelect.value || 'striped'
      };
      applyUiSettings(ui);
    });
  }

  saveBtn.addEventListener('click', async () => {
    currentSettings = await getSettings();
    currentSettings.paths = Object.fromEntries(Object.entries(pathInputs).map(([k, v]) => [k, v.value]));
    currentSettings.hotkeys = Object.fromEntries(Object.entries(hotkeyInputs).map(([k, v]) => {
      if (!v) return [k, ''];
      const raw = (v.dataset.shortcutRaw || v.value.trim()).toLowerCase();
      return [k, raw];
    }));
    currentSettings.popupsAlwaysOnTop = !!alwaysOnTopToggle?.checked;
    currentSettings.showStartupInfo = !!showStartupInfoToggle?.checked;
    currentSettings.ui = { theme: themeSelect?.value || 'default', reducedMotion: !!reducedMotionToggle?.checked, buttonSkin: buttonSkinSelect?.value || 'striped', moduleOrder: [...moduleOrder] };
    currentSettings.templates = collectTemplateValues();

    applyUiSettings(currentSettings.ui);
    await window.electronAPI.setSettings(currentSettings);
    
    window.panelEvents.dispatchEvent(new CustomEvent('settings-updated', {
      detail: { newSettings: currentSettings }
    }));

    saveBtn.textContent = 'Saved! Reload app to apply path changes.';
    setTimeout(() => { saveBtn.textContent = 'Save'; }, 3500);
  });

  resetBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to reset all settings? The application will reload.')) return;
    await window.electronAPI.resetSettings();
  });

  helpBtn.addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-8';
    modal.innerHTML = getHelpContentHtml();
    document.body.appendChild(modal);
    initializeManualPanel(modal);
    const closeButton = modal.querySelector('#close-help-modal');
    const closeModal = () => { if (document.body.contains(modal)) document.body.removeChild(modal); };
    closeButton.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  });

  zoomButtons.forEach(btn => btn.addEventListener('click', async () => {
    const zoomLevel = parseFloat(btn.dataset.zoom);
    window.electronAPI.setZoom(zoomLevel);
    const settings = await getSettings();
    settings.enableScaling = true;
    settings.zoomLevel = zoomLevel;
    await window.electronAPI.setSettings(settings);
  }));
  
  rootElement.querySelectorAll('.path-select-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const inputId = button.dataset.pathFor;
      const dialogType = button.dataset.dialog;
      const inputElement = rootElement.querySelector(`#${inputId}`);
      if (!inputElement) return;

      let selectedPath = null;
      if (dialogType === 'directory') {
        selectedPath = await window.electronAPI.selectDirectory();
      } else {
        const filters = [];
        // Les exécutables n'ont une extension que sous Windows : filtrer sur
        // 'exe' ailleurs masquerait le binaire que l'utilisateur cherche.
        if (dialogType === 'file-exe' && window.electronAPI.platform === 'win32') {
          filters.push({ name: 'Executable', extensions: ['exe'] });
        }
        filters.push({ name: 'All Files', extensions: ['*'] });
        selectedPath = await window.electronAPI.selectFile({ filters });
      }

      if (selectedPath) {
        inputElement.value = selectedPath;
      }
    });
  });

  applyFeatureVisibility();
  buildTemplateEditors();
  loadCurrentSettings();
  setTimeout(() => { const firstPanelContent = rootElement.querySelector('#updates-panel .control-label-toggle')?.nextElementSibling; if (firstPanelContent) firstPanelContent.style.maxHeight = firstPanelContent.scrollHeight + 'px'; }, 150);
}