// =======================================================
// FICHIER :  src/preload.js
// =======================================================
const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] Starting preload.js execution...');

contextBridge.exposeInMainWorld('electronAPI', {
  // Plateforme hôte ('win32' | 'linux' | 'darwin'). Exposée en valeur et non en
  // fonction IPC : le renderer en a besoin de façon synchrone pour adapter les
  // libellés et les filtres de fichiers (ex. gmsh.exe uniquement sous Windows).
  platform: process.platform,

  // --- [CORRECTION CRITIQUE] On expose les handlers IPC, pas les fonctions Node directes ---
  joinPath: (...args) => ipcRenderer.invoke('path:join', ...args),
  isPathAbsolute: (p) => ipcRenderer.invoke('path:is-absolute', p),

  // --- Général ---
  openToolInNewWindow: (tool) => ipcRenderer.send('open-tool-in-new-window', tool),
  getToolNameToLoad: () => process.argv.find(arg => arg.startsWith('--tool='))?.split('=')[1] || null,
  getFeatures: () => ipcRenderer.invoke('features:get-all'),
  openPath: (filePath) => ipcRenderer.send('shell:open-path', filePath),

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  setZoom: (level) => ipcRenderer.send('set-zoom', level),
  
  // --- Fichiers & Dialogues Locaux ---
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  saveFile: (args) => ipcRenderer.invoke('fs:save-file', args),
  saveFileAs: (args) => ipcRenderer.invoke('dialog:save-file', args),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  selectFile: (options) => ipcRenderer.invoke('dialog:select-file', options),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  saveFileInDirectory: (args) => ipcRenderer.invoke('save-file-in-directory', args),
  listDirectory: (dirPath) => ipcRenderer.invoke('fs:list-directory', dirPath),
  selectMeshFile: () => ipcRenderer.invoke('select-mesh-file'),

  // --- Panneaux Spécifiques ---
  getAllDrivers: () => ipcRenderer.invoke('db:get-all-drivers'),
  deleteDriver: (driverName) => ipcRenderer.invoke('db:delete-driver', driverName),
  addDriver: (driver) => ipcRenderer.invoke('db:add-driver', driver),
  getDriverById: (driverId) => ipcRenderer.invoke('db:get-driver-by-id', driverId),
  getNotesTree: () => ipcRenderer.invoke('notes:get-file-tree'),
  runMesh: (args) => ipcRenderer.invoke('run-mesh', args),
  exportWaveguideStep: (args) => ipcRenderer.invoke('waveguide:export-step', args),
  parseMshPreview: (mshPath) => ipcRenderer.invoke('parse-msh-preview', mshPath),
  applyMirrorMsh: (args) => ipcRenderer.invoke('apply-mirror-msh', args),
  openMeshPreview: (data) => ipcRenderer.send('open-mesh-preview', data),
  showMeshPreview: () => ipcRenderer.send('show-mesh-preview'),
  getMeshPreviewData: () => ipcRenderer.invoke('get-mesh-preview-data'),
  savePreviewState: (state) => ipcRenderer.send('save-preview-state', state),
  onReloadPreview: (callback) => ipcRenderer.on('reload-preview', (event, data) => callback(data)),
  onShowMeshPreviewToast: (callback) => ipcRenderer.on('show-mesh-preview-toast', (event, data) => callback(data)),
  getLastPreviewState: () => ipcRenderer.invoke('get-last-preview-state'),
  remeshPreview: (args) => ipcRenderer.invoke('remesh-preview', args),
  exportMesh: (args) => ipcRenderer.invoke('export-mesh', args),

  // --- Actions de fenêtre et Alias ---
  saveDriverData: (args) => ipcRenderer.invoke('fs:save-file', args),
  saveNote: (args) => ipcRenderer.invoke('fs:save-file', args),
  windowAction: (action) => ipcRenderer.send('window-action', action),

  // --- Akabak LEM ---
  generateLemFile: (args) => ipcRenderer.invoke('akabak-lem:generate', args),

  // --- CFD OpenFOAM (via WSL) ---
  foamCheckAvailability: (options) => ipcRenderer.invoke('foam:check-availability', options),
  foamRunVentCfd: (spec) => ipcRenderer.invoke('foam:run-vent-cfd', spec),
  foamCancel: () => ipcRenderer.invoke('foam:cancel'),
  onFoamProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('foam:progress', listener);
    return () => ipcRenderer.removeListener('foam:progress', listener);
  },
  foamInstallOpenFoam: (options) => ipcRenderer.invoke('foam:install-openfoam', options),
  foamCancelInstall: () => ipcRenderer.invoke('foam:cancel-install'),
  onFoamInstallProgress: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('foam:install-progress', listener);
    return () => ipcRenderer.removeListener('foam:install-progress', listener);
  },

  // --- Waveguide Presets ---
  getWaveguidePresets: () => ipcRenderer.invoke('waveguide-presets:get-all'),
  saveWaveguidePreset: (preset) => ipcRenderer.invoke('waveguide-presets:save', preset),
  deleteWaveguidePreset: (name) => ipcRenderer.invoke('waveguide-presets:delete', name),

  // --- Horn Studio Presets ---
  getHornPresets: () => ipcRenderer.invoke('horn-presets:get-all'),
  saveHornPreset: (preset) => ipcRenderer.invoke('horn-presets:save', preset),
  deleteHornPreset: (name) => ipcRenderer.invoke('horn-presets:delete', name),

  // --- Crossover Presets ---
  getCrossoverPresets: () => ipcRenderer.invoke('crossover-presets:get-all'),
  saveCrossoverPreset: (preset) => ipcRenderer.invoke('crossover-presets:save', preset),
  deleteCrossoverPreset: (name) => ipcRenderer.invoke('crossover-presets:delete', name),
});

console.log('[PRELOAD] electronAPI successfully exposed to window object');