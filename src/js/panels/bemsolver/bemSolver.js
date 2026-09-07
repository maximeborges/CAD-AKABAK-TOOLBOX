// =======================================================
// FICHIER :  src/js/panels/bemsolver/bemSolver.js
// RÔLE    :  BEM Solver panel (ex-Directivity Calculator)
//            • Accurate 2D piston/horn model with frequency-
//              dependent effective aperture per expansion type
//            • REW-style rainbow heatmap rendered per-pixel
//            • Half-circle polar plot with dB rings
//            • Beamwidth (-6 dB) vs frequency curve
//            • Akabak-style BEM Config tab (3D mesh view, subdomain tree,
//              Subdomain/Observation/Frequency popups) + Graphs tab
// =======================================================

import {
  SPEED_OF_SOUND,
  sinc,
  linearToDb,
  dbToLinear,
  calculateWaveNumber,
  clamp
} from '../../utils/acousticMath.js';
import {
  interpolateBemPolar,
  polarBeamwidthMinus6,
  pickAutoFrequencies,
} from '../../bem/bemHornBackend.js';
import { solveBemDomains, solveBemFields, abortBemDomains } from '../../bem/bemDomainBackend.js';
import { createBemMeshViewer } from './bemMeshViewer.js';
import { buildDiaphragmMesh } from './diaphragmMesh.js';
import { buildFieldGeometry, deformBalloon, gridIsoContour } from './fieldGeometry.js';
import { buildStreamlines, buildIsoLines, peakFlowPhase } from './flowLines.js';
import { filterChainGain, filterChainGainDb } from './bemFilters.js';

const P_REF = 2e-5;
const DEFAULT_DRIVE_VRMS = 2.83;

// Cinq bandes suffisent à caler un passe-haut, un passe-bas et trois cloches ;
// au-delà on ne règle plus une enceinte, on masque un défaut de conception.
const BEM_FILTER_SLOTS = 5;

// Bornes par défaut du graphe SPL (les Hz sont réalignés sur la simulation dès qu'elle existe).
const DEFAULT_SPL_DB_MIN = 70;
const DEFAULT_SPL_DB_MAX = 120;
const DEFAULT_SPL_FMIN = 50;
const DEFAULT_SPL_FMAX = 20000;

// Excursion crête simple sens : la moitié de la course totale, comme les Xmax
// publiés par les constructeurs.
const DEFAULT_EXC_MM_MAX = 10;

/** Orientations proposées aux composants (baffle, diaphragme). */
const BEM_AXES = [
  { value: '+x', label: '+X' }, { value: '-x', label: '-X' },
  { value: '+y', label: '+Y' }, { value: '-y', label: '-Y' },
  { value: '+z', label: '+Z' }, { value: '-z', label: '-Z' },
];

// --------------------------------------------------------
//  MODULE STATE
// --------------------------------------------------------
let advancedGeometryData = null;
let currentResults = null;
let currentSegments = null;      // raw segs from Horn Studio (Pro mode)
let bemResults = null;            // results of last BEM run
let bemRequestedRange = null;     // { fMin, fMax } from last BEM run, used to clamp heatmap axis
let bemHasCompletedRun = false;
// Les workers gardent la solution surfacique du dernier Start Sim : c'est elle
// que « Start field » rejoue. Un projet rechargé n'en dispose pas.
let bemWorkersHaveSolution = false;
const bemPanelRoots = new Set();

// SPL result computed from BEM on-axis pressure + optional driver coupling.
let splData = null;               // { freqs, splDb, driverName, vRMS, baffleGainDB, SR, Sd_cm2, St_cm2 }
// Courbes figées : elles ne dépendent plus ni du maillage ni du solve courant,
// et survivent donc à une resimulation comme à un rechargement du .TBBS.
let splSnapshots = [];            // [{ id, name, color, visible, freqs, splDb, xPeakMm }]
let splSnapshotSeq = 0;
let bemDriverDbPromise = null;

// Fourni par Waveguide Studio à l'initialisation. Async, signature
//   ({ clmax, curvature }) -> { mshContent, geoContent, meshMeta }
// Il fait tourner Gmsh sur la géométrie courante via le même .geo et les mêmes
// arguments que le bouton « Export MSH », et rend le maillage en mémoire.
// Reste null quand le panneau tourne seul, hors Waveguide Studio : le worker
// retombe alors sur son maillage paramétrique.
let bemMeshProvider = null;

// Mouth dimensions driving the analytic model, fed by the 'export-to-directivity'
// import event now that the manual Mouth Dimensions / Calculate UI is gone.
let lastMouthWidth = null;
let lastMouthHeight = null;

// --------------------------------------------------------
//  BEM CONFIG TAB STATE (model tree + 3D viewer + popups)
// --------------------------------------------------------
let bemMeshContent = null;   // texte brut du .msh importé, entrée du solveur
// Flat list of top-level tree nodes: subdomains then interfaces, each with its
// own (currently placeholder) surface list. Purely UI state for now.
let bemTreeItems = [];
let bemTreeSeq = 0;
// Maillages de diaphragmes calculés (id de composant → { nodes, tris, stats }).
// Ils servent à la fois à l'affichage 3D et à l'injection dans le solveur.
const bemDiaphragmMeshes = new Map();
// Nappes d'observation calculées (id de field → { points, tris, stats }).
const bemFieldGeometries = new Map();
// Dernière pression calculée sur les nappes : id de field → [{ f, mag, phaseDeg }].
let bemFieldResults = new Map();
// Champ CFD injecté sur une nappe : id de field → { freq, vRe, vIm, vMean,
// turbulence, valid, info }. Vaut pour UNE fréquence, celle qui a été résolue.
const bemFieldCfd = new Map();
// Un seul calcul CFD à la fois ; une demande arrivée pendant un calcul est
// rejouée à la fin, avec la fréquence affichée à ce moment-là.
let bemCfdBusy = false;
let bemCfdPending = false;
// Filtres appliqués à la tension d'attaque : [{type, freq_Hz, q, gain_dB, order}].
// Purement post-traitement — le BEM est linéaire, rien n'est resolvé.
let bemFilters = [];

// --------------------------------------------------------
//  SCOPED STYLES (no Tailwind — all rules prefixed #directivity-root)
// --------------------------------------------------------
const DIR_STYLES = `
#directivity-root {
  /* Mapped onto the app's dynamic theme variables (theme-variables.css) so the
     panel re-skins itself with the rest of the app when the theme changes. */
  --dir-bg: var(--bg-app, #0b0f17);
  --dir-panel: var(--card-bg, rgba(17, 24, 39, 0.72));
  --dir-panel-border: var(--border-subtle, rgba(75, 85, 99, 0.55));
  --dir-panel-border-strong: var(--border-primary, rgba(107, 114, 128, 0.7));
  --dir-muted: var(--text-muted, #9ca3af);
  --dir-text: var(--text-body, #e5e7eb);
  --dir-accent: var(--border-primary, #ec4899);
  --dir-accent-soft: var(--bg-hover, rgba(236, 72, 153, 0.15));
  --dir-rose: #f43f5e;
  --dir-emerald: var(--state-success, #10b981);
  --dir-amber: var(--state-warning, #f59e0b);
  --dir-purple: var(--text-link, #c084fc);
  padding: 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--dir-text);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  box-sizing: border-box;
}
#directivity-root *, #directivity-root *::before, #directivity-root *::after { box-sizing: border-box; }

#directivity-root .dir-header {
  display: flex; align-items: center;
  margin-bottom: 20px; flex-shrink: 0; gap: 20px;
}
#directivity-root .dir-header h1 {
  font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: -0.02em; margin: 0;
}
#directivity-root .dir-header p {
  font-size: 13px; color: var(--dir-muted); margin: 4px 0 0;
}

#directivity-root .dir-scroll {
  flex: 1 1 auto; overflow-y: auto; padding-right: 4px; min-height: 0;
  display: flex; flex-direction: column; gap: 20px;
}

#directivity-root .dir-card {
  background: var(--dir-panel);
  border: 1px solid var(--dir-panel-border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
#directivity-root .dir-results .dir-card {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
}
#directivity-root .dir-card-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
}
#directivity-root .dir-card-header h3 {
  font-size: 15px; font-weight: 600; color: #fff; margin: 0;
}

#directivity-root .dir-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
#directivity-root .dir-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
#directivity-root .dir-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

#directivity-root .dir-label {
  display: block; font-size: 11px; color: var(--dir-muted);
  text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; font-weight: 500;
}
#directivity-root .dir-input, #directivity-root .dir-select {
  width: 100%;
  background: rgba(15, 23, 42, 0.85);
  border: 1.5px solid var(--dir-panel-border);
  border-radius: 6px;
  color: var(--dir-text);
  font-size: 14px;
  padding: 8px 10px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
}
#directivity-root .dir-input:focus, #directivity-root .dir-select:focus {
  border-color: var(--dir-accent);
  box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.18);
}
#directivity-root .dir-input[readonly] {
  background: rgba(31, 41, 55, 0.6);
  color: var(--dir-purple);
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
#directivity-root .dir-select.-mono { font-family: ui-monospace, monospace; font-weight: 700; font-size: 16px; }

#directivity-root .dir-btn {
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; cursor: pointer;
  font-family: inherit; font-weight: 600;
  transition: background 0.15s, transform 0.05s, box-shadow 0.15s;
  color: #fff;
}
#directivity-root .dir-btn:active { transform: translateY(1px); }
#directivity-root .dir-btn.-primary {
  width: 100%; padding: 12px 16px; margin-top: 20px;
  font-size: 14px; letter-spacing: 0.02em;
  background: var(--btn-primary-bg, linear-gradient(135deg, #ec4899 0%, #db2777 100%));
  box-shadow: var(--btn-primary-shadow, 0 4px 14px rgba(236, 72, 153, 0.3));
}
#directivity-root .dir-btn.-primary:hover { background: var(--btn-primary-bg-hover, linear-gradient(135deg, #f472b6 0%, #ec4899 100%)); }
#directivity-root .dir-btn.-danger {
  padding: 6px 12px; font-size: 12px;
  background: rgba(190, 18, 60, 0.85);
}
#directivity-root .dir-btn.-danger:hover { background: rgba(225, 29, 72, 0.95); }
#directivity-root .dir-btn.-hidden { display: none; }
#directivity-root .dir-card.-hidden { display: none; }

#directivity-root .dir-advanced {
  margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--dir-panel-border);
}
#directivity-root .dir-advanced.-hidden { display: none; }
#directivity-root .dir-advanced-title {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--dir-purple); font-weight: 600;
}
#directivity-root .dir-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dir-purple); box-shadow: 0 0 8px var(--dir-purple); }

#directivity-root .dir-results.-hidden { display: none; }
#directivity-root .dir-results { display: flex; flex-direction: column; gap: 20px; flex: 1 1 auto; min-height: 0; }

#directivity-root .dir-summary-card {
  background: var(--dir-panel);
  border: 1px solid var(--dir-panel-border);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
#directivity-root .dir-summary-card .dir-summary-label {
  font-size: 10px; color: var(--dir-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 10px;
}
#directivity-root .dir-summary-value {
  font-size: 30px; font-weight: 700; font-family: ui-monospace, monospace; color: var(--dir-accent);
}

#directivity-root .dir-tabs-bar {
  display: flex; gap: 4px;
  border-bottom: 1px solid var(--dir-panel-border);
  margin-bottom: 18px;
  overflow-x: auto;
}
#directivity-root .dir-tab-btn {
  padding: 10px 16px; border: none; background: transparent;
  color: var(--dir-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; cursor: pointer; font-family: inherit;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
#directivity-root .dir-tab-btn:hover { color: #fff; }
#directivity-root .dir-tab-btn.-active { color: var(--dir-accent); border-bottom-color: var(--dir-accent); }

#directivity-root .dir-tab-content.-hidden { display: none; }
#directivity-root .dir-tab-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

#directivity-root .dir-tab-toolbar {
  flex-shrink: 0;
  display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-bottom: 14px;
}
#directivity-root .dir-toolbar-group { display: flex; align-items: center; gap: 8px; }
#directivity-root .dir-toolbar-group.-grow { flex: 1 1 260px; }
#directivity-root .dir-toolbar-group.-push { margin-left: auto; }
#directivity-root .dir-toolbar-label {
  font-size: 10px; color: var(--dir-muted); text-transform: uppercase; letter-spacing: 0.1em; white-space: nowrap;
}

#directivity-root .dir-segmented {
  display: inline-flex; border-radius: 6px; overflow: hidden;
  border: 1px solid var(--dir-panel-border);
}
#directivity-root .dir-segmented-btn {
  padding: 6px 14px; font-size: 12px; font-weight: 500; background: transparent;
  color: var(--dir-muted); border: none; cursor: pointer; font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
#directivity-root .dir-segmented-btn:hover { color: #fff; }
#directivity-root .dir-segmented-btn.-active { background: rgba(31, 41, 55, 1); color: #fff; }

#directivity-root .dir-mini-select {
  padding: 5px 8px; font-size: 12px; width: auto;
  background: rgba(15, 23, 42, 0.85);
  border: 1.5px solid var(--dir-panel-border);
  border-radius: 6px;
  color: var(--dir-text);
  font-family: inherit;
  outline: none;
}
#directivity-root .dir-mini-select:focus { border-color: var(--dir-accent); }

#directivity-root .dir-readout {
  font-family: ui-monospace, monospace; font-size: 12px;
  background: rgba(17, 24, 39, 0.85);
  border: 1px solid var(--dir-panel-border);
  padding: 5px 10px; border-radius: 6px;
  color: var(--dir-text);
  min-width: 220px; text-align: center;
}

#directivity-root .dir-check {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 12px; color: var(--dir-text);
}
#directivity-root .dir-check input[type="checkbox"] {
  width: 14px; height: 14px; accent-color: var(--dir-accent); cursor: pointer;
}
#directivity-root .dir-swatch { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
#directivity-root .dir-swatch.-rose    { background: var(--dir-rose); }
#directivity-root .dir-swatch.-emerald { background: var(--dir-emerald); }
#directivity-root .dir-swatch.-amber   { background: var(--dir-amber); }

#directivity-root .dir-slider {
  flex: 1 1 auto; height: 6px; border-radius: 6px; appearance: none;
  background: rgba(55, 65, 81, 0.9); cursor: pointer; accent-color: var(--dir-accent);
}
#directivity-root .dir-slider::-webkit-slider-thumb {
  appearance: none; width: 16px; height: 16px; border-radius: 999px;
  background: var(--dir-accent); border: 2px solid #fff;
  box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.3);
}
#directivity-root .dir-freq-label {
  font-size: 13px; font-family: ui-monospace, monospace; font-weight: 600;
  color: #fff; min-width: 90px; text-align: right;
}

#directivity-root .dir-canvas-box {
  position: relative;
  background: #000;
  border-radius: 10px;
  border: 1px solid var(--dir-panel-border);
  overflow: hidden;
  flex: 1 1 auto;
  min-height: 360px;
}
#directivity-root .dir-canvas-box canvas { display: block; }
#directivity-root .dir-canvas-box .-fill {
  position: absolute; inset: 0; width: 100%; height: 100%;
}
#directivity-root .dir-canvas-box .-overlay { pointer-events: none; }
#directivity-root .dir-canvas-box.-center {
  display: flex; align-items: center; justify-content: center;
}

#directivity-root .dir-table-wrap { overflow: auto; flex: 1 1 auto; min-height: 0; }
#directivity-root table.dir-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
}
#directivity-root table.dir-table thead th {
  background: rgba(31, 41, 55, 0.85);
  color: #d1d5db;
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  padding: 12px 18px; text-align: center;
}
#directivity-root table.dir-table thead th:first-child { text-align: left; }
#directivity-root table.dir-table tbody td {
  padding: 11px 18px; text-align: center; color: #d1d5db;
  border-bottom: 1px solid rgba(31, 41, 55, 0.8);
  font-family: ui-monospace, monospace;
}
#directivity-root table.dir-table tbody tr:nth-child(even) { background: rgba(17, 24, 39, 0.4); }
#directivity-root table.dir-table tbody tr:nth-child(odd)  { background: rgba(31, 41, 55, 0.25); }
#directivity-root table.dir-table tbody tr:hover { background: rgba(55, 65, 81, 0.5); }
#directivity-root table.dir-table tbody td.-freq { font-weight: 600; color: #fff; text-align: left; }
#directivity-root .dir-angle.-sky     { color: #38bdf8; }
#directivity-root .dir-angle.-emerald { color: #34d399; }
#directivity-root .dir-angle.-amber   { color: #fbbf24; }
#directivity-root .dir-angle.-orange  { color: #fb923c; }

/* ============ Top-level tabs: BEM Config / Graphs (waveguide-studio style) ============ */
#directivity-root .dir-main-tabs {
  display: flex; gap: 8px; flex-shrink: 0;
}
#directivity-root .dir-main-tab-btn {
  background: var(--btn-primary-bg) !important;
  background-image: none !important;
  color: var(--btn-primary-text, #fff) !important;
  border: 2px solid var(--btn-primary-border) !important;
}
#directivity-root .dir-main-tab-btn:hover {
  background: var(--btn-primary-bg-hover) !important;
}
#directivity-root .dir-main-tab-btn.bg-green-700 {
  background: transparent !important;
  background-image: none !important;
  box-shadow: inset 0 0 0 2px var(--btn-primary-border) !important;
}
#directivity-root .dir-main-tab-content.-hidden { display: none; }
#directivity-root .dir-main-tab-content {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
}

/* ============ BEM Config layout : viewer fills the tab, tree/toolbar float over it ============ */
#directivity-root .bem-config-layout {
  position: relative; flex: 1 1 auto; min-height: 560px;
}
#directivity-root .bem-config-left {
  position: absolute; top: 12px; left: 12px; bottom: 68px; width: 250px; z-index: 5;
  overflow-y: auto;
  user-select: none; -webkit-user-select: none;
  /* Transparent aux clics : seules les lignes de l'arbre captent la souris,
     pour ne jamais bloquer l'orbite/le zoom de la caméra en dessous. */
  pointer-events: none;
}
#directivity-root .bem-tree-node { pointer-events: auto; margin-bottom: 2px; }
/* Bandeau d'options à droite : sans fond, superposé pour ne pas réduire le graphe. */
#directivity-root .bem-config-right {
  position: absolute; top: 36px; right: 12px; bottom: 68px; z-index: 5;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  pointer-events: none;
}
#directivity-root .bem-config-right > * { pointer-events: auto; }
#directivity-root .bem-field-legend {
  pointer-events: none; border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
}
#directivity-root .bem-field-legend.-hidden { display: none; }
/* Bandeau d'écoulement : posé juste au-dessus de la barre d'outils. */
#directivity-root .bem-flow-readout {
  position: absolute; left: 12px; right: 12px; bottom: 72px; z-index: 6;
  pointer-events: none; text-align: center;
  font: 600 11px ui-monospace, monospace; color: #cbd5e1;
  background: rgba(17, 24, 39, 0.82); border-radius: 6px; padding: 5px 10px;
}
#directivity-root .bem-flow-readout.-hidden { display: none; }
#directivity-root .bem-config-left .bem-tree-rename-input { user-select: text; -webkit-user-select: text; }
#directivity-root .bem-tree-empty { display: none; }
#directivity-root .bem-tree-row {
  display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 5px;
  cursor: pointer; font-size: 12.5px; color: var(--dir-text);
}
#directivity-root .bem-tree-row:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
#directivity-root .bem-tree-row[draggable="true"] { cursor: grab; }
#directivity-root .bem-tree-row[draggable="true"]:active { cursor: grabbing; }
#directivity-root .bem-tree-node.-drag-over > .bem-tree-row {
  background: var(--dir-accent-soft); box-shadow: inset 0 0 0 1px var(--dir-accent);
}
#directivity-root .bem-tree-row.-dragging { opacity: 0.45; }
#directivity-root .bem-tree-toggle {
  width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--dir-muted); flex-shrink: 0; transition: transform 0.15s; font-size: 10px;
}
#directivity-root .bem-tree-toggle.-open { transform: rotate(90deg); }
#directivity-root .bem-tree-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; -webkit-user-drag: none; }
#directivity-root .bem-tree-vis {
  width: 13px; height: 13px; cursor: pointer; accent-color: var(--dir-accent);
}
#directivity-root .bem-tree-children { padding-left: 18px; }

#directivity-root .bem-viewer-container {
  position: absolute; inset: 0; z-index: 1;
  background: #05070a; border: 1px solid var(--dir-panel-border); border-radius: 10px; overflow: hidden;
}
#directivity-root .bem-viewer-hint {
  position: absolute; top: 10px; right: 12px; font-size: 11px; color: var(--dir-muted);
  font-family: ui-monospace, monospace; pointer-events: none;
}

#directivity-root .bem-toolbar {
  position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 5;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: rgba(17, 24, 39, 0.82); backdrop-filter: blur(6px);
  border: 1px solid var(--dir-panel-border);
  border-radius: 10px; padding: 10px 14px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
}
#directivity-root .bem-toolbar-group { display: flex; gap: 8px; }
#directivity-root .bem-tool-btn {
  padding: 8px 16px; font-size: 12px; font-weight: 600; border-radius: 6px;
  border: 1px solid var(--dir-panel-border-strong);
  background: var(--btn-secondary-bg, rgba(31, 41, 55, 0.7)); color: var(--dir-text);
  cursor: pointer; font-family: inherit; transition: all 0.15s;
}
#directivity-root .bem-tool-btn:hover { border-color: var(--dir-accent); color: #fff; }
#directivity-root .bem-toolbar-actions { display: flex; gap: 8px; }
#directivity-root .bem-solve-status {
  flex: 1 1 auto; min-width: 0; text-align: center;
  font-size: 11px; color: var(--dir-muted); font-family: ui-monospace, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
}
#directivity-root .bem-solve-status.-expanded {
  white-space: normal; overflow: visible; text-overflow: clip; text-align: left;
  max-height: 96px; overflow-y: auto;
}
#directivity-root .bem-filter-head,
#directivity-root .bem-filter-row {
  display: grid; grid-template-columns: 36px 112px 1fr 92px 1fr 1fr 1fr;
  gap: 8px; align-items: center; margin-bottom: 6px;
}
#directivity-root .bem-filter-head {
  font-size: 11px; color: var(--dir-muted); text-transform: uppercase; letter-spacing: .04em;
}
#directivity-root .bem-filter-row .dir-input { width: 100%; }
#directivity-root .bem-filter-row .dir-input:disabled { opacity: .3; }
/* Contourné, un filtre reste modifiable : on l'estompe, on ne le grise pas. */
#directivity-root .bem-filter-row.-bypassed .dir-input { opacity: .45; }
#directivity-root .bem-switch {
  position: relative; display: inline-block; width: 34px; height: 18px; flex: none;
}
#directivity-root .bem-switch input {
  position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 1;
}
#directivity-root .bem-switch .-track {
  position: absolute; inset: 0; border-radius: 999px;
  background: rgba(100, 116, 139, 0.45); transition: background .15s ease;
}
#directivity-root .bem-switch .-track::before {
  content: ''; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: #e5e7eb; transition: transform .15s ease;
}
#directivity-root .bem-switch input:checked ~ .-track {
  background: var(--dir-accent, #22c55e);
}
#directivity-root .bem-switch input:checked ~ .-track::before { transform: translateX(16px); }
#directivity-root .bem-switch input:focus-visible ~ .-track {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}
#directivity-root .bem-filter-summary {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dir-border, #334155);
  font-size: 11px; color: var(--dir-muted); font-family: ui-monospace, monospace;
  white-space: pre-line;
}
#directivity-root .bem-cfd-status {
  font-size: 12px; line-height: 1.55; color: var(--dir-text, #e5e7eb); white-space: pre-line;
}
#directivity-root .bem-cfd-status .-ok { color: #34d399; }
#directivity-root .bem-cfd-status .-warn { color: #fbbf24; }
#directivity-root .bem-cfd-cmd { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
#directivity-root .bem-cfd-cmd.-hidden { display: none; }
#directivity-root .bem-cfd-cmd .dir-input { flex: 1 1 auto; font-family: ui-monospace, monospace; }
#directivity-root .bem-cfd-log {
  margin-top: 12px; max-height: 220px; overflow-y: auto; padding: 8px;
  background: rgba(0, 0, 0, 0.45); border: 1px solid var(--dir-panel-border); border-radius: 4px;
  font-size: 11px; font-family: ui-monospace, monospace; color: var(--dir-muted);
  white-space: pre-wrap; word-break: break-word;
}
#directivity-root .bem-cfd-log.-hidden { display: none; }
#directivity-root .dir-spl-curves {
  display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center;
  padding: 6px 8px; margin-bottom: 6px;
  border: 1px solid var(--dir-panel-border); border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
}
#directivity-root .dir-spl-curves.-hidden { display: none; }
#directivity-root .dir-spl-curve {
  display: flex; align-items: center; gap: 5px; font-size: 11px;
}
#directivity-root .dir-spl-curve input[type="color"] {
  width: 22px; height: 20px; padding: 0; border: none; background: none; cursor: pointer;
}
#directivity-root .dir-spl-curve input[type="text"] {
  width: 130px; padding: 2px 5px; font-size: 11px;
  background: rgba(17, 24, 39, 0.8); color: var(--dir-text, #e5e7eb);
  border: 1px solid var(--dir-panel-border); border-radius: 3px;
}
#directivity-root .dir-spl-curve .-del {
  background: none; border: none; color: #f87171; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
}
#directivity-root .bem-tool-btn.-active {
  border-color: var(--dir-accent); color: #fff;
}
#directivity-root .bem-tool-btn.-start {
  background: var(--btn-primary-bg, var(--dir-accent)); border-color: transparent; color: #fff;
}
#directivity-root .bem-tool-btn.-abort {
  background: var(--btn-danger-bg, rgba(239, 68, 68, 0.15)); color: var(--btn-danger-text, #fca5a5);
  border-color: var(--btn-danger-border, #ef4444);
}
#directivity-root .bem-tool-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* ============ Popups (Subdomain / Observation / Frequency) ============ */
#directivity-root .bem-popup-overlay {
  position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 50;
  backdrop-filter: blur(2px);
}
#directivity-root .bem-popup-overlay.-hidden { display: none; }
#directivity-root .bem-popup {
  width: 420px; max-width: 90%; background: var(--card-bg-elevated, var(--dir-panel));
  border: 1px solid var(--card-border, var(--dir-panel-border-strong));
  border-radius: 12px; box-shadow: var(--card-shadow, 0 8px 24px rgba(0,0,0,0.6));
  padding: 20px;
}
#directivity-root .bem-popup-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
#directivity-root .bem-popup-header h3 { margin: 0; font-size: 15px; font-weight: 700; color: #fff; }
#directivity-root .bem-popup-close {
  background: none; border: none; color: var(--dir-muted); font-size: 20px; line-height: 1;
  cursor: pointer; padding: 0 4px;
}
#directivity-root .bem-popup-close:hover { color: #fff; }
#directivity-root .bem-popup-body { display: flex; flex-direction: column; gap: 12px; }
#directivity-root .bem-popup-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#directivity-root .bem-popup-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
#directivity-root .bem-popup-section {
  margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--dir-panel-border);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--dir-purple); font-weight: 600;
}
#directivity-root .bem-toolbar-field {
  display: flex; align-items: center; gap: 8px; padding: 0 4px 0 10px;
  border-left: 1px solid var(--dir-panel-border);
  font-size: 11px; color: var(--dir-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
#directivity-root .bem-toolbar-field.-hidden { display: none; }
#directivity-root .bem-tool-btn.-hidden { display: none; }
#directivity-root .bem-toolbar-field input,
#directivity-root .bem-toolbar-field select {
  width: 78px; padding: 6px 8px; font-size: 12px; font-family: ui-monospace, monospace;
  background: rgba(15, 23, 42, 0.85); border: 1px solid var(--dir-panel-border-strong);
  border-radius: 6px; color: var(--dir-text); outline: none;
}
#directivity-root .bem-toolbar-field input:focus,
#directivity-root .bem-toolbar-field select:focus { border-color: var(--dir-accent); }

/* ============ Surface right-click context menu ============ */
#directivity-root .bem-ctx-menu {
  position: absolute; z-index: 60; min-width: 190px;
  background: rgba(17, 24, 39, 0.97); border: 1px solid var(--dir-panel-border-strong);
  border-radius: 8px; padding: 4px; box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
}
#directivity-root .bem-ctx-menu.-hidden { display: none; }
#directivity-root .bem-ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 7px 10px; font-size: 12.5px; color: var(--dir-text);
  background: transparent; border: none; border-radius: 5px; cursor: pointer; font-family: inherit;
}
#directivity-root .bem-ctx-item:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); color: #fff; }
#directivity-root .bem-ctx-submenu-wrap { position: relative; }
#directivity-root .bem-ctx-submenu {
  display: none; position: absolute; left: 100%; top: 0; min-width: 170px;
  background: rgba(17, 24, 39, 0.97); border: 1px solid var(--dir-panel-border-strong);
  border-radius: 8px; padding: 4px; box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
}
#directivity-root .bem-ctx-submenu-wrap:hover .bem-ctx-submenu { display: block; }
#directivity-root .bem-ctx-submenu .bem-ctx-item.-empty { color: var(--dir-muted); cursor: default; }
#directivity-root .bem-ctx-submenu .bem-ctx-item.-empty:hover { background: transparent; color: var(--dir-muted); }
#directivity-root .bem-ctx-submenu .bem-ctx-item.-repo {
  border-top: 1px solid var(--dir-panel-border); color: var(--dir-muted); font-style: italic;
}
#directivity-root .bem-tree-rename-input {
  width: 100%; background: rgba(15, 23, 42, 0.9); border: 1px solid var(--dir-accent);
  border-radius: 4px; color: var(--dir-text); font-size: 12.5px; padding: 1px 4px; font-family: inherit;
}
#directivity-root .bem-tree-label.-component em {
  font-style: normal; font-size: 10px; opacity: 0.55; margin-left: 4px;
}

/* ============ Driver picker (diaphragm properties) ============ */
#directivity-root .bem-driver-picker { display: flex; flex-direction: column; }
#directivity-root .bem-driver-list {
  margin-top: 6px; max-height: 160px; overflow-y: auto;
  background: rgba(15, 23, 42, 0.9); border: 1px solid var(--dir-panel-border); border-radius: 6px;
}
#directivity-root .bem-driver-list.-hidden { display: none; }
#directivity-root .bem-driver-item {
  padding: 6px 10px; font-size: 12.5px; color: var(--dir-text); cursor: pointer;
}
#directivity-root .bem-driver-item:hover { background: var(--bg-hover, rgba(255,255,255,0.08)); color: #fff; }
#directivity-root .bem-driver-item.-empty { color: var(--dir-muted); cursor: default; }
#directivity-root .bem-driver-item.-empty:hover { background: transparent; color: var(--dir-muted); }

@media (max-width: 960px) {
  #directivity-root .dir-grid-3 { grid-template-columns: 1fr; }
  #directivity-root .dir-grid-4 { grid-template-columns: repeat(2, 1fr); }
  #directivity-root .bem-config-left { width: 70%; max-width: 260px; }
}
`;

// --------------------------------------------------------
//  PUBLIC : HTML
// --------------------------------------------------------
export function getBemSolverPanelHtml(options = {}) {
  const embeddedPro = options === true || options.embeddedPro === true;
  const graphsOnly = options.graphsOnly === true;
  return `
<style>${DIR_STYLES}</style>
<div id="directivity-root" data-embedded-pro="${embeddedPro}" data-graphs-only="${graphsOnly}">

  <div class="dir-header"${graphsOnly ? ' style="display:none;"' : ''}>
    ${embeddedPro ? '' : '<h1>BEM Solver</h1>'}
    <div class="dir-main-tabs">
      <button type="button" class="dir-main-tab-btn action-btn text-sm px-4 py-1.5 bg-green-700" data-main-tab="config">BEM Config</button>
      <button type="button" class="dir-main-tab-btn action-btn text-sm px-4 py-1.5" data-main-tab="graphs">Graphs</button>
    </div>
  </div>

  <!-- ============ MAIN TAB : BEM CONFIG ============ -->
  <div id="dir-main-tab-config" class="dir-main-tab-content${graphsOnly ? ' -hidden' : ''}">
    <div class="bem-config-layout">
      <div id="bem-viewer-container" class="bem-viewer-container">
        <span class="bem-viewer-hint">No mesh loaded</span>
      </div>
      <div class="bem-config-left">
        <div id="bem-tree-root"></div>
      </div>
      <div class="bem-config-right">
        <button type="button" id="bem-btn-symmetry" class="bem-tool-btn">Hide symmetry</button>
        <canvas id="bem-field-legend" class="bem-field-legend -hidden"></canvas>
      </div>
      <div id="bem-flow-readout" class="bem-flow-readout -hidden"></div>
      <div class="bem-toolbar">
        <div class="bem-toolbar-group">
          <button type="button" id="bem-btn-subdomain" class="bem-tool-btn">Général config</button>
          <button type="button" id="bem-btn-observation" class="bem-tool-btn">Observation</button>
          <button type="button" id="bem-btn-frequency" class="bem-tool-btn">Frequency</button>
          <button type="button" id="bem-btn-filters" class="bem-tool-btn" title="Peak / high-pass / low-pass applied to the drive voltage, after the solve">Filters</button>
          <label id="bem-drive-vrms-wrap" class="bem-toolbar-field -hidden">
            <span>Voltage (V RMS)</span>
            <input type="number" id="bem-drive-vrms" value="${DEFAULT_DRIVE_VRMS}" min="0" step="0.01">
          </label>
          <label id="bem-field-freq-wrap" class="bem-toolbar-field -hidden">
            <span>Field @</span>
            <select id="bem-field-freq" class="dir-input" style="width:110px;"></select>
          </label>
        </div>
        <div id="bem-solve-status" class="bem-solve-status" title="Double-click to expand"></div>
        <div class="bem-toolbar-actions">
          <button type="button" id="bem-btn-start" class="bem-tool-btn -start">Start Sim</button>
          <button type="button" id="bem-btn-start-field" class="bem-tool-btn -hidden" disabled title="Recompute only the checked fields, reusing the surface solution of the last simulation">Start field</button>
          <button type="button" id="bem-btn-start-cfd" class="bem-tool-btn -hidden" title="Run the OpenFOAM solve for the checked CFD fields, at the frequency selected above">Start CFD</button>
          <button type="button" id="bem-btn-abort" class="bem-tool-btn -abort" disabled>Abort</button>
        </div>
      </div>

      <!-- Général config popup -->
      <div id="bem-popup-subdomain" class="bem-popup-overlay -hidden">
        <div class="bem-popup">
          <div class="bem-popup-header">
            <h3>Général config</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-subdomain">&times;</button>
          </div>
          <div class="bem-popup-body">
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">BEM study (.TBBS)</label>
              <span style="display:flex;gap:8px;">
                <button type="button" id="bem-project-load" class="bem-tool-btn">Load…</button>
                <button type="button" id="bem-project-save" class="bem-tool-btn">Save…</button>
              </span>
              <input type="file" id="bem-project-file" accept=".tbbs,.TBBS" style="display:none;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Import mesh (.msh)</label>
              <button type="button" id="bem-mesh-load" class="bem-tool-btn">Load…</button>
              <input type="file" id="bem-subdomain-mesh-file" accept=".msh" style="display:none;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Symmetry</label>
              <select id="bem-subdomain-symmetry" class="dir-input" style="width:80px;">
                <option value="none" selected>None</option>
                <option value="h">Horizontal</option>
                <option value="v">Vertical</option>
                <option value="hv">H + V</option>
              </select>
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Normals</label>
              <select id="bem-normal-convention" class="dir-input" style="width:150px;">
                <option value="akabak" selected>Akabak (as drawn)</option>
                <option value="auto">Auto-detect</option>
              </select>
            </div>
            <div class="bem-popup-hint" style="margin:-4px 0 6px 0;font-size:11px;color:var(--dir-muted);">
              Akabak: every normal points <b>into</b> the domain it belongs to; an interface normal
              points into its <b>first</b> subdomain (From). Auto-detect deduces the orientation from
              the geometry and ignores how the mesh was drawn.
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Subdomains</label>
              <input type="number" id="bem-subdomain-count" class="dir-input" value="1" min="0" max="12" step="1" style="width:80px;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Interfaces</label>
              <input type="number" id="bem-interface-count" class="dir-input" value="0" min="0" max="12" step="1" style="width:80px;">
            </div>
          </div>
          <div class="bem-popup-actions">
            <button type="button" id="bem-subdomain-remove-all" class="dir-btn -danger">Remove sub+itf</button>
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-subdomain">Cancel</button>
            <button type="button" id="bem-subdomain-apply" class="dir-btn -primary" style="margin:0;width:auto;">Apply</button>
          </div>
        </div>
      </div>

      <!-- Observation popup -->
      <div id="bem-popup-observation" class="bem-popup-overlay -hidden">
        <div class="bem-popup">
          <div class="bem-popup-header">
            <h3>Observation Setup</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-observation">&times;</button>
          </div>
          <div class="bem-popup-body">
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Mic distance (m)</label>
              <input type="number" id="bem-obs-distance" class="dir-input" value="1" min="0.1" step="0.1" style="width:90px;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Polar angle range (°)</label>
              <input type="number" id="bem-obs-angle-range" class="dir-input" value="180" min="10" max="360" step="10" style="width:90px;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Angle step (°)</label>
              <input type="number" id="bem-obs-angle-step" class="dir-input" value="3" min="1" max="15" step="1" style="width:90px;">
            </div>
            <div class="bem-popup-section">Fields</div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Add an observation field</label>
              <span style="display:flex;gap:8px;">
                <button type="button" id="bem-obs-add-plane" class="bem-tool-btn">Plane</button>
                <button type="button" id="bem-obs-add-balloon" class="bem-tool-btn">Balloon</button>
                <button type="button" id="bem-obs-add-directivity" class="bem-tool-btn">Directivity 3D</button>
              </span>
            </div>
            <div style="font-size:11px;color:var(--dir-muted);">
              Fields appear in the model tree. Double-click one to set its axis,
              offset and sampling; only the fields left checked are computed when
              the simulation starts. A Directivity 3D field inflates the measuring
              sphere into the radiated wave shape, with the &minus;6 dB contour drawn on it.
            </div>
          </div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-observation">Cancel</button>
            <button type="button" id="bem-observation-apply" class="dir-btn -primary" style="margin:0;width:auto;">Apply</button>
          </div>
        </div>
      </div>

      <!-- Frequency popup -->
      <div id="bem-popup-frequency" class="bem-popup-overlay -hidden">
        <div class="bem-popup">
          <div class="bem-popup-header">
            <h3>Frequency Setup</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-frequency">&times;</button>
          </div>
          <div class="bem-popup-body">
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">F min (Hz)</label>
              <input type="number" id="bem-freq-fmin" class="dir-input" value="1000" min="10" step="10" style="width:90px;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">F max (Hz)</label>
              <input type="number" id="bem-freq-fmax" class="dir-input" value="10000" min="20" step="50" style="width:90px;">
            </div>
            <div class="bem-popup-row">
              <label class="dir-label" style="margin:0;">Points/octave</label>
              <input type="number" id="bem-freq-ppo" class="dir-input" value="20" min="1" max="24" step="1" style="width:90px;">
            </div>
          </div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-frequency">Cancel</button>
            <button type="button" id="bem-frequency-apply" class="dir-btn -primary" style="margin:0;width:auto;">Apply</button>
          </div>
        </div>
      </div>

      <!-- Output filters popup -->
      <div id="bem-popup-filters" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="min-width:700px;">
          <div class="bem-popup-header">
            <h3 title="The BEM is linear, so a filter is only a complex gain on the drive voltage.&#10;Nothing is re-solved: change these at any time after a simulation.&#10;OpenFOAM is the exception — it is non-linear, so a changed port velocity needs a new CFD run.">Output filters &#9432;</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-filters">&times;</button>
          </div>
          <div class="bem-popup-body">
            <div class="bem-filter-head">
              <span title="Bypass this band without losing its settings">On</span><span>Type</span><span>Freq (Hz)</span><span title="Butterworth: flattest passband, -3 dB at cutoff.&#10;Linkwitz-Riley: two half-order Butterworth in cascade, -6 dB at cutoff, the two ways sum flat. Even orders only.&#10;Free Q: a single biquad with the Q you type.">Align</span><span>Q</span><span>Gain (dB)</span><span>Order</span>
            </div>
            <div id="bem-filter-rows"></div>
            <div id="bem-filter-summary" class="bem-filter-summary"></div>
          </div>
          <div class="bem-popup-actions">
            <button type="button" id="bem-filters-clear" class="dir-btn" style="margin:0;width:auto;">Clear all</button>
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-filters">Cancel</button>
            <button type="button" id="bem-filters-apply" class="dir-btn -primary" style="margin:0;width:auto;">Apply</button>
          </div>
        </div>
      </div>

      <!-- CFD backend setup popup -->
      <div id="bem-popup-cfd-setup" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="min-width:640px;">
          <div class="bem-popup-header">
            <h3 title="OpenFOAM solves Navier-Stokes in the port. It runs inside WSL, the Linux subsystem that ships with Windows.">CFD backend (OpenFOAM) &#9432;</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-cfd-setup">&times;</button>
          </div>
          <div class="bem-popup-body">
            <div id="bem-cfd-setup-status" class="bem-cfd-status">Checking…</div>
            <div id="bem-cfd-setup-cmd-row" class="bem-cfd-cmd -hidden">
              <input type="text" id="bem-cfd-setup-cmd" class="dir-input" readonly>
              <button type="button" id="bem-cfd-setup-copy" class="dir-btn" style="margin:0;width:auto;padding:5px 10px;font-size:11px;">Copy</button>
            </div>
            <pre id="bem-cfd-setup-log" class="bem-cfd-log -hidden"></pre>
          </div>
          <div class="bem-popup-actions">
            <button type="button" id="bem-cfd-setup-recheck" class="dir-btn" style="margin:0;width:auto;">Re-check</button>
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-cfd-setup">Close</button>
            <button type="button" id="bem-cfd-setup-install" class="dir-btn -primary -hidden" style="margin:0;width:auto;">Install OpenFOAM</button>
          </div>
        </div>
      </div>

      <!-- Properties popup (double-click on a tree item) -->
      <div id="bem-popup-props" class="bem-popup-overlay -hidden">
        <div class="bem-popup">
          <div class="bem-popup-header">
            <h3 id="bem-props-title">Properties</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-props">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -danger" data-close-popup="bem-popup-props">Cancel</button>
            <button type="button" id="bem-props-apply" class="dir-btn -primary" style="margin:0;width:auto;">Apply</button>
          </div>
        </div>
      </div>

      <!-- Diaphragm: Position sub-popup (opens over the props popup) -->
      <div id="bem-popup-diaphragm-position" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:320px;">
          <div class="bem-popup-header">
            <h3>Diaphragm Position</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-diaphragm-position">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-position-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-diaphragm-position" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Diaphragm: Shape sub-popup -->
      <div id="bem-popup-diaphragm-shape" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:320px;">
          <div class="bem-popup-header">
            <h3>Diaphragm Shape</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-diaphragm-shape">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-shape-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-diaphragm-shape" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Diaphragm: Mesh sub-popup -->
      <div id="bem-popup-diaphragm-mesh" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:320px;">
          <div class="bem-popup-header">
            <h3>Diaphragm Mesh</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-diaphragm-mesh">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-mesh-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-diaphragm-mesh" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Field: Geometry sub-popup -->
      <div id="bem-popup-field-geometry" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:320px;">
          <div class="bem-popup-header">
            <h3>Field Geometry</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-field-geometry">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-field-geometry-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-field-geometry" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Field: Display sub-popup -->
      <div id="bem-popup-field-display" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:320px;">
          <div class="bem-popup-header">
            <h3>Field Display</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-field-display">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-field-display-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-field-display" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Field: Air flow sub-popup -->
      <div id="bem-popup-field-flow" class="bem-popup-overlay -hidden">
        <div class="bem-popup" style="width:340px;">
          <div class="bem-popup-header">
            <h3>Air Flow</h3>
            <button type="button" class="bem-popup-close" data-close-popup="bem-popup-field-flow">&times;</button>
          </div>
          <div class="bem-popup-body" id="bem-props-field-flow-body"></div>
          <div class="bem-popup-actions">
            <button type="button" class="dir-btn -primary" data-close-popup="bem-popup-field-flow" style="margin:0;width:auto;">Done</button>
          </div>
        </div>
      </div>

      <!-- Surface right-click context menu -->
      <div id="bem-ctx-menu" class="bem-ctx-menu -hidden">
        <button type="button" class="bem-ctx-item" data-ctx-action="swap-normal">Swap normal</button>
        <div class="bem-ctx-submenu-wrap">
          <button type="button" class="bem-ctx-item -has-sub">Add elementary<span data-ctx-count="elementary"></span> to ▸</button>
          <div class="bem-ctx-submenu" data-submenu="elementary"></div>
        </div>
        <div class="bem-ctx-submenu-wrap">
          <button type="button" class="bem-ctx-item -has-sub">Add physical<span data-ctx-count="physical"></span> to ▸</button>
          <div class="bem-ctx-submenu" data-submenu="physical"></div>
        </div>
      </div>

      <!-- Model tree right-click context menu (subdomain components) -->
      <div id="bem-tree-ctx-menu" class="bem-ctx-menu -hidden">
        <button type="button" class="bem-ctx-item" data-tree-ctx="add-baffle">Add infinite baffle</button>
        <button type="button" class="bem-ctx-item" data-tree-ctx="add-diaphragm">Add diaphragm</button>
        <button type="button" class="bem-ctx-item" data-tree-ctx="rename">Rename…</button>
        <button type="button" class="bem-ctx-item" data-tree-ctx="remove-node">Remove</button>
        <button type="button" class="bem-ctx-item" data-tree-ctx="remove-component">Remove component</button>
        <button type="button" class="bem-ctx-item" data-tree-ctx="remove-surface">Remove surface</button>
      </div>
    </div>
  </div>

  <!-- ============ MAIN TAB : GRAPHS ============ -->
  <div id="dir-main-tab-graphs" class="dir-main-tab-content${graphsOnly ? '' : ' -hidden'}">
  <div class="dir-scroll">
    <!-- ============ RESULTS ============ -->
    <div id="dir-results" class="dir-results -hidden">

      <div class="dir-card">
        <div class="dir-tabs-bar">
          ${tabButton('heatmap', 'Directivity Map', true)}
          ${tabButton('polar',   'Polar Plot')}
          ${tabButton('beamwidth', 'Beamwidth')}
          ${tabButton('table',   'Data Table')}
          ${tabButton('spl',     'SPL')}
          ${tabButton('excursion', 'Excursion')}
        </div>

        <!-- Heatmap tab -->
        <div id="dir-tab-heatmap" class="dir-tab-content">
          <div class="dir-tab-toolbar">
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Plane</span>
              <div class="dir-segmented">
                <button class="dir-plane-btn dir-segmented-btn -active" data-plane="horizontal">Horizontal</button>
                <button class="dir-plane-btn dir-segmented-btn" data-plane="vertical">Vertical</button>
              </div>
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Frequency</span>
              <input type="number" id="dir-hm-fmin" class="dir-mini-select" value="50" min="10" step="10" style="width:86px;" title="Minimum frequency (Hz)">
              <span class="dir-toolbar-label">to</span>
              <input type="number" id="dir-hm-fmax" class="dir-mini-select" value="20000" min="20" step="10" style="width:92px;" title="Maximum frequency (Hz)">
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Range</span>
              <input type="number" id="dir-hm-range" class="dir-mini-select" value="20" min="1" max="120" step="1" style="width:70px;" title="Displayed dB range">
              <span class="dir-toolbar-label">dB</span>
            </div>
            <div class="dir-toolbar-group -push">
              <label class="dir-check" style="margin-right:10px;">
                <input type="checkbox" id="dir-hm-show-contour">
                <span style="color:#ffffff;">Contour &minus;6 dB</span>
              </label>
              <span class="dir-toolbar-label">Export step</span>
              <input type="number" id="dir-export-angle-step" class="dir-mini-select" value="10" min="1" max="45" step="1" style="width:60px;margin-right:6px;" title="Angle step used by the Akabak .txt export (one Data set per angle)">
              <button type="button" id="dir-export-directivity-txt" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);margin-right:10px;" title="Export directivity (level dB + phase, Akabak .txt format)">Export .txt</button>
              <span id="dir-hm-readout" class="dir-readout">&mdash;</span>
            </div>
          </div>
          <div class="dir-canvas-box">
            <canvas id="dir-heatmap-canvas" class="-fill"></canvas>
            <canvas id="dir-heatmap-overlay" class="-fill -overlay"></canvas>
          </div>
        </div>

        <!-- Polar tab -->
        <div id="dir-tab-polar" class="dir-tab-content -hidden">
          <div class="dir-tab-toolbar">
            <div class="dir-toolbar-group -grow">
              <span class="dir-toolbar-label">Frequency</span>
              <input type="range" id="dir-polar-slider" min="0" max="100" value="50" step="1" class="dir-slider">
              <span id="dir-polar-freq-label" class="dir-freq-label">1.00 kHz</span>
            </div>
            <div class="dir-toolbar-group">
              <label class="dir-check"><span class="dir-swatch -rose"></span>
                <input type="checkbox" id="dir-polar-show-h" checked> Horizontal
              </label>
              <label class="dir-check"><span class="dir-swatch -emerald"></span>
                <input type="checkbox" id="dir-polar-show-v" checked> Vertical
              </label>
              <span class="dir-toolbar-label">Scale</span>
              <input type="number" id="dir-polar-range" class="dir-mini-select" value="20" min="1" max="120" step="1" style="width:70px;" title="Polar dB range">
              <span class="dir-toolbar-label">dB</span>
            </div>
          </div>
          <div class="dir-canvas-box -center">
            <canvas id="dir-polar-canvas" class="-fill"></canvas>
          </div>
        </div>

        <!-- Beamwidth tab -->
        <div id="dir-tab-beamwidth" class="dir-tab-content -hidden">
          <div class="dir-tab-toolbar">
            <label class="dir-check"><span class="dir-swatch -rose"></span>
              <input type="checkbox" id="dir-bw-show-h" checked> Horizontal -6 dB
            </label>
            <label class="dir-check"><span class="dir-swatch -emerald"></span>
              <input type="checkbox" id="dir-bw-show-v" checked> Vertical -6 dB
            </label>
            <label class="dir-check"><span class="dir-swatch -amber"></span>
              <input type="checkbox" id="dir-bw-show-q"> Directivity Q
            </label>
          </div>
          <div class="dir-canvas-box">
            <canvas id="dir-beamwidth-canvas" class="-fill"></canvas>
          </div>
        </div>

        <!-- Table tab -->
        <div id="dir-tab-table" class="dir-tab-content -hidden">
          <div id="dir-frequency-table" class="dir-table-wrap"></div>
        </div>

        <!-- SPL tab -->
        <div id="dir-tab-spl" class="dir-tab-content -hidden">
          <div class="dir-tab-toolbar">
            <div id="dir-spl-meta" style="font-size:11px;color:var(--dir-muted);font-family:ui-monospace,monospace;">
              Set a surface to <b>Driven</b> and run BEM Preview to compute SPL.
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Frequency</span>
              <input type="number" id="dir-spl-fmin" class="dir-mini-select" value="${DEFAULT_SPL_FMIN}" min="1" step="10" style="width:86px;" title="Minimum frequency (Hz)">
              <span class="dir-toolbar-label">to</span>
              <input type="number" id="dir-spl-fmax" class="dir-mini-select" value="${DEFAULT_SPL_FMAX}" min="2" step="10" style="width:92px;" title="Maximum frequency (Hz)">
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">SPL</span>
              <input type="number" id="dir-spl-dbmin" class="dir-mini-select" value="${DEFAULT_SPL_DB_MIN}" step="5" style="width:70px;" title="Minimum displayed level (dB)">
              <span class="dir-toolbar-label">to</span>
              <input type="number" id="dir-spl-dbmax" class="dir-mini-select" value="${DEFAULT_SPL_DB_MAX}" step="5" style="width:70px;" title="Maximum displayed level (dB)">
              <span class="dir-toolbar-label">dB</span>
              <button type="button" id="dir-spl-autoscale" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);" title="Fit the axes to the computed data">Auto</button>
            </div>
            <div class="dir-toolbar-group -push">
              <span id="dir-spl-readout" class="dir-readout">&mdash;</span>
              <button type="button" id="dir-spl-snapshot" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);" title="Freeze the current curve to overlay it with other filter or voltage settings">Freeze curve</button>
              <button type="button" id="dir-export-spl-txt" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);" title="Export SPL (level dB + phase, Akabak .txt format)">Export .txt</button>
            </div>
          </div>
          <div id="dir-spl-curves" class="dir-spl-curves -hidden"></div>
          <div style="position:relative;width:100%;flex:1 1 auto;min-height:360px;background:rgba(0,0,0,0.35);border:1px solid var(--dir-panel-border);border-radius:4px;">
            <canvas id="dir-spl-canvas" style="width:100%;height:100%;display:block;"></canvas>
            <canvas id="dir-spl-overlay" style="position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;"></canvas>
          </div>
        </div>

        <!-- Excursion tab -->
        <div id="dir-tab-excursion" class="dir-tab-content -hidden">
          <div class="dir-tab-toolbar">
            <div id="dir-exc-meta" style="font-size:11px;color:var(--dir-muted);font-family:ui-monospace,monospace;">
              Assign a driver to the diaphragm and run BEM Preview to compute cone excursion.
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Frequency</span>
              <input type="number" id="dir-exc-fmin" class="dir-mini-select" value="${DEFAULT_SPL_FMIN}" min="1" step="10" style="width:86px;" title="Minimum frequency (Hz)">
              <span class="dir-toolbar-label">to</span>
              <input type="number" id="dir-exc-fmax" class="dir-mini-select" value="${DEFAULT_SPL_FMAX}" min="2" step="10" style="width:92px;" title="Maximum frequency (Hz)">
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label">Full scale</span>
              <input type="number" id="dir-exc-mmmax" class="dir-mini-select" value="${DEFAULT_EXC_MM_MAX}" min="0.1" step="1" style="width:70px;" title="Top of the vertical axis (mm)">
              <span class="dir-toolbar-label">mm</span>
              <button type="button" id="dir-exc-autoscale" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);" title="Fit the axes to the computed data">Auto</button>
            </div>
            <div class="dir-toolbar-group">
              <span class="dir-toolbar-label" title="One-way peak Xmax of the driver, drawn as a limit line. Taken from the driver sheet when it declares one.">Xmax</span>
              <input type="number" id="dir-exc-xmax" class="dir-mini-select" min="0" step="0.5" style="width:70px;" title="Leave blank to use the value from the driver sheet, if it has one">
              <span class="dir-toolbar-label">mm</span>
            </div>
            <div class="dir-toolbar-group -push">
              <span id="dir-exc-readout" class="dir-readout">&mdash;</span>
              <button type="button" id="dir-exc-snapshot" class="dir-btn" style="padding:5px 10px;font-size:11px;background:rgba(55,65,81,0.9);" title="Freeze the current curve to overlay it with other filter or voltage settings">Freeze curve</button>
            </div>
          </div>
          <div id="dir-exc-curves" class="dir-spl-curves -hidden"></div>
          <div style="position:relative;width:100%;flex:1 1 auto;min-height:360px;background:rgba(0,0,0,0.35);border:1px solid var(--dir-panel-border);border-radius:4px;">
            <canvas id="dir-exc-canvas" style="width:100%;height:100%;display:block;"></canvas>
            <canvas id="dir-exc-overlay" style="position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;"></canvas>
          </div>
        </div>
      </div>
    </div>

  </div>
  </div>
</div>`;
}

function tabButton(key, label, active = false) {
  return `<button data-tab="${key}" class="dir-tab-btn${active ? ' -active' : ''}">${label}</button>`;
}

// --------------------------------------------------------
//  BEM CONFIG TAB : main tabs, popups, model tree, 3D viewer
// --------------------------------------------------------
function initBemMainTabs(root) {
  const btns = root.querySelectorAll('.dir-main-tab-btn');
  const contents = root.querySelectorAll('.dir-main-tab-content');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.mainTab;
      btns.forEach(b => b.classList.remove('bg-green-700'));
      btn.classList.add('bg-green-700');
      contents.forEach(c => c.classList.add('-hidden'));
      root.querySelector(`#dir-main-tab-${target}`).classList.remove('-hidden');
      if (target === 'graphs' && currentResults) {
        requestAnimationFrame(() => renderActiveTab(root, getActiveTab(root)));
      }
    });
  });
}

function initBemConfigTab(root) {
  // Right-click on a mesh surface: Swap normal / Add elementary|physical to a subdomain or interface.
  const ctxMenu = root.querySelector('#bem-ctx-menu');
  // Chaque famille est une LISTE : un clic droit sur une sélection multiple
  // (Shift + clic gauche) applique l'option à toutes les surfaces visées.
  let ctxTarget = { physical: [], elementary: [] };

  const closeCtxMenu = () => { ctxMenu?.classList.add('-hidden'); ctxTarget = { physical: [], elementary: [] }; };

  const populateCtxSubmenu = (kindKey) => {
    const wrap = ctxMenu?.querySelector(`[data-submenu="${kindKey}"]`);
    if (!wrap) return;
    if (!ctxTarget[kindKey].length) {
      wrap.innerHTML = `<span class="bem-ctx-item -empty">No ${kindKey} tag selected</span>`;
      return;
    }
    // Le dépôt est toujours proposé, même sans aucun sous-domaine : c'est là qu'on
    // range les surfaces du maillage dont on ne veut pas.
    const targets = bemTreeItems.filter(it => it.kind !== 'Repository' && it.kind !== 'Field');
    wrap.innerHTML = targets.map(it =>
      `<button type="button" class="bem-ctx-item" data-add-to-node="${it.id}" data-add-kind="${kindKey}">${escapeHtml(it.name)}</button>`
    ).join('')
      + `<button type="button" class="bem-ctx-item -repo" data-add-to-node="__repo" data-add-kind="${kindKey}">Repository (unused)</button>`;
  };

  const updateCtxLabels = () => {
    ctxMenu?.querySelectorAll('[data-ctx-count]').forEach(el => {
      const n = ctxTarget[el.dataset.ctxCount].length;
      el.textContent = n > 1 ? ` (${n})` : '';
    });
  };

  // 3D viewer (lazy: created once the container has real size)
  const viewerContainer = root.querySelector('#bem-viewer-container');
  if (viewerContainer) {
    requestAnimationFrame(() => {
      root._bemMeshViewer?.dispose();
      root._bemMeshViewer = createBemMeshViewer(viewerContainer, {
        onSurfaceContextMenu: ({ clientX, clientY, physical, elementary }) => {
          ctxTarget = { physical, elementary };
          populateCtxSubmenu('elementary');
          populateCtxSubmenu('physical');
          updateCtxLabels();
          const layoutRect = root.querySelector('.bem-config-layout')?.getBoundingClientRect();
          if (ctxMenu && layoutRect) {
            ctxMenu.style.left = `${clientX - layoutRect.left}px`;
            ctxMenu.style.top = `${clientY - layoutRect.top}px`;
            ctxMenu.classList.remove('-hidden');
          }
        },
      });
      if (bemMeshContent) {
        root._bemMeshViewer.loadMeshFromText(bemMeshContent);
        restoreBemTreeViewerState(root);
        renderBemTree(root);
      }
    });
  }

  ctxMenu?.addEventListener('click', (e) => {
    if (e.target.closest('[data-ctx-action="swap-normal"]')) {
      // Le tag physique prime ; à défaut on retourne les tags élémentaires.
      const targets = ctxTarget.physical.length ? ctxTarget.physical : ctxTarget.elementary;
      targets.forEach(t => root._bemMeshViewer?.flipSurfaceNormal(t.id));
      closeCtxMenu();
      return;
    }
    const addBtn = e.target.closest('[data-add-to-node]');
    if (addBtn) {
      const kind = addBtn.dataset.addKind;
      const item = addBtn.dataset.addToNode === '__repo'
        ? ensureBemRepository()
        : bemTreeItems.find(it => it.id === addBtn.dataset.addToNode);
      if (item) {
        ctxTarget[kind].forEach(target => {
          assignBemSurface(item, target, kind);
          // Une surface assignée à un sous-domaine/interface se masque dans la
          // vue 3D — on la réaffiche via la case à cocher de l'arbre.
          root._bemMeshViewer?.setSurfaceVisible(target.id, false);
        });
        item.expanded = true;
        root._bemMeshViewer?.clearSelection();
        renderBemTree(root);
        applyBemSurfaceColors(root);
      }
      closeCtxMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (ctxMenu && !ctxMenu.classList.contains('-hidden') && !ctxMenu.contains(e.target)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

  // Popups: open/close plumbing
  const popupIds = ['bem-popup-subdomain', 'bem-popup-observation', 'bem-popup-frequency', 'bem-popup-props',
    'bem-popup-filters', 'bem-popup-cfd-setup',
    'bem-popup-diaphragm-position', 'bem-popup-diaphragm-shape', 'bem-popup-diaphragm-mesh',
    'bem-popup-field-geometry', 'bem-popup-field-display', 'bem-popup-field-flow'];
  const openPopup = (id) => root.querySelector(`#${id}`)?.classList.remove('-hidden');
  const closePopup = (id) => root.querySelector(`#${id}`)?.classList.add('-hidden');

  root.querySelector('#bem-btn-subdomain')?.addEventListener('click', () => {
    // Reflète l'état courant : rouvrir la fenêtre ne doit pas suggérer une remise à zéro.
    const subInput = root.querySelector('#bem-subdomain-count');
    const ifInput = root.querySelector('#bem-interface-count');
    if (subInput) subInput.value = String(bemTreeItems.filter(it => it.kind === 'Subdomain').length);
    if (ifInput) ifInput.value = String(bemTreeItems.filter(it => it.kind === 'Interface').length);
    openPopup('bem-popup-subdomain');
  });
  root.querySelector('#bem-btn-observation')?.addEventListener('click', () => openPopup('bem-popup-observation'));
  root.querySelector('#bem-btn-frequency')?.addEventListener('click', () => openPopup('bem-popup-frequency'));
  root.querySelector('#bem-btn-filters')?.addEventListener('click', () => {
    renderBemFilterRows(root);
    openPopup('bem-popup-filters');
  });
  root.querySelector('#bem-filters-apply')?.addEventListener('click', () => {
    applyBemFilters(root);
    closePopup('bem-popup-filters');
  });
  root.querySelector('#bem-filters-clear')?.addEventListener('click', () => {
    bemFilters = [];
    renderBemFilterRows(root);
  });

  popupIds.forEach(id => {
    const overlay = root.querySelector(`#${id}`);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(id); });
  });
  root.querySelectorAll('[data-close-popup]').forEach(btn => {
    btn.addEventListener('click', () => {
      closePopup(btn.dataset.closePopup);
      if (btn.dataset.closePopup === 'bem-popup-props') closeDiaphragmSubPopups(root);
    });
  });

  // Subdomain popup: mesh import (visual only) + tree generation
  const meshFileInput = root.querySelector('#bem-subdomain-mesh-file');
  root.querySelector('#bem-mesh-load')?.addEventListener('click', () => meshFileInput?.click());
  meshFileInput?.addEventListener('change', () => {
    const file = meshFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const hint = root.querySelector('.bem-viewer-hint');
      try {
        bemMeshContent = String(reader.result);
        root._bemMeshViewer?.loadMeshFromText(bemMeshContent);
        const remap = remapBemTreeSurfaces(root._bemMeshViewer?.getSurfaces() || []);
        restoreBemTreeViewerState(root);
        renderBemTree(root);
        if (remap.removed) {
          setBemStatus(root, `${remap.removed} surface assignment(s) not found in the new mesh.`, true);
        } else if (remap.remapped) {
          setBemStatus(root, `${remap.remapped} surface tag(s) remapped to the new mesh.`);
        } else {
          setBemStatus(root, 'Mesh replaced; surface assignments preserved.');
        }
        if (hint) hint.textContent = file.name;
      } catch (err) {
        console.warn('[BEM Solver] Mesh preview failed:', err);
        bemMeshContent = null;
        if (hint) hint.textContent = `Failed to load ${file.name}`;
      }
      meshFileInput.value = '';
    };
    reader.onerror = () => {
      meshFileInput.value = '';
      setBemStatus(root, `Failed to read ${file.name}.`, true);
    };
    reader.readAsText(file);
  });

  // .TBBS study file: mesh + tree + symmetry/observation/frequency in a single JSON document.
  const projectFileInput = root.querySelector('#bem-project-file');
  root.querySelector('#bem-project-load')?.addEventListener('click', () => projectFileInput?.click());
  projectFileInput?.addEventListener('change', () => {
    const file = projectFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyBemProject(root, JSON.parse(String(reader.result)), file.name);
        setBemStatus(root, `Study loaded from ${file.name}.`);
      } catch (err) {
        setBemStatus(root, `Failed to load ${file.name}: ${err.message}`, true);
      }
      projectFileInput.value = '';
    };
    reader.onerror = () => {
      projectFileInput.value = '';
      setBemStatus(root, `Failed to read ${file.name}.`, true);
    };
    reader.readAsText(file);
  });
  root.querySelector('#bem-project-save')?.addEventListener('click', () => saveBemProject(root));

  // Symmetry: applied from the Général config popup, shown/hidden from the right-hand strip.
  const symmetrySelect = root.querySelector('#bem-subdomain-symmetry');
  symmetrySelect?.addEventListener('change', () => {
    root._bemMeshViewer?.setSymmetry(symmetrySelect.value);
    // Le diaphragme est découpé sur les plans de symétrie : il doit suivre.
    bemTreeItems.forEach(item => (item.components || []).forEach(component => {
      if (component.type === 'diaphragm') syncBemComponent(root, item, component);
    }));
  });

  const symmetryBtn = root.querySelector('#bem-btn-symmetry');
  let symmetryShown = true;
  symmetryBtn?.addEventListener('click', () => {
    symmetryShown = !symmetryShown;
    root._bemMeshViewer?.setSymmetryVisible(symmetryShown);
    symmetryBtn.textContent = symmetryShown ? 'Hide symmetry' : 'Show symmetry';
  });

  root.querySelector('#bem-subdomain-remove-all')?.addEventListener('click', () => {
    bemTreeItems.forEach(item => {
      if (item.kind === 'Field' || item.kind === 'Repository') return;
      (item.components || []).forEach(component => syncBemComponent(root, item, component, true));
      item.surfaces.forEach(surface => {
        if (surface.meshSurfaceId) {
          root._bemMeshViewer?.setSurfaceColor(surface.meshSurfaceId, null);
          root._bemMeshViewer?.setSurfaceVisible(surface.meshSurfaceId, true);
        }
      });
    });
    bemTreeItems = bemTreeItems.filter(item => item.kind === 'Field' || item.kind === 'Repository');
    root.querySelector('#bem-subdomain-count').value = '0';
    root.querySelector('#bem-interface-count').value = '0';
    renderBemTree(root);
    setBemStatus(root, 'Subdomains and interfaces removed.');
  });

  root.querySelector('#bem-subdomain-apply')?.addEventListener('click', () => {
    const subCount = Math.max(0, parseInt(root.querySelector('#bem-subdomain-count').value, 10) || 0);
    const ifCount = Math.max(0, parseInt(root.querySelector('#bem-interface-count').value, 10) || 0);
    // Additif : on complète jusqu'au compte demandé sans jamais détruire ce qui
    // existe déjà (et les surfaces qu'on y a rangées).
    const existingSub = bemTreeItems.filter(it => it.kind === 'Subdomain').length;
    const existingIf = bemTreeItems.filter(it => it.kind === 'Interface').length;
    for (let i = existingSub; i < subCount; i++) bemTreeItems.push(makeBemTreeItem('Subdomain', i + 1));
    for (let i = existingIf; i < ifCount; i++) bemTreeItems.push(makeBemTreeItem('Interface', i + 1));
    root._bemMeshViewer?.setSymmetry(symmetrySelect?.value || 'none');
    renderBemTree(root);
    applyBemSurfaceColors(root);
    closePopup('bem-popup-subdomain');
  });
  root.querySelector('#bem-observation-apply')?.addEventListener('click', () => closePopup('bem-popup-observation'));
  root.querySelector('#bem-frequency-apply')?.addEventListener('click', () => closePopup('bem-popup-frequency'));

  const addField = (fieldType, displayMode = 'shell') => {
    const index = bemTreeItems.filter(it => it.kind === 'Field').length + 1;
    const field = makeBemTreeItem('Field', index, fieldType, displayMode);
    bemTreeItems.push(field);
    syncBemField(root, field);
    renderBemTree(root);
    setBemStatus(root, `${field.name} added — ${buildFieldGeometry(field).points.length} observation points.`);
  };
  root.querySelector('#bem-obs-add-plane')?.addEventListener('click', () => addField('plane'));
  root.querySelector('#bem-obs-add-balloon')?.addEventListener('click', () => addField('balloon'));
  root.querySelector('#bem-obs-add-directivity')?.addEventListener('click', () => addField('balloon', 'directivity'));
  const freqSelect = root.querySelector('#bem-field-freq');
  freqSelect?.addEventListener('change', () => paintBemFields(root));
  // Molette : parcourir les fréquences sans ouvrir la liste.
  freqSelect?.addEventListener('wheel', (ev) => {
    if (!freqSelect.options.length) return;
    ev.preventDefault();
    const next = freqSelect.selectedIndex + (ev.deltaY > 0 ? 1 : -1);
    if (next < 0 || next >= freqSelect.options.length) return;
    freqSelect.selectedIndex = next;
    freqSelect.dispatchEvent(new Event('change'));
  }, { passive: false });
  // La CFD coûte des dizaines de secondes à des heures : elle ne part jamais
  // toute seule, seulement sur demande explicite.
  root.querySelector('#bem-btn-start-cfd')?.addEventListener('click', () => runBemVentCfdForFields(root));

  root.querySelector('#bem-cfd-setup-recheck')?.addEventListener('click', () => refreshBemCfdSetup(root, true));
  root.querySelector('#bem-cfd-setup-copy')?.addEventListener('click', async () => {
    const value = root.querySelector('#bem-cfd-setup-cmd')?.value;
    if (value) await navigator.clipboard.writeText(value);
  });
  const cfdInstallBtn = root.querySelector('#bem-cfd-setup-install');
  cfdInstallBtn?.addEventListener('click', async () => {
    const logEl = root.querySelector('#bem-cfd-setup-log');
    logEl.classList.remove('-hidden');
    logEl.textContent = '';
    const append = (text) => {
      logEl.textContent += `${text}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    };
    const off = window.electronAPI.onFoamInstallProgress(line => {
      const text = bemCfdInstallLine(line);
      if (text) append(text);
    });
    cfdInstallBtn.disabled = true;
    try {
      const res = await window.electronAPI.foamInstallOpenFoam({ distro: bemCfdEnv?.distro });
      if (!res?.ok) append(`Failed: ${res?.reason || 'unknown error'}`);
      else append('Done.');
      await refreshBemCfdSetup(root, true);
    } finally {
      off();
      cfdInstallBtn.disabled = false;
    }
  });
  // Le bandeau de statut tronque : un double-clic déplie le message entier.
  root.querySelector('#bem-solve-status')?.addEventListener('dblclick', (ev) => {
    ev.currentTarget.classList.toggle('-expanded');
  });
  // La tension fixe la vitesse de membrane, donc l'échelle de la carte de
  // vitesse d'air : la changer doit redessiner les nappes sans re-solver.
  root.querySelector('#bem-drive-vrms')?.addEventListener('input', () => {
    // La tension ne touche ni au diagramme ni à la phase, seulement au niveau :
    // inutile de repasser par les graphes de directivité.
    if (bemResults) updateSplDataFromBemResult(bemResults, buildBemSolverConfig(root));
    renderSplCurve(root);
    renderExcursionCurve(root);
    paintBemFields(root);
  });

  // Model tree: delegated interactions (expand/collapse, add placeholder surface, visibility toggle)
  const treeRoot = root.querySelector('#bem-tree-root');
  treeRoot?.addEventListener('click', (e) => {
    if (e.target.closest('input[type="checkbox"]')) return;
    const toggleRow = e.target.closest('[data-toggle-node]');
    if (toggleRow) {
      const item = bemTreeItems.find(it => it.id === toggleRow.dataset.toggleNode);
      if (!item) return;
      item.expanded = !item.expanded;
      // Bascule en place plutôt que re-rendre : un re-rendu détruirait la ligne
      // entre les deux clics et empêcherait le dblclick de se déclencher.
      const node = toggleRow.closest('.bem-tree-node');
      node?.querySelector('.bem-tree-toggle')?.classList.toggle('-open', item.expanded);
      const children = node?.querySelector('.bem-tree-children');
      if (children) children.style.display = item.expanded ? '' : 'none';
    }
  });
  treeRoot?.addEventListener('change', (e) => {
    const nodeCb = e.target.closest('[data-node-vis]');
    if (nodeCb) {
      const item = bemTreeItems.find(it => it.id === nodeCb.dataset.nodeVis);
      if (!item) return;
      item.visible = nodeCb.checked;
      if (item.kind === 'Field') {
        syncBemField(root, item);
        renderBemTree(root);
        return;
      }
      item.surfaces.forEach(s => {
        s.visible = nodeCb.checked;
        if (s.meshSurfaceId) root._bemMeshViewer?.setSurfaceVisible(s.meshSurfaceId, nodeCb.checked);
      });
      (item.components || []).forEach(c => {
        c.visible = nodeCb.checked;
        syncBemComponent(root, item, c);
      });
      renderBemTree(root);
      return;
    }
    const componentCb = e.target.closest('[data-component-vis]');
    if (componentCb) {
      const [nodeId, componentId] = componentCb.dataset.componentVis.split(':');
      const item = bemTreeItems.find(it => it.id === nodeId);
      const component = findBemComponent(item, componentId);
      if (!component) return;
      component.visible = componentCb.checked;
      syncBemComponent(root, item, component);
      return;
    }
    const cb = e.target.closest('[data-surface-vis]');
    if (!cb) return;
    const [nodeId, surfaceId] = cb.dataset.surfaceVis.split(':');
    const item = bemTreeItems.find(it => it.id === nodeId);
    const surface = item?.surfaces.find(s => s.id === surfaceId);
    if (!surface) return;
    surface.visible = cb.checked;
    if (surface.meshSurfaceId) root._bemMeshViewer?.setSurfaceVisible(surface.meshSurfaceId, cb.checked);
  });

  treeRoot?.addEventListener('dragstart', (e) => {
    const surfaceRow = e.target.closest('[data-drag-surface]');
    const nodeRow = surfaceRow ? null : e.target.closest('[data-drag-node]');
    const row = surfaceRow || nodeRow;
    if (!row) return;
    e.dataTransfer.effectAllowed = 'move';
    if (surfaceRow) {
      e.dataTransfer.setData('application/x-bem-surface', surfaceRow.dataset.dragSurface);
      e.dataTransfer.setData('text/plain', surfaceRow.dataset.dragSurface);
    } else {
      e.dataTransfer.setData('application/x-bem-node', nodeRow.dataset.dragNode);
      e.dataTransfer.setData('text/plain', nodeRow.dataset.dragNode);
    }
    row.classList.add('-dragging');
  });
  treeRoot?.addEventListener('dragover', (e) => {
    const node = e.target.closest('[data-drop-node]');
    if (!node) return;
    const draggedNodeId = e.dataTransfer.getData('application/x-bem-node');
    if (draggedNodeId && draggedNodeId === node.dataset.dropNode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    treeRoot.querySelectorAll('.bem-tree-node.-drag-over').forEach(el => el.classList.remove('-drag-over'));
    node.classList.add('-drag-over');
  });
  treeRoot?.addEventListener('drop', (e) => {
    const node = e.target.closest('[data-drop-node]');
    if (!node) return;
    e.preventDefault();
    const plainData = e.dataTransfer.getData('text/plain');
    const draggedNodeId = e.dataTransfer.getData('application/x-bem-node') || (!plainData.includes(':') ? plainData : '');
    if (draggedNodeId) {
      if (moveBemTreeNode(draggedNodeId, node.dataset.dropNode)) renderBemTree(root);
      return;
    }
    const surfaceData = e.dataTransfer.getData('application/x-bem-surface') || (plainData.includes(':') ? plainData : '');
    const [sourceNodeId, surfaceId] = surfaceData.split(':');
    if (moveBemTreeSurface(sourceNodeId, surfaceId, node.dataset.dropNode)) {
      renderBemTree(root);
      applyBemSurfaceColors(root);
    }
  });
  treeRoot?.addEventListener('dragend', () => {
    treeRoot.querySelectorAll('.-dragging, .-drag-over').forEach(el => {
      el.classList.remove('-dragging', '-drag-over');
    });
  });

  // Right-click a tree row: subdomains offer to add a component, components and
  // surfaces to remove themselves, everything can be renamed.
  const treeCtxMenu = root.querySelector('#bem-tree-ctx-menu');
  let treeCtxTarget = null;   // { type, nodeId, childId, labelEl }
  const closeTreeCtxMenu = () => treeCtxMenu?.classList.add('-hidden');
  treeRoot?.addEventListener('contextmenu', (e) => {
    const label = e.target.closest('[data-props-target]');
    if (!label || !treeCtxMenu) return;
    e.preventDefault();
    const [type, nodeId, childId] = label.dataset.propsTarget.split(':');
    const item = bemTreeItems.find(it => it.id === nodeId);
    if (!item) return;
    treeCtxTarget = { type, nodeId, childId, labelEl: label };

    const isSubdomain = type === 'node' && item.kind === 'Subdomain';
    const allowed = {
      'add-baffle': isSubdomain,
      'add-diaphragm': isSubdomain,
      'rename': true,
      'remove-node': type === 'node',
      'remove-component': type === 'component',
      'remove-surface': type === 'surface',
    };
    treeCtxMenu.querySelectorAll('[data-tree-ctx]').forEach(btn => {
      btn.style.display = allowed[btn.dataset.treeCtx] ? '' : 'none';
    });
    const layoutRect = root.querySelector('.bem-config-layout')?.getBoundingClientRect();
    if (layoutRect) {
      treeCtxMenu.style.left = `${e.clientX - layoutRect.left}px`;
      treeCtxMenu.style.top = `${e.clientY - layoutRect.top}px`;
      treeCtxMenu.classList.remove('-hidden');
    }
  });
  treeCtxMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tree-ctx]');
    if (!btn || !treeCtxTarget) return;
    const { type, nodeId, childId, labelEl } = treeCtxTarget;
    const item = bemTreeItems.find(it => it.id === nodeId);
    if (!item) { closeTreeCtxMenu(); return; }
    const action = btn.dataset.treeCtx;
    closeTreeCtxMenu();

    if (action === 'rename') {
      // La ligne est toujours en place : le menu ne provoque aucun re-rendu.
      if (labelEl.isConnected) startBemTreeRename(root, labelEl);
      return;
    }
    if (action === 'remove-component') {
      const component = findBemComponent(item, childId);
      if (component) {
        syncBemComponent(root, item, component, true);
        item.components = item.components.filter(c => c.id !== component.id);
      }
    } else if (action === 'remove-node') {
      removeBemTreeItem(root, nodeId);
    } else if (action === 'remove-surface') {
      removeBemSurface(root, item, childId);
    } else if (type === 'node') {
      const component = makeBemComponent(action === 'add-baffle' ? 'baffle' : 'diaphragm');
      item.components = item.components || [];
      item.components.push(component);
      item.expanded = true;
      syncBemComponent(root, item, component);
    }
    renderBemTree(root);
    applyBemSurfaceColors(root);
  });
  document.addEventListener('click', (e) => {
    if (treeCtxMenu && !treeCtxMenu.classList.contains('-hidden') && !treeCtxMenu.contains(e.target)) closeTreeCtxMenu();
  });

  // Double-click opens the properties dialog of the clicked tree item.
  treeRoot?.addEventListener('dblclick', (e) => {
    const label = e.target.closest('[data-props-target]');
    if (!label) return;
    e.preventDefault();
    openBemPropsPopup(root, label.dataset.propsTarget);
  });

  // Start / Abort — lance le solveur BEM multi-domaine sur le modèle de l'arbre.
  const startBtn = root.querySelector('#bem-btn-start');
  const abortBtn = root.querySelector('#bem-btn-abort');
  const fieldBtn = root.querySelector('#bem-btn-start-field');
  startBtn?.addEventListener('click', () => runBemSolve(root, startBtn, abortBtn));
  fieldBtn?.addEventListener('click', () => runBemFieldSolve(root, startBtn, abortBtn, fieldBtn));
  abortBtn?.addEventListener('click', () => {
    abortBemDomains();
    abortBtn.disabled = true;
    setBemStatus(root, 'Aborting — finishing the current frequency…');
  });
}

/** Traduit l'arbre du panneau en configuration solveur. */
function buildBemSolverConfig(root) {
  const diaphragms = [];
  const subdomains = bemTreeItems
    .filter(it => it.kind === 'Subdomain')
    .map(it => {
      const components = it.components || [];
      const baffle = components.find(c => c.type === 'baffle') || null;
      const surfaces = it.surfaces
        .filter(s => s.meshSurfaceId)
        .map(s => ({
          surfaceId: s.meshSurfaceId,
          role: s.role === 'driven' ? 'driven' : 'boundary',
          velocity: s.velocity != null ? s.velocity : 1,
        }));
      // Un diaphragme maillé est la source du domaine : il entre dans le modèle
      // comme une surface pilotée à vitesse unité, le couplage driver/tension
      // n'intervenant qu'au moment du calcul du SPL. Côté 'back', le disque
      // central (capTris) est une surface FIXE distincte (rôle boundary), donc
      // deux entrées y sont poussées au lieu d'une.
      for (const component of components) {
        if (component.type !== 'diaphragm') continue;
        const mesh = bemDiaphragmMeshes.get(component.id) || rebuildBemDiaphragmMesh(root, component);
        if (!mesh?.tris?.length) continue;
        diaphragms.push({ id: component.id, nodes: mesh.nodes, tris: mesh.coneTris || mesh.tris });
        surfaces.push({
          surfaceId: `d:${component.id}`,
          role: 'driven',
          velocity: 1,
          pistonAxis: axisUnitVector(component.axis),
        });
        if (mesh.capTris?.length) {
          diaphragms.push({ id: `${component.id}:cap`, nodes: mesh.nodes, tris: mesh.capTris });
          surfaces.push({ surfaceId: `d:${component.id}:cap`, role: 'boundary' });
        }
      }
      return {
        id: it.id,
        name: it.name,
        type: it.domainType === 'interior' ? 'interior' : 'exterior',
        baffle: !!baffle,
        baffleAxis: baffle ? (baffle.axis || '+z') : null,
        baffleOffset_mm: baffle ? (Number(baffle.offset_mm) || 0) : 0,
        surfaces,
      };
    });

  const interfaces = bemTreeItems
    .filter(it => it.kind === 'Interface')
    .map(it => ({
      id: it.id,
      name: it.name,
      fromId: it.fromId,
      toId: it.toId,
      surfaces: it.surfaces.filter(s => s.meshSurfaceId).map(s => ({ surfaceId: s.meshSurfaceId })),
    }));

  return {
    symmetry: root.querySelector('#bem-subdomain-symmetry')?.value || 'none',
    normalConvention: root.querySelector('#bem-normal-convention')?.value || 'akabak',
    driveVrms: bemDriveVrms(root),
    subdomains,
    interfaces,
    diaphragms,
  };
}

/** '+z' | '-x' … → vecteur unité de l'axe. */
function axisUnitVector(value) {
  const raw = String(value || '+z').trim().toLowerCase();
  const letter = ['x', 'y', 'z'].includes(raw.slice(-1)) ? raw.slice(-1) : 'z';
  const sign = raw.startsWith('-') ? -1 : 1;
  return { x: [sign, 0, 0], y: [0, sign, 0], z: [0, 0, sign] }[letter];
}

function setBemStatus(root, text, isError = false) {
  const el = root.querySelector('#bem-solve-status');
  if (!el) return;
  el.textContent = text || '';
  el.title = text ? `${text}\n\n(double-click to expand)` : 'Double-click to expand';
  el.style.color = isError ? 'var(--state-error, #f87171)' : 'var(--dir-muted)';
}

// ============================================================
//  Akabak-compatible .txt export (level dB + phase)
// ============================================================

/** Akabak writes 7 significant digits, trailing zeros stripped, 3-digit exponents. */
function akabakFormatNumber(value) {
  if (!Number.isFinite(value) || value === 0) return '0';
  const abs = Math.abs(value);
  const strip = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (abs >= 1e-4 && abs < 1e7) return strip(value.toPrecision(7));
  const parts = value.toExponential(6).match(/^(-?[\d.]+)e([+-])(\d+)$/);
  return `${strip(parts[1])}E${parts[2]}${parts[3].padStart(3, '0')}`;
}

function akabakRow(values) {
  return values.map(v => akabakFormatNumber(v).padStart(15)).join(' ');
}

function wrapPhaseDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Contour file: one row per frequency, then (relative level dB, relative phase °)
 * for each polar angle — the layout Akabak uses for its directivity exports.
 * Akabak treats each angle as one "Data set" in its Import Control Dialog, so the
 * polar data is resampled onto a coarse grid (default −90…+90 by 10°, i.e. the
 * 19 columns Akabak itself writes) instead of the solver's native angle step.
 */
function buildAkabakDirectivityTxt(plane, angleStepDeg = 10, angleMaxDeg = 90) {
  const table = bemResults?.[plane === 'v' ? 'polarV' : 'polarH'];
  if (!table || !table.length) return null;

  const targets = [];
  for (let a = -angleMaxDeg; a <= angleMaxDeg + 1e-9; a += angleStepDeg) targets.push(a);

  const rows = table.slice().sort((a, b) => a.f - b.f).map(entry => {
    const axisIdx = entry.angles.reduce((bi, a, i) => (Math.abs(a) < Math.abs(entry.angles[bi]) ? i : bi), 0);
    const refPhase = entry.phasesDeg ? entry.phasesDeg[axisIdx] : 0;
    // Interpolate in dB and in phase relative to the axis, so the resampling
    // never crosses a ±180° wrap.
    const levels = entry.normalized.map(n => (n > 0 ? 20 * Math.log10(n) : -200));
    const phases = entry.angles.map((_, i) => (entry.phasesDeg ? unwrapFromAxis(entry.phasesDeg, refPhase, axisIdx, i) : 0));

    const values = [entry.f];
    for (const target of targets) {
      values.push(interpolateAtAngle(entry.angles, levels, target));
      values.push(wrapPhaseDeg(interpolateAtAngle(entry.angles, phases, target)));
    }
    return akabakRow(values);
  });
  return `${rows.join('\r\n')}\r\n`;
}

/** Phase at index `i` relative to the axis, accumulated so successive samples stay continuous. */
function unwrapFromAxis(phasesDeg, refPhase, axisIdx, i) {
  const step = i >= axisIdx ? 1 : -1;
  let acc = 0;
  for (let k = axisIdx; k !== i; k += step) {
    acc += wrapPhaseDeg(phasesDeg[k + step] - phasesDeg[k]);
  }
  return acc + (phasesDeg[axisIdx] - refPhase);
}

function interpolateAtAngle(angles, values, target) {
  if (target <= angles[0]) return values[0];
  const last = angles.length - 1;
  if (target >= angles[last]) return values[last];
  for (let i = 0; i < last; i++) {
    if (target >= angles[i] && target <= angles[i + 1]) {
      const t = (target - angles[i]) / Math.max(1e-9, angles[i + 1] - angles[i]);
      return values[i] * (1 - t) + values[i + 1] * t;
    }
  }
  return values[last];
}

/** SPL file: frequency, absolute level dB, phase °. */
function buildAkabakSplTxt() {
  if (!splData?.freqs?.length) return null;
  const rows = splData.freqs.map((f, i) => akabakRow([
    f,
    splData.splDb[i],
    wrapPhaseDeg(splData.phaseDeg?.[i] ?? 0),
  ]));
  return `${rows.join('\r\n')}\r\n`;
}

function flashButton(btn, text, isError = false) {
  if (!btn) return;
  const original = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = original;
  btn.textContent = text;
  btn.style.color = isError ? '#fca5a5' : '#86efac';
  setTimeout(() => {
    btn.textContent = original;
    btn.style.color = '';
    delete btn.dataset.origLabel;
  }, 2500);
}

async function saveAkabakTxt(btn, content, fileName) {
  const api = window.electronAPI;
  if (api?.saveFileAs) {
    const result = await api.saveFileAs({
      defaultPath: fileName,
      filters: [{ name: 'Akabak text export', extensions: ['txt'] }],
      content,
    });
    if (result?.canceled) return;
    if (!result?.success) { flashButton(btn, 'Save failed', true); return; }
    flashButton(btn, 'Exported ✓');
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  flashButton(btn, 'Exported ✓');
}

async function runBemSolve(root, startBtn, abortBtn, rethrow = false) {
  if (!bemMeshContent) {
    setBemStatus(root, 'Import a .msh file first (Général config ▸ Import mesh).', true);
    return false;
  }
  const config = buildBemSolverConfig(root);
  const fMin = parseFloat(root.querySelector('#bem-freq-fmin')?.value) || 1000;
  const fMax = parseFloat(root.querySelector('#bem-freq-fmax')?.value) || 10000;
  const ppo = parseInt(root.querySelector('#bem-freq-ppo')?.value, 10) || 20;
  if (!(fMax > fMin)) {
    setBemStatus(root, 'Frequency range is invalid (F max must exceed F min).', true);
    return false;
  }
  const freqs = pickAutoFrequencies(fMin, fMax, ppo);
  const distance_m = parseFloat(root.querySelector('#bem-obs-distance')?.value) || 1;
  const angleStep = parseFloat(root.querySelector('#bem-obs-angle-step')?.value) || 5;
  const angleRange = parseFloat(root.querySelector('#bem-obs-angle-range')?.value) || 180;

  // Seuls les fields cochés dans l'arbre sont calculés : masquer une nappe la
  // sort aussi de la simulation, où elle coûte une évaluation par point et par
  // fréquence.
  const fields = activeBemFieldPayload();

  startBtn.disabled = true;
  abortBtn.disabled = false;
  setBemStatus(root, 'Building model…');

  try {
    console.log('[BEM run] observation', { distance_m, angleStep, angleRange, fMin, fMax, ppo, freqCount: freqs.length },
      'symmetry', config.symmetry, 'driveVrms', config.driveVrms);
    console.log('[BEM run] subdomains', config.subdomains.map(s => ({
      name: s.name, type: s.type, baffle: s.baffle, baffleAxis: s.baffleAxis, baffleOffset_mm: s.baffleOffset_mm,
      surfaces: s.surfaces.map(x => `${x.surfaceId}:${x.role}`).join(' '),
    })));
    console.log('[BEM run] interfaces', config.interfaces.map(i => ({
      name: i.name, from: i.fromId, to: i.toId, surfaces: i.surfaces.map(x => x.surfaceId).join(' '),
    })));
    const result = await solveBemDomains(bemMeshContent, config, {
      freqs,
      distance_m,
      angleStep,
      angleMax: angleRange / 2,
      fields,
      // Débit acoustique aux bouches de l'event : c'est lui qui pilotera la CFD.
      flowSurfaces: bemVentFlowSurfaces(),
      onProgress: (ev) => {
        if (ev.phase === 'meshReady') {
          const mi = ev.meshInfo;
          console.log('[BEM mesh]', {
            elements: mi.elementCount, unknowns: mi.unknowns, symmetry: mi.symmetry,
            radiating: mi.radiatingDomain,
            volumes_L: (mi.volumes || []).map(v => `${v.name}=${v.litres.toFixed(3)}`).join(' '),
            domains: mi.domains.map(d => `${d.name}[${d.type}${d.baffle ? ',baffle' : ''}]=${d.elements} closed=${d.closed}`).join(' | '),
            unassigned: (mi.unassigned || []).map(u => `${u.surfaceId}(${u.area_cm2.toFixed(1)}cm2)`).join(' '),
          });
          const workerLabel = ev.workers > 1 ? ` · ${ev.workers} workers` : '';
          setBemStatus(root, `${mi.elementCount} elements · ${mi.unknowns} unknowns${workerLabel} · valid to ~${(mi.fMaxValid_Hz / 1000).toFixed(1)} kHz`);
        } else if (ev.phase === 'prepare') {
          const workerLabel = ev.workers > 1 ? ` on ${ev.workers} workers` : '';
          setBemStatus(root, `Preparing operator${workerLabel} — ${Math.round((ev.subProgress || 0) * 100)}%`);
        } else if (ev.phase === 'solve') {
          setBemStatus(root, `Solving ${Math.round(ev.freq)} Hz (${ev.freqIndex + 1}/${ev.freqCount}) — ${Math.round((ev.subProgress || 0) * 100)}%`);
        } else if (ev.phase === 'freqDone') {
          setBemStatus(root, `${Math.round(ev.freq)} Hz done in ${(ev.elapsed_ms / 1000).toFixed(1)} s (${ev.freqIndex + 1}/${ev.freqCount})`);
        }
      },
    });

    if (!result.freqs.length) {
      setBemStatus(root, 'Aborted before any frequency completed.', true);
      return false;
    }

    bemResults = result;
    bemResults.distance_m = distance_m;
    bemRequestedRange = { fMin, fMax };
    bemHasCompletedRun = true;
    bemWorkersHaveSolution = true;
    storeBemFieldResults(root, result);
    updateSplDataFromBemResult(result, config, true);
    syncGraphControlsToSimulation(root, fMin, fMax);
    applyBemResultsToGraphs(root, result);

    // Le bilan de puissance ne fait foi que là où le maillage est valide : au
    // delà de ~lambda/6 l'écart croît pour une raison de résolution, pas de
    // signe. Signaler tout l'intervalle enverrait l'utilisateur chasser un bug
    // de normales inexistant.
    const fValid = result.meshInfo?.fMaxValid_Hz || Infinity;
    const inRange = result.power.filter(p => p.f <= fValid);
    const worst = inRange.reduce((m, p) => Math.max(m, p.mismatch), 0);

    const bits = [`${result.aborted ? 'Aborted' : 'Done'}: ${result.freqs.length} frequencies`];
    if (fields.length) bits.push(`${fields.length} field${fields.length > 1 ? 's' : ''} computed`);
    const flipped = (result.prepareDiagnostics || []).filter(d => d.flipped).map(d => d.domain);
    if (flipped.length) bits.push(`re-oriented: ${flipped.join(', ')}`);

    // Convention ABEC : la normale d'une interface pointe vers son PREMIER
    // sous-domaine. L'orientation ne s'en sert pas (elle est lue sur le
    // maillage), mais un From/To inversé rend l'arbre trompeur.
    const swap = result.meshInfo?.interfacesToSwap || [];
    if (swap.length) {
      bits.push(`swap From/To: ${swap.map(s => `${s.name} → ${s.toName}, ${s.fromName}`).join('; ')}`);
    }
    const overrides = result.meshInfo?.conventionOverrides || [];
    if (overrides.length) {
      bits.push(`mesh normals contradict the Akabak convention on ${overrides.join(', ')} — corrected from the geometry`);
    }

    // Une surface non assignée ou un domaine non fermé expliquent à eux seuls
    // un bilan de puissance faux : les nommer évite une chasse aux normales.
    // Celles rangées au dépôt sont exclues volontairement, on se tait.
    const parked = parkedBemSurfaceIds();
    const unassigned = (result.meshInfo?.unassigned || []).filter(u => !parked.has(u.surfaceId));
    if (unassigned.length) {
      bits.push(`unassigned: ${unassigned.map(u => `${u.surfaceId} (${u.area_cm2.toFixed(1)} cm²)`).join(', ')}`);
    }
    const open = (result.meshInfo?.domains || []).filter(d => !d.closed && !d.baffle);
    if (open.length) {
      bits.push(`not closed: ${open.map(d => `${d.name} (${(d.closureResidual * 100).toFixed(0)}%)`).join(', ')}`);
    }

    if (inRange.length && worst > 0.05) {
      bits.push(`power mismatch ${(worst * 100).toFixed(0)}% below ${(fValid / 1000).toFixed(1)} kHz`);
    } else if (result.freqs.some(f => f > fValid)) {
      bits.push(`mesh valid to ~${(fValid / 1000).toFixed(1)} kHz — results above are indicative`);
    }
    const bad = (inRange.length > 0 && worst > 0.05) || unassigned.length > 0 || open.length > 0;
    setBemStatus(root, bits.join(' · '), bad);
    if (!bad) await runBemVentCfdForFields(root);
    return true;
  } catch (err) {
    console.error('[BEM Solver] solve failed', err);
    setBemStatus(root, err.message || String(err), true);
    if (rethrow) throw err;
    return false;
  } finally {
    startBtn.disabled = false;
    abortBtn.disabled = true;
    updateBemFieldControls(root);
  }
}

/** Regroupe les pressions de nappes par field et recolore la vue 3D. */
function storeBemFieldResults(root, result) {
  bemFieldResults = new Map();
  for (const entry of (result.fieldResults || [])) {
    if (!bemFieldResults.has(entry.id)) bemFieldResults.set(entry.id, []);
    // Un projet rechargé porte des tableaux JSON ; le reste du code n'attend
    // qu'un accès indexé, mais Float32Array divise l'empreinte par deux.
    bemFieldResults.get(entry.id).push({
      ...entry,
      vRe: decodeFloat32(entry.vRe),
      vIm: decodeFloat32(entry.vIm),
    });
  }
  bemFieldResults.forEach(entries => entries.sort((a, b) => a.f - b.f));
  updateBemFieldControls(root);
  paintBemFields(root);
}

/**
 * Rejoue les nappes seules sur la solution surfacique déjà en mémoire dans les
 * workers : ajuster un field ne coûte plus l'assemblage ni la factorisation.
 */
async function runBemFieldSolve(root, startBtn, abortBtn, fieldBtn) {
  const fields = activeBemFieldPayload();
  if (!fields.length) {
    setBemStatus(root, 'No field is checked in the model tree.', true);
    return;
  }
  startBtn.disabled = true;
  fieldBtn.disabled = true;
  abortBtn.disabled = false;
  setBemStatus(root, 'Computing fields…');
  const t0 = performance.now();
  try {
    const result = await solveBemFields(fields, {
      onProgress: (ev) => setBemStatus(root, `Field at ${Math.round(ev.freq)} Hz (${ev.freqIndex + 1}/${ev.freqCount})`),
    });
    storeBemFieldResults(root, result);
    const points = fields.reduce((sum, f) => sum + f.points_mm.length, 0);
    setBemStatus(root, `Fields done: ${fields.length} field(s) · ${points} points · `
      + `${result.freqs.length} frequencies in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    await runBemVentCfdForFields(root);
  } catch (err) {
    console.error('[BEM Solver] field solve failed', err);
    setBemStatus(root, err.message || String(err), true);
  } finally {
    startBtn.disabled = false;
    abortBtn.disabled = true;
    updateBemFieldControls(root);
  }
}

/**
 * Enchaîne la CFD derrière la résolution des nappes, pour les fields qui l'ont
 * demandée. L'échec du CFD ne doit jamais perdre le résultat BEM : il est
 * signalé, et la nappe reste affichable en acoustique linéaire.
 *
 * Navier-Stokes étant non linéaire, il n'y a pas de superposition : une nappe
 * CFD ne vaut QUE pour la fréquence résolue. Changer « Field @ » relance donc
 * un calcul complet.
 */
async function runBemVentCfdForFields(root) {
  if (bemCfdBusy) { bemCfdPending = true; return; }
  bemCfdBusy = true;
  try {
    do {
      bemCfdPending = false;
      const freq = selectedBemFieldFreq(root);
      const items = activeBemFields()
        .filter(it => it.cfd === true && bemFieldNeedsVelocity(it))
        .filter(it => bemFieldCfd.get(it.id)?.freq !== freq);
      if (!items.length) return;
      if (!Number.isFinite(freq)) {
        setBemStatus(root, 'CFD: choisissez une fréquence dans la barre d\'outils.', true);
        return;
      }

      // Un backend absent n'est pas une erreur de calcul : mieux vaut ouvrir la
      // fenêtre qui explique quoi installer que d'écrire « échec » dans un coin.
      const env = await window.electronAPI.foamCheckAvailability({});
      bemCfdEnv = env;
      if (!env?.available) {
        setBemStatus(root, `CFD unavailable: ${env?.reason || 'backend not ready'}`, true);
        openBemCfdSetup(root);
        return;
      }

      for (const item of items) bemFieldCfd.delete(item.id);
      paintBemFields(root);

      const t0 = performance.now();
      try {
        const res = await runBemVentCfd(root, items, freq, msg => setBemStatus(root, msg));
        if (!res.ok) { setBemStatus(root, `CFD: ${res.reason}`, true); return; }
        setBemStatus(root, `CFD ${res.quality} at ${Math.round(freq)} Hz · `
          + `${res.u0.toFixed(2)} m/s inlet · ${(res.cells ?? 0).toLocaleString('fr-FR')} cells · `
          + `${((performance.now() - t0) / 1000).toFixed(1)} s`);
      } catch (err) {
        console.error('[BEM Solver] CFD failed', err);
        setBemStatus(root, `CFD: ${err.message || String(err)}`, true);
        return;
      } finally {
        paintBemFields(root);
      }
    } while (bemCfdPending);
  } finally {
    bemCfdBusy = false;
  }
}

/**
 * Injecte les polaires du solveur dans le modèle de rendu des graphes.
 * Les dimensions de bouche viennent de la boîte englobante du domaine
 * rayonnant, faute d'import Horn Studio dans ce mode.
 */
function applyBemResultsToGraphs(root, result, switchTab = true) {
  if (!(lastMouthWidth > 0) || !(lastMouthHeight > 0)) {
    const bb = result.meshInfo && result.meshInfo.apertureBBox_mm;
    lastMouthWidth = bb ? bb.width : 400;
    lastMouthHeight = bb ? bb.height : 200;
  }
  for (const panelRoot of bemPanelRoots) {
    if (!panelRoot.isConnected) {
      bemPanelRoots.delete(panelRoot);
      continue;
    }
    recalcResults(panelRoot);
  }
  if (!switchTab) return;
  const graphsTab = root.querySelector('.dir-main-tab-btn[data-main-tab="graphs"]');
  if (graphsTab && !graphsTab.classList.contains('bg-green-700')) graphsTab.click();
}

// --------------------------------------------------------
//  .TBBS STUDY FILE (mesh + model tree + solver settings)
// --------------------------------------------------------
const TBBS_FORMAT = 'TBBS';
// v3 : les composantes de vitesse des nappes sont écrites en base64 Float32.
const TBBS_VERSION = 3;

function bemProjectFileName(root) {
  const hint = root.querySelector('.bem-viewer-hint')?.textContent?.trim();
  return hint && hint !== 'No mesh loaded' ? hint : 'mesh.msh';
}

function serializeBemProject(root) {
  const value = (selector, fallback) => root.querySelector(selector)?.value ?? fallback;
  return {
    format: TBBS_FORMAT,
    version: TBBS_VERSION,
    savedAt: new Date().toISOString(),
    meshFileName: bemProjectFileName(root),
    mesh: bemMeshContent || '',
    symmetry: value('#bem-subdomain-symmetry', 'none'),
    normalConvention: value('#bem-normal-convention', 'akabak'),
    observation: {
      distance: value('#bem-obs-distance', '1'),
      angleRange: value('#bem-obs-angle-range', '180'),
      angleStep: value('#bem-obs-angle-step', '3'),
    },
    frequency: {
      fMin: value('#bem-freq-fmin', '1000'),
      fMax: value('#bem-freq-fmax', '10000'),
      ppo: value('#bem-freq-ppo', '20'),
    },
    driveVrms: value('#bem-drive-vrms', String(DEFAULT_DRIVE_VRMS)),
    filters: bemFilters,
    splSnapshots,
    excursion: {
      fMin: value('#dir-exc-fmin', String(DEFAULT_SPL_FMIN)),
      fMax: value('#dir-exc-fmax', String(DEFAULT_SPL_FMAX)),
      mmMax: value('#dir-exc-mmmax', String(DEFAULT_EXC_MM_MAX)),
      xmaxMm: value('#dir-exc-xmax', ''),
    },
    tree: bemTreeItems,
    results: serializeBemResults(),
  };
}

/**
 * Résultats du dernier solve, pour retrouver graphes et nappes au rechargement.
 * Les nappes viennent de `bemFieldResults`, qui est la source d'affichage et
 * reste à jour après un « Start field ». Les tableaux de pression sont arrondis
 * à 6 chiffres : c'est très au-delà de la précision du solveur, et ça divise à
 * peu près par deux la taille du fichier.
 */
function serializeBemResults() {
  if (!bemResults || !bemHasCompletedRun) return null;
  const round = (list) => (list ? [...list].map(v => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0)) : undefined);
  return {
    ...bemResults,
    fieldResults: [...bemFieldResults.values()].flat().map(entry => ({
      ...entry,
      mag: round(entry.mag),
      phaseDeg: round(entry.phaseDeg),
      // En base64 : une nappe fine porte 3 composantes complexes par point et
      // par fréquence, ce qui en JSON décimal dépasse la longueur maximale
      // d'une chaîne JavaScript et fait échouer la sauvegarde entière.
      vRe: encodeFloat32(entry.vRe),
      vIm: encodeFloat32(entry.vIm),
    })),
  };
}

/** Float32Array → base64 (≈4 caractères par valeur au lieu d'une quinzaine). */
function encodeFloat32(list) {
  if (!list || !list.length) return undefined;
  const bytes = new Uint8Array(Float32Array.from(list).buffer);
  let binary = '';
  // Par tranches : `String.fromCharCode(...bytes)` fait déborder la pile
  // au-delà de quelques dizaines de milliers d'octets.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** Accepte le base64 de la v3 comme les tableaux bruts des versions antérieures. */
function decodeFloat32(value) {
  if (!value) return null;
  if (typeof value !== 'string') return Float32Array.from(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Remet en place les résultats d'un solve enregistré : graphes, SPL et nappes.
 * Les workers, eux, sont vides — « Start field » redevient indisponible jusqu'au
 * prochain Start Sim.
 */
function restoreBemResults(root, data) {
  bemResults = null;
  bemFieldResults = new Map();
  bemHasCompletedRun = false;
  bemWorkersHaveSolution = false;
  splData = null;

  const results = data.results;
  if (!results?.freqs?.length) {
    updateBemFieldControls(root);
    paintBemFields(root);
    return;
  }

  bemResults = results;
  bemHasCompletedRun = true;
  const fMin = parseFloat(data.frequency?.fMin) || results.freqs[0];
  const fMax = parseFloat(data.frequency?.fMax) || results.freqs[results.freqs.length - 1];
  bemRequestedRange = { fMin, fMax };

  storeBemFieldResults(root, results);
  updateSplDataFromBemResult(results, buildBemSolverConfig(root));
  syncGraphControlsToSimulation(root, fMin, fMax);
  applyBemResultsToGraphs(root, results, false);
}

/** Highest numeric suffix of the loaded ids, so freshly created nodes never collide with them. */
function maxBemTreeSeq(items) {
  let max = 0;
  const scan = (id) => {
    const n = parseInt(String(id || '').split('-')[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  };
  items.forEach(item => {
    scan(item.id);
    (item.components || []).forEach(component => scan(component.id));
    (item.surfaces || []).forEach(surface => scan(surface.id));
  });
  return max;
}

function applyBemProject(root, data, fileName) {
  if (!data || data.format !== TBBS_FORMAT) throw new Error('not a ToolBox BEM study file');
  if (!Array.isArray(data.tree)) throw new Error('missing model tree');

  bemTreeItems.forEach(item => {
    if (item.kind === 'Field') syncBemField(root, item, true);
    (item.components || []).forEach(component => syncBemComponent(root, item, component, true));
  });
  bemTreeItems = [];

  bemMeshContent = typeof data.mesh === 'string' && data.mesh.trim() ? data.mesh : null;
  if (bemMeshContent) root._bemMeshViewer?.loadMeshFromText(bemMeshContent);
  else root._bemMeshViewer?.clear();

  bemTreeItems = data.tree.map(item => ({
    ...item,
    components: normalizeBemComponents(item),
    surfaces: Array.isArray(item.surfaces) ? item.surfaces.map(surface => ({ ...surface })) : [],
  }));
  bemTreeSeq = Math.max(bemTreeSeq, maxBemTreeSeq(bemTreeItems));

  const setValue = (selector, value) => {
    const el = root.querySelector(selector);
    if (el && value != null) el.value = String(value);
  };
  setValue('#bem-subdomain-symmetry', data.symmetry);
  // Les études antérieures à l'option n'en portent pas : elles ont été réglées
  // avec l'orientation automatique, on la leur laisse.
  setValue('#bem-normal-convention', data.normalConvention || 'auto');
  setValue('#bem-obs-distance', data.observation?.distance);
  setValue('#bem-obs-angle-range', data.observation?.angleRange);
  setValue('#bem-obs-angle-step', data.observation?.angleStep);
  setValue('#bem-freq-fmin', data.frequency?.fMin);
  setValue('#bem-freq-fmax', data.frequency?.fMax);
  setValue('#bem-freq-ppo', data.frequency?.ppo);
  setValue('#bem-drive-vrms', data.driveVrms);
  bemFilters = Array.isArray(data.filters) ? data.filters.filter(f => f?.type && f.freq_Hz > 0) : [];
  root.querySelector('#bem-btn-filters')?.classList.toggle('-active', activeBemFilters().length > 0);
  splSnapshots = Array.isArray(data.splSnapshots)
    ? data.splSnapshots.filter(s => s?.freqs?.length && s.splDb?.length).map(s => ({ ...s }))
    : [];
  splSnapshotSeq = splSnapshots.reduce((max, s) => Math.max(max, parseInt(String(s.id).replace(/\D/g, ''), 10) || 0), 0);
  // Les études enregistrées avant le graphe d'excursion n'ont pas de xPeakMm :
  // elles restent lisibles en SPL, l'onglet excursion les ignore simplement.
  setValue('#dir-exc-fmin', data.excursion?.fMin);
  setValue('#dir-exc-fmax', data.excursion?.fMax);
  setValue('#dir-exc-mmmax', data.excursion?.mmMax);
  setValue('#dir-exc-xmax', data.excursion?.xmaxMm);
  renderSplSnapshotList(root);
  setValue('#bem-subdomain-count', bemTreeItems.filter(it => it.kind === 'Subdomain').length);
  setValue('#bem-interface-count', bemTreeItems.filter(it => it.kind === 'Interface').length);
  root._bemMeshViewer?.setSymmetry(data.symmetry || 'none');

  restoreBemTreeViewerState(root);
  renderBemTree(root);
  restoreBemResults(root, data);

  const hint = root.querySelector('.bem-viewer-hint');
  if (hint) hint.textContent = bemMeshContent ? (data.meshFileName || fileName) : 'No mesh loaded';
}

async function saveBemProject(root) {
  if (!bemMeshContent && !bemTreeItems.length) {
    setBemStatus(root, 'Nothing to save yet — import a mesh first.', true);
    return;
  }
  // Sans indentation : les nappes pèsent des centaines de milliers de nombres,
  // que le pretty-print ferait tripler de volume.
  let content;
  let dropped = false;
  const project = serializeBemProject(root);
  try {
    content = JSON.stringify(project);
  } catch (err) {
    // Une nappe très fine sur beaucoup de fréquences dépasse la longueur
    // maximale d'une chaîne JavaScript. Le modèle vaut mieux que rien : on
    // réécrit sans les résultats, que « Start Sim » régénère.
    console.warn('[BEM Solver] results too large to embed', err);
    project.results = null;
    dropped = true;
    content = JSON.stringify(project);
  }
  const baseName = bemProjectFileName(root).replace(/\.[^.]*$/, '') || 'bem-study';
  const droppedNote = dropped ? ' (results were too large to embed — re-run Start Sim after loading)' : '';
  const api = window.electronAPI;
  if (api?.saveFileAs) {
    const result = await api.saveFileAs({
      defaultPath: `${baseName}.TBBS`,
      filters: [{ name: 'ToolBox BEM Study', extensions: ['TBBS'] }],
      content,
    });
    if (result?.canceled) return;
    if (!result?.success) {
      setBemStatus(root, `Save failed: ${result?.error || 'unknown error'}`, true);
      return;
    }
    setBemStatus(root, `Study saved to ${result.filePath}${droppedNote}`, dropped);
    return;
  }
  // Hors Electron : repli navigateur (téléchargement).
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}.TBBS`;
  link.click();
  URL.revokeObjectURL(url);
  setBemStatus(root, `Study saved as ${baseName}.TBBS`);
}

function makeBemTreeItem(kind, index, fieldType = 'plane', displayMode = 'shell') {
  const item = {
    id: `node-${++bemTreeSeq}`,
    kind,
    name: `${kind} ${index}`,
    expanded: false,
    visible: true,
    domainType: kind === 'Subdomain' ? 'interior' : null,
    fromId: null,   // interfaces only
    toId: null,     // interfaces only
    components: [], // subdomains only: infinite baffles / diaphragms
    surfaces: [],
  };
  if (kind !== 'Field') return item;
  return {
    ...item,
    name: fieldType === 'balloon'
      ? (displayMode === 'directivity' ? `Directivity ${index}` : `Balloon ${index}`)
      : `Plane ${index}`,
    fieldType,
    displayMode,
    quantity: 'level',
    axis: '+z',
    showWireframe: false,
    showMinus6: true,
    dbRange_db: BEM_FIELD_DB_RANGE,
    vMax_ms: 0,            // 0 = échelle automatique sur le max de la nappe
    flowOverlay: 'streamlines',   // 'none' | 'streamlines' | 'particles'
    showIsoLines: true,
    flowPhaseDeg: null,    // null = instant de débit maximal, calculé par nappe
    streamDensity: 3,      // espacement des lignes de courant, en mailles
    velocityScale: 'log',  // trois décades : la caisse et l'event tiennent ensemble
    cfdVentId: null,       // null = laisser la détection automatique choisir
    cfdCell_mm: 0,         // 0 = taille de maille du préréglage
    cfdWallLevel: 0,       // 0 = raffinement de paroi du préréglage
    cfdPeriods: 2,
    cfd: false,            // couple OpenFOAM sur le conduit d'event
    cfdQuality: 'draft',
    particleCount: 1200,
    particleSpeed: 1,      // périodes acoustiques par seconde de rendu
    offsetX_mm: 0, offsetY_mm: 0, offsetZ_mm: 0,
    width_mm: 2000, height_mm: 2000, delta_mm: 100,     // plan
    radius_mm: 1000, deltaTheta_deg: 10, deltaPhi_deg: 10, // ballon
  };
}

/** Composant attaché à un sous-domaine : baffle infini ou diaphragme. */
function makeBemComponent(type) {
  const base = { id: `cmp-${++bemTreeSeq}`, type, visible: true, axis: '+z' };
  if (type === 'baffle') {
    return { ...base, name: 'Infinite baffle', offset_mm: 0 };
  }
  return {
    ...base,
    name: 'Diaphragm',
    side: 'front',
    dD: 100, dD1: 50, tD1: 50, hD1: 30,
    dVC: 50, hD2: 20,
    offsetX: 0, offsetY: 0, offsetZ: 0,
    scaleX: 1, scaleY: 1, scaleZ: 1,
    rotationX_deg: 0, rotationY_deg: 0, rotationZ_deg: 0,
    meshSize_mm: 0,          // 0 = calée sur le maillage importé
    meshBifurcation: true,
    meshConform: true,
    driverName: null,
    driverParams: null,
  };
}

/**
 * Dépôt des surfaces du maillage volontairement exclues du modèle. Il vit en
 * tête d'arbre et n'entre ni dans la configuration du solveur ni dans l'alerte
 * « surface non assignée ».
 */
function ensureBemRepository() {
  let repo = bemTreeItems.find(it => it.kind === 'Repository');
  if (!repo) {
    repo = { ...makeBemTreeItem('Repository', 1), name: 'Repository', expanded: true };
    bemTreeItems.unshift(repo);
  }
  return repo;
}

/** Surfaces rangées au dépôt : le solveur ne doit pas les signaler comme oubliées. */
function parkedBemSurfaceIds() {
  return new Set(bemTreeItems
    .filter(it => it.kind === 'Repository')
    .flatMap(it => it.surfaces.map(s => s.meshSurfaceId)));
}

function findBemComponent(item, componentId) {
  return (item?.components || []).find(c => c.id === componentId) || null;
}

/** Composants d'un nœud chargé depuis un .TBBS ; migre l'ancien drapeau `baffle`. */
function normalizeBemComponents(item) {
  const components = Array.isArray(item.components) ? item.components.map(c => ({ ...c })) : [];
  if (item.baffle && !components.some(c => c.type === 'baffle')) {
    components.push({ ...makeBemComponent('baffle'), name: 'Infinite baffle' });
  }
  return components;
}

/** Configuration passée au viewer 3D pour un composant donné. */
function bemComponentViewerConfig(component) {
  if (component.type === 'baffle') {
    return { axis: component.axis || '+z', offset_mm: Number(component.offset_mm) || 0 };
  }
  return { mesh: bemDiaphragmMeshes.get(component.id) || null };
}

/**
 * (Re)maille un diaphragme sur le maillage hôte courant et met le résultat en
 * cache : le viewer et le solveur consomment ainsi exactement la même surface.
 */
function rebuildBemDiaphragmMesh(root, component) {
  const viewer = root._bemMeshViewer;
  const mesh = buildDiaphragmMesh(component, {
    hostVertices: viewer?.getMeshVertices?.() || null,
    hostEdge_mm: viewer?.getMedianEdgeLength?.() || 0,
    symmetry: root.querySelector('#bem-subdomain-symmetry')?.value || 'none',
  });
  bemDiaphragmMeshes.set(component.id, mesh);
  return mesh;
}

/** (Re)pousse un composant vers le viewer, ou l'en retire quand `remove` est vrai. */
function syncBemComponent(root, item, component, remove = false) {
  if (remove) bemDiaphragmMeshes.delete(component.id);
  else if (component.type === 'diaphragm') rebuildBemDiaphragmMesh(root, component);
  const viewer = root._bemMeshViewer;
  if (!viewer) return;
  const visible = remove ? false : (component.visible !== false && item.visible !== false);
  if (component.type === 'baffle') {
    viewer.setBaffle(component.id, remove ? null : bemComponentViewerConfig(component));
    if (!remove) viewer.setBaffleVisible(component.id, visible);
  } else {
    viewer.setDiaphragm(component.id, remove ? null : bemComponentViewerConfig(component));
    if (!remove) viewer.setDiaphragmVisible(component.id, visible);
  }
}

/**
 * (Re)construit la nappe d'un field, la pousse au viewer et la recolore si des
 * résultats existent. `remove` la retire de la scène et du cache.
 */
function syncBemField(root, item, remove = false) {
  if (remove) {
    bemFieldGeometries.delete(item.id);
    bemFieldCfd.delete(item.id);
    root._bemMeshViewer?.setFieldParticles?.(item.id, null);
    root._bemMeshViewer?.setFieldOverlay?.(`${item.id}:flow`, null);
    root._bemMeshViewer?.setFieldOverlay?.(`${item.id}:iso`, null);
    root._bemMeshViewer?.setField(item.id, null);
    return;
  }
  const previous = bemFieldGeometries.get(item.id);
  const geom = buildFieldGeometry(item);
  // Les sondes CFD ont été posées sur les anciens points : déplacer la nappe
  // invalide le résultat, alors qu'un simple changement de couleur non.
  const moved = previous && !samePointCloud(previous.points, geom.points);
  if (moved) {
    const hadResults = bemFieldResults.has(item.id) || bemFieldCfd.has(item.id);
    bemFieldCfd.delete(item.id);
    bemFieldResults.delete(item.id);
    if (hadResults) {
      setBemStatus(root, `${item.name}: the plane moved, its results were dropped — `
        + 'press Start field to recompute.', true);
    }
  }
  bemFieldGeometries.set(item.id, geom);
  renderBemField(root, item);
}

function samePointCloud(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
  }
  return true;
}

/**
 * Vitesse particulaire d'une nappe, ramenée en m/s réels.
 *
 * En régime harmonique le vecteur vitesse décrit une ELLIPSE au cours de la
 * période : v(t) = A·cos(ωt) + B·sin(ωt) avec A = Re(v̂), B = Im(v̂). La vitesse
 * de crête est donc le demi-grand axe de cette ellipse, pas |v̂| — c'est cette
 * crête qui décide du souffle d'un event, et elle peut dépasser de 40 % la
 * valeur qu'on lirait sur une seule composante.
 *
 * `scale` convertit l'amplitude unité du BEM en amplitude CRÊTE physique.
 */
function bemFieldSpeeds(entry, scale) {
  if (!entry?.vRe || !entry?.vIm) return null;
  const n = entry.mag.length;
  const peak = new Float64Array(n);
  const rms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ax = entry.vRe[3 * i] * scale, ay = entry.vRe[3 * i + 1] * scale, az = entry.vRe[3 * i + 2] * scale;
    const bx = entry.vIm[3 * i] * scale, by = entry.vIm[3 * i + 1] * scale, bz = entry.vIm[3 * i + 2] * scale;
    const a2 = ax * ax + ay * ay + az * az;
    const b2 = bx * bx + by * by + bz * bz;
    const ab = ax * bx + ay * by + az * bz;
    const mean = (a2 + b2) / 2;
    const swing = Math.hypot((a2 - b2) / 2, ab);
    // NaN = point masqué par le solveur (trop près d'une paroi) ; il se propage
    // et sera rendu en gris, hors échelle et hors maximum.
    peak[i] = Math.sqrt(mean + swing);
    rms[i] = Math.sqrt(mean);
  }
  let max = 0, masked = 0;
  for (const v of peak) {
    if (Number.isFinite(v)) { if (v > max) max = v; }
    else masked++;
  }
  return { peak, rms, max, masked };
}

/**
 * Échelle d'affichage d'un champ de vitesse, en m/s.
 *
 * Les arêtes vives d'entrée et de sortie portent des singularités : quelques
 * points y montent 10× au-dessus du reste. Caler l'échelle sur le maximum
 * absolu écrase alors tout le corps du conduit dans la première couleur. On
 * prend donc le 98e centile, quitte à saturer ces quelques points.
 */
function bemPercentileScale(values, valid = null) {
  const vals = [];
  for (let i = 0; i < values.length; i++) {
    if ((!valid || valid[i]) && Number.isFinite(values[i])) vals.push(values[i]);
  }
  if (!vals.length) return 1e-6;
  vals.sort((a, b) => a - b);
  return Math.max(vals[Math.floor(vals.length * 0.98)], 1e-6);
}

function bemTurbulenceScale(cfd, item) {
  if (Number(item.vMax_ms) > 0) return Number(item.vMax_ms);
  return bemPercentileScale(cfd.turbulence, cfd.valid);
}

// L'air d'une caisse close bouge à quelques cm/s quand l'event souffle à
// plusieurs dizaines de m/s : trois décades séparent les deux, ce qu'une rampe
// linéaire ne peut pas montrer d'un seul tenant.
const BEM_VELOCITY_DECADES = 3;

/** Rampe bleu → cyan → vert → jaune → rouge, pour t ∈ [0, 1]. */
function velocityRamp(t) {
  const stops = [[12, 24, 64], [24, 112, 224], [16, 196, 176], [190, 220, 40], [250, 160, 30], [235, 40, 40]];
  const s = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const u = s - i;
  return [0, 1, 2].map(c => Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * u));
}

/** Couleur d'une vitesse en m/s, en échelle linéaire ou logarithmique. */
function velocityColor(value, vMax, logScale) {
  if (!Number.isFinite(value)) return [58, 58, 66];   // point masqué : gris neutre
  const top = Math.max(vMax, 1e-9);
  if (!logScale) return velocityRamp(value / top);
  if (!(value > 0)) return velocityRamp(0);
  return velocityRamp(1 + Math.log10(value / top) / BEM_VELOCITY_DECADES);
}

/** Vitesse correspondant à la position t ∈ [0, 1] sur l'échelle affichée. */
function velocityAtRamp(t, vMax, logScale) {
  return logScale ? vMax * Math.pow(10, -(1 - t) * BEM_VELOCITY_DECADES) : t * vMax;
}

/** Étiquette compacte d'une vitesse, lisible sur trois décades. */
function formatVelocityTick(v) {
  if (!(v > 0)) return '0';
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  if (v >= 0.1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3);
  return v.toExponential(0).replace('e-', 'e−');
}

// Pas de temps par période imposés par les préréglages de foamCase.js.
const BEM_CFD_PRESETS = { draft: { cell_mm: 8, stepsPerPeriod: 200 }, normal: { cell_mm: 3, stepsPerPeriod: 400 } };
// Dernier calcul CFD abouti : sert de point d'appui pour estimer le suivant.
let bemCfdLastRun = null;

/**
 * Coût du prochain calcul CFD, extrapolé du dernier qui a tourné.
 *
 * Aucun modèle a priori ne vaut une mesure : on part du nombre de cellules et
 * du temps réellement observés, mis à l'échelle par le cube du rapport des
 * mailles (le maillage est volumique) et par le nombre de pas de temps. Le
 * raffinement de paroi n'agit que sur une surface, d'où un facteur 2 par
 * niveau et non 8.
 */
function estimateBemCfdCost(item) {
  const preset = BEM_CFD_PRESETS[item.cfdQuality === 'normal' ? 'normal' : 'draft'];
  const cell = item.cfdCell_mm > 0 ? item.cfdCell_mm : preset.cell_mm;
  const steps = Math.round(preset.stepsPerPeriod * (item.cfdPeriods || 2));
  if (!bemCfdLastRun?.cells) return null;
  const cells = Math.round(bemCfdLastRun.cells
    * Math.pow(bemCfdLastRun.cell_mm / cell, 3)
    * Math.pow(2, (item.cfdWallLevel || 0) - bemCfdLastRun.wallLevel));
  const seconds = bemCfdLastRun.elapsed_s
    * (cells / bemCfdLastRun.cells) * (steps / bemCfdLastRun.steps);
  return { cells, steps, label: formatDurationApprox(seconds) };
}

/** Durée lisible, arrondie à l'ordre de grandeur qui compte. */
function formatDurationApprox(s) {
  if (!(s > 0)) return '—';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Reporte le choix d'event du Field sur l'arbre, qui en reste la référence. */
function applyBemVentChoice(ventId) {
  bemTreeItems.forEach(it => {
    if (it.kind === 'Subdomain') it.cfdVent = ventId ? it.id === ventId : false;
  });
}

/** Options du sélecteur d'event : « Auto » plus tous les sous-domaines. */
function bemVentOptions() {
  const picked = bemTreeItems.find(it => it.kind === 'Subdomain' && it.cfdVent === true);
  const auto = detectBemVentDuct();
  const autoName = !picked && auto?.ventName ? ` — ${auto.ventName}` : '';
  return [`<option value=""${picked ? '' : ' selected'}>Auto${autoName}</option>`]
    .concat(bemTreeItems.filter(it => it.kind === 'Subdomain')
      .map(sd => `<option value="${sd.id}"${sd.id === picked?.id ? ' selected' : ''}>${sd.name}</option>`))
    .join('');
}

/**
 * Surfaces dont le solveur doit remonter le débit volumique. Toujours demandé :
 * l'intégrale est négligeable devant la résolution et évite de refaire tourner
 * le BEM quand l'utilisateur active la CFD après coup.
 */
function bemVentFlowSurfaces() {
  const duct = detectBemVentDuct();
  return duct?.groups ? [...duct.groups.inlet, ...duct.groups.outlet] : [];
}

/**
 * Axe du plan de symétrie pour le dépliage du maillage CFD.
 * 'v' = plan x = 0, 'h' = plan y = 0. Un quart de maillage ('hv') n'est pas
 * dépliable en une seule opération et est refusé plus haut.
 */
function bemMirrorAxis(root) {
  const symmetry = root.querySelector('#bem-subdomain-symmetry')?.value || 'none';
  if (symmetry === 'v') return 0;
  if (symmetry === 'h') return 1;
  return null;
}

/**
 * Découpe les surfaces d'un sous-domaine en parois / entrée / sortie.
 *
 * Les surfaces propres au sous-domaine sont les parois ; des deux interfaces,
 * celle qui débouche sur l'extérieur est la sortie — c'est le sens dans lequel
 * l'air est poussé à la première alternance. Faute d'extérieur (event entre
 * deux chambres), le sens est arbitraire : l'écoulement étant alternatif, cela
 * ne change rien au résultat.
 * @returns {{groups: object}|{error: string}}
 */
function bemVentDuctGroups(vent, interfaces, byId) {
  const surfaceIds = it => (it.surfaces || []).filter(s => s.meshSurfaceId).map(s => s.meshSurfaceId);
  const touching = interfaces.filter(i => i.fromId === vent.id || i.toId === vent.id);
  if (touching.length !== 2) {
    return { error: `« ${vent.name} » touche ${touching.length} interface(s) : un conduit d'event en demande exactement 2` };
  }
  const other = i => byId.get(i.fromId === vent.id ? i.toId : i.fromId);
  const outer = touching.find(i => other(i)?.domainType === 'exterior') || touching[1];
  const inner = touching.find(i => i !== outer);

  const wall = surfaceIds(vent);
  const inlet = surfaceIds(inner);
  const outlet = surfaceIds(outer);
  if (!wall.length) return { error: `« ${vent.name} » n'a aucune surface de paroi assignée` };
  if (!inlet.length || !outlet.length) return { error: `les interfaces de « ${vent.name} » n'ont pas de surface assignée` };
  return { groups: { wall, inlet, outlet } };
}

/**
 * Repère le conduit d'event dans l'arbre.
 *
 * Priorité au sous-domaine explicitement marqué « CFD vent » dans ses
 * propriétés. Sans marquage, on retombe sur l'heuristique : le seul
 * sous-domaine INTÉRIEUR sans diaphragme relié à deux interfaces dont l'une
 * débouche sur l'extérieur.
 * @returns {{ventId: string, ventName: string, groups: object}|{error: string}|null}
 */
function detectBemVentDuct() {
  const subdomains = bemTreeItems.filter(it => it.kind === 'Subdomain');
  const interfaces = bemTreeItems.filter(it => it.kind === 'Interface');
  const byId = new Map(subdomains.map(s => [s.id, s]));
  const surfaceIds = it => (it.surfaces || []).filter(s => s.meshSurfaceId).map(s => s.meshSurfaceId);

  const picked = subdomains.find(s => s.cfdVent === true);
  if (picked) {
    const res = bemVentDuctGroups(picked, interfaces, byId);
    if (res.error) return { error: res.error };
    return { ventId: picked.id, ventName: picked.name, groups: res.groups };
  }

  for (const vent of subdomains) {
    if (vent.domainType !== 'interior') continue;
    if ((vent.components || []).some(c => c.type === 'diaphragm')) continue;
    const touching = interfaces.filter(i => i.fromId === vent.id || i.toId === vent.id);
    if (touching.length !== 2) continue;

    const other = i => byId.get(i.fromId === vent.id ? i.toId : i.fromId) || null;
    const outer = touching.find(i => other(i)?.domainType === 'exterior');
    if (!outer) continue;
    const inner = touching.find(i => i !== outer);

    const wall = surfaceIds(vent);
    const inlet = surfaceIds(inner);
    const outlet = surfaceIds(outer);
    if (!wall.length || !inlet.length || !outlet.length) continue;
    return { ventId: vent.id, ventName: vent.name, groups: { wall, inlet, outlet } };
  }
  return null;
}

/**
 * Vitesse débitante crête à chaque bouche de l'event, en m/s, avec l'aire
 * correspondante en m².
 *
 * Les deux bouches portent le même débit mais pas la même section dès que
 * l'event s'évase : c'est la SORTIE qui décide du souffle audible, puisque
 * c'est là que le jet débouche dans la pièce.
 */
function bemVentMouthVelocities(root, freq, groups) {
  const drive = bemDriveScaleAt(root, freq);
  if (!drive) return null;
  const at = (ids) => {
    const flow = (bemResults?.surfaceFlow || []).find(e => e.f === freq && ids.includes(e.surfaceId));
    if (!flow || !(flow.area > 0)) return null;
    const v = Math.SQRT2 * drive.vCone_ms * Math.hypot(flow.re, flow.im) / flow.area;
    return Number.isFinite(v) && v > 0 ? { v, area: flow.area } : null;
  };
  const inlet = at(groups.inlet);
  const outlet = at(groups.outlet);
  return inlet || outlet ? { inlet, outlet } : null;
}

/**
 * Vitesse d'air CRÊTE imposée à l'entrée du conduit, en m/s.
 *
 * Le BEM rend le débit volumique de l'event à vitesse de membrane unité ; le
 * couplage T&S donne la vitesse de membrane réelle sous la tension demandée.
 */
function bemVentInletVelocity(root, freq, groups) {
  const drive = bemDriveScaleAt(root, freq);
  if (!drive) return null;
  const flow = (bemResults?.surfaceFlow || [])
    .find(e => e.f === freq && groups.inlet.includes(e.surfaceId));
  if (!flow || !(flow.area > 0)) return null;
  const u0 = Math.SQRT2 * drive.vCone_ms * Math.hypot(flow.re, flow.im) / flow.area;
  return Number.isFinite(u0) && u0 > 0 ? u0 : null;
}

/**
 * Lance OpenFOAM sur l'event et range le résultat pour les nappes concernées.
 * Les nappes partagent le même conduit : un seul calcul suffit, on l'échantillonne
 * sur l'union de leurs points.
 */
async function runBemVentCfd(root, items, freq, onStatus) {
  const symmetry = root.querySelector('#bem-subdomain-symmetry')?.value || 'none';
  if (symmetry === 'hv') {
    return { ok: false, reason: 'la symétrie HV donne un quart de maillage, non dépliable pour la CFD' };
  }
  const duct = detectBemVentDuct();
  if (duct?.error) return { ok: false, reason: duct.error };
  if (!duct) {
    return { ok: false, reason: 'aucun conduit d\'event identifié — cochez « CFD vent » '
      + 'dans les propriétés du sous-domaine concerné' };
  }
  const u0 = bemVentInletVelocity(root, freq, duct.groups);
  if (!u0) return { ok: false, reason: 'débit d\'event indisponible — relancez la simulation' };

  // Un seul cas CFD pour toutes les nappes : les sondes sont concaténées et
  // redécoupées à l'arrivée.
  const slices = [];
  const probePoints_mm = [];
  for (const item of items) {
    const geom = bemFieldGeometries.get(item.id) || buildFieldGeometry(item);
    slices.push({ id: item.id, start: probePoints_mm.length, count: geom.points.length });
    for (const p of geom.points) probePoints_mm.push(p);
  }

  const quality = items.some(it => it.cfdQuality === 'normal') ? 'normal' : 'draft';
  // Réglages de maillage : le plus fin de toutes les nappes du même conduit.
  const cells_mm = items.map(it => it.cfdCell_mm || 0).filter(v => v > 0);
  const baseCell_mm = cells_mm.length ? Math.min(...cells_mm) : undefined;
  const wallLevel = Math.max(0, ...items.map(it => it.cfdWallLevel || 0));
  const periods = Math.max(1, ...items.map(it => it.cfdPeriods || 2));
  const off = window.electronAPI?.onFoamProgress?.(({ phase, detail }) => {
    if (onStatus) onStatus(`CFD ${phase}: ${detail}`);
  });
  try {
    const res = await window.electronAPI.foamRunVentCfd({
      mshContent: bemMeshContent,
      groups: duct.groups,
      mirrorAxis: bemMirrorAxis(root),
      frequency_Hz: freq,
      inletVelocity_ms: u0,
      probePoints_mm,
      periods,
      quality,
      baseCell_mm,
      wallLevel: wallLevel || undefined,
      cores: 8,
    });
    if (!res?.ok) return { ok: false, reason: res?.reason || 'le calcul CFD a échoué' };

    for (const slice of slices) {
      const end = slice.start + slice.count;
      bemFieldCfd.set(slice.id, {
        freq,
        inletVelocity_ms: u0,
        ventName: duct.ventName,
        quality: res.info?.quality || quality,
        cells: res.cells,
        vRe: res.vRe.slice(3 * slice.start, 3 * end),
        vIm: res.vIm.slice(3 * slice.start, 3 * end),
        vMean: res.vMean.slice(3 * slice.start, 3 * end),
        turbulence: res.turbulence.slice(slice.start, end),
        valid: res.valid.slice(slice.start, end),
      });
    }
    if (res.cells) {
      bemCfdLastRun = {
        cells: res.cells,
        elapsed_s: res.elapsed_s || 0,
        cell_mm: res.info?.baseCell_mm || BEM_CFD_PRESETS[quality].cell_mm,
        wallLevel,
        steps: Math.round(BEM_CFD_PRESETS[quality].stepsPerPeriod * periods),
      };
    }
    return { ok: true, u0, cells: res.cells, elapsed_s: res.elapsed_s, quality };
  } finally {
    if (off) off();
  }
}

/**
 * Remplace la vitesse acoustique linéaire par celle de la CFD là où celle-ci a
 * un sens — c'est-à-dire dans le conduit. Ailleurs le BEM reste seul valable.
 *
 * Les deux champs ne vivent pas dans la même unité : le BEM est à vitesse de
 * membrane unité, la CFD en m/s absolus. On ramène tout en m/s et le facteur
 * d'échelle qui sort vaut donc 1.
 */
function mergeBemFieldCfd(item, entry, scale, freq) {
  const cfd = bemFieldCfd.get(item.id);
  if (!entry?.vRe || !cfd || cfd.freq !== freq || item.cfd === false) return null;
  const n = entry.mag.length;
  if (cfd.valid.length !== n) return null;

  const vRe = new Float32Array(3 * n);
  const vIm = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) {
    vRe[i] = entry.vRe[i] * scale;
    vIm[i] = entry.vIm[i] * scale;
  }
  let replaced = 0;
  for (let i = 0; i < n; i++) {
    if (!cfd.valid[i]) continue;
    replaced++;
    for (let c = 0; c < 3; c++) {
      vRe[3 * i + c] = cfd.vRe[3 * i + c];
      vIm[3 * i + c] = cfd.vIm[3 * i + c];
    }
  }
  return { entry: { ...entry, vRe, vIm }, scale: 1, cfd, replaced };
}

/**
 * Pousse la nappe au viewer dans son état courant : forme (sphère de mesure ou
 * ballon de directivité déformé par le niveau), couleurs et contour −6 dB.
 */
function renderBemField(root, item) {
  const viewer = root._bemMeshViewer;
  const geom = bemFieldGeometries.get(item.id);
  if (!viewer || !geom) return;

  const dbRange = Math.max(1, Number(item.dbRange_db) || BEM_FIELD_DB_RANGE);
  const freq = selectedBemFieldFreq(root);
  const entry = bemFieldResults.get(item.id)?.find(e => e.f === freq) || null;
  let levels = null;
  if (entry) {
    const spl = entry.mag.map(m => pressureToSpl(m));
    const max = spl.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);
    if (Number.isFinite(max)) levels = spl.map(v => (Number.isFinite(v) ? v - max : -Infinity));
  }

  // Amplitude CRÊTE physique : le couplage T&S rend une vitesse efficace.
  const drive = bemDriveScaleAt(root, freq);
  let speedScale = (drive ? drive.vCone_ms : 1) * Math.SQRT2;
  let velEntry = entry;
  // Là où la CFD a tourné, elle remplace l'acoustique linéaire : elle seule voit
  // le décrochage et les pertes visqueuses dans le conduit.
  const merged = mergeBemFieldCfd(item, entry, speedScale, freq);
  if (merged) { velEntry = merged.entry; speedScale = merged.scale; }
  const speeds = bemFieldSpeeds(velEntry, speedScale);

  const deform = levels && item.fieldType === 'balloon' && item.displayMode === 'directivity';
  const points = deform ? deformBalloon(geom, levels, dbRange) : geom.points;
  const contour = (levels && !bemFieldNeedsVelocity(item) && item.showMinus6 !== false && dbRange > 6)
    ? gridIsoContour(points, levels, geom.stats, -6)
    : [];

  // La forme reste toujours pilotée par le niveau ; seule la couleur suit la
  // grandeur choisie, pour lire la phase sur le lobe réel.
  let colors = null;
  const logScale = item.velocityScale === 'log';
  if (speeds && item.quantity === 'turbulence' && merged) {
    // Écart à la sinusoïde pure : ce qui reste une fois l'acoustique retirée.
    const tMax = bemTurbulenceScale(merged.cfd, item);
    colors = [...merged.cfd.turbulence].map((v, i) => velocityColor(merged.cfd.valid[i] ? v : NaN, tMax, logScale));
  } else if (speeds && (item.quantity === 'velocity' || item.quantity === 'turbulence')) {
    const vMax = Number(item.vMax_ms) > 0 ? Number(item.vMax_ms) : bemPercentileScale(speeds.peak);
    colors = [...speeds.peak].map(v => velocityColor(v, vMax, logScale));
  } else if (levels && item.quantity === 'phase') colors = entry.phaseDeg.map(phaseColor);
  else if (levels) colors = levels.map(v => vividColor(rewColor(v, dbRange)));

  viewer.setField(item.id, {
    points, tris: geom.tris, contour,
    wireframe: item.showWireframe === true,
  });
  viewer.setFieldVisible(item.id, item.visible !== false);
  viewer.setFieldColors(item.id, colors);
  renderBemFieldFlow(root, item, geom, velEntry, speeds, freq, speedScale);
}

/**
 * Surcouches d'écoulement : lignes de courant fléchées, iso-vitesses et
 * particules animées. Tout est réservé à la grandeur « vitesse » sur une nappe
 * PLANE — la grille (u,v) d'un ballon n'a pas de sens pour un écoulement, et
 * afficher des particules par-dessus une carte de niveau dB n'en a pas non plus.
 */
function renderBemFieldFlow(root, item, geom, entry, speeds, freq, scale) {
  const viewer = root._bemMeshViewer;
  if (!viewer) return;
  const clear = () => {
    viewer.setFieldParticles?.(item.id, null);
    viewer.setFieldOverlay?.(`${item.id}:flow`, null);
    viewer.setFieldOverlay?.(`${item.id}:iso`, null);
  };

  const usable = (item.quantity === 'velocity' || item.quantity === 'turbulence')
    && item.visible !== false
    && item.fieldType !== 'balloon' && entry?.vRe && speeds && freq > 0;
  if (!usable) { clear(); return; }

  const vMax = Number(item.vMax_ms) > 0 ? Number(item.vMax_ms) : Math.max(speeds.max, 1e-9);
  const field = {
    points: geom.points,
    gridU: geom.stats.gridU,
    gridV: geom.stats.gridV,
    vRe: entry.vRe,
    vIm: entry.vIm,
    peak: speeds.peak,
    scale,
  };
  const phaseRad = Number.isFinite(item.flowPhaseDeg)
    ? item.flowPhaseDeg * Math.PI / 180
    : peakFlowPhase(entry.vRe, entry.vIm);

  const mode = item.flowOverlay === 'particles' ? 'particles'
    : item.flowOverlay === 'none' ? 'none' : 'streamlines';

  viewer.setFieldParticles?.(item.id, mode === 'particles' ? {
    ...field,
    freq,
    count: Math.round(item.particleCount ?? 1200),
    periodsPerSecond: Number(item.particleSpeed) || 1,
    vMax,
  } : null);

  if (mode === 'streamlines') {
    const line = buildStreamlines(field, {
      phaseRad,
      separation: Math.max(1, Number(item.streamDensity) || 3),
    });
    const positions = new Float32Array(line.positions.length + line.arrows.length);
    positions.set(line.positions, 0);
    positions.set(line.arrows, line.positions.length);
    const all = [...line.speeds, ...line.arrowSpeeds];
    const colors = new Float32Array(all.length * 3);
    for (let i = 0; i < all.length; i++) {
      // Assombri dans les zones lentes pour que le tracé reste lisible sur la
      // carte de couleurs sans la masquer.
      const t = clamp(all[i] / vMax, 0, 1);
      const g = 0.45 + 0.55 * Math.sqrt(t);
      colors[3 * i] = g; colors[3 * i + 1] = g; colors[3 * i + 2] = g;
    }
    viewer.setFieldOverlay?.(`${item.id}:flow`, { positions, colors, opacity: 0.9 });
  } else {
    viewer.setFieldOverlay?.(`${item.id}:flow`, null);
  }

  if (item.showIsoLines !== false) {
    const levels = [];
    for (let i = 1; i <= 9; i++) levels.push((i / 10) * vMax);
    const positions = buildIsoLines(geom.points, speeds.peak, field.gridU, field.gridV, levels);
    viewer.setFieldOverlay?.(`${item.id}:iso`, { positions, color: 0x0b1220, opacity: 0.55 });
  } else {
    viewer.setFieldOverlay?.(`${item.id}:iso`, null);
  }
}

/** Roue de teintes cyclique : ±180° se rejoignent, deux points de même couleur sont en phase. */
function phaseColor(deg) {
  const wrapped = ((deg % 360) + 540) % 360;   // 0 → -180°, 180 → 0°, 360 → +180°
  const h = wrapped / 60;
  const x = 255 * (1 - Math.abs((h % 2) - 1));
  const table = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]];
  return table[Math.min(5, Math.floor(h))].map(c => Math.round(c));
}

/** Fields cochés au moment du Start Sim : ce sont eux que le solveur calcule. */
function activeBemFields() {
  return bemTreeItems.filter(it => it.kind === 'Field' && it.visible !== false);
}

/** Un field a besoin du champ de vitesse dès qu'il l'affiche. */
function bemFieldNeedsVelocity(item) {
  return item.quantity === 'velocity' || item.quantity === 'turbulence';
}

/** Charge utile solveur des fields cochés. */
function activeBemFieldPayload() {
  return activeBemFields().map(item => ({
    id: item.id,
    name: item.name,
    type: item.fieldType,
    withVelocity: bemFieldNeedsVelocity(item),
    points_mm: (bemFieldGeometries.get(item.id) || buildFieldGeometry(item)).points,
  }));
}

/**
 * Impédance nominale du haut-parleur, en ohms.
 *
 * La puissance affichée suit la convention de sensibilité (2,83 V = 1 W sous
 * 8 Ω), donc elle se rapporte à l'impédance NOMINALE, pas à Re : sur un 8 Ω,
 * Re vaut typiquement 5,5 Ω et donnerait 46 W là où l'usage lit 32 W.
 * Faute de valeur déclarée, on la déduit de Re via la règle IEC 60268-5
 * (Re ≥ 80 % du nominal) en calant sur la valeur normalisée la plus proche.
 */
function bemNominalImpedance(params) {
  if (params.Znom > 0) return params.Znom;
  if (!(params.Re > 0)) return 0;
  const target = params.Re / 0.8;
  return [2, 4, 8, 16, 32].reduce((best, z) =>
    Math.abs(Math.log(z / target)) < Math.abs(Math.log(best / target)) ? z : best);
}

/**
 * Facteur d'échelle du champ à une fréquence : le BEM tourne à vitesse de
 * diaphragme UNITÉ, alors que la vitesse d'air réelle dans un event dépend de
 * la tension appliquée. On réutilise exactement le couplage T&S du SPL, charge
 * acoustique BEM comprise, pour que la carte de vitesse soit en vrais m/s.
 * @returns {{vCone_ms: number, vRms: number, watts: number, zNom: number, driverName: string, filterDb: number}|null}
 */
function bemDriveScaleAt(root, freq) {
  if (!bemResults || !Number.isFinite(freq)) return null;
  const diaphragm = bemTreeItems
    .filter(item => item.kind === 'Subdomain')
    .flatMap(item => item.components || [])
    .find(c => c.type === 'diaphragm' && c.driverParams) || null;
  if (!diaphragm) return null;

  const params = normalizeBemDriverParams(diaphragm.driverParams);
  // Le filtre est en amont de l'ampli : le haut-parleur voit V·|H(f)|. Comme
  // tout le BEM est linéaire en cette tension, il suffit de la corriger ici
  // pour que nappes, vitesse particulaire et débit d'event suivent.
  const vRms = bemDriveVrms(root) * filterChainGain(bemFilters, freq);
  const index = (bemResults.freqs || []).findIndex(f => f === freq);
  const load = index >= 0 ? (bemResults.drivenLoad || [])[index] || null : null;
  const vCone = driverVelocityFromTs(params, freq, vRms, load);
  const zNom = bemNominalImpedance(params);
  return {
    vCone_ms: vCone,
    vRms,
    watts: zNom > 0 ? (vRms * vRms) / zNom : 0,
    zNom,
    driverName: diaphragm.driverName || 'driver',
    filterDb: activeBemFilters().length ? filterChainGainDb(bemFilters, freq) : 0,
  };
}

const BEM_FILTER_TYPES = [
  { value: 'off', label: '— off —' },
  { value: 'peak', label: 'Peak' },
  { value: 'hpf', label: 'High-pass' },
  { value: 'lpf', label: 'Low-pass' },
];

const BEM_FILTER_ALIGNMENTS = [
  { value: 'bw', label: 'BW' },
  { value: 'lr', label: 'LR' },
  { value: 'custom', label: 'Free Q' },
];

/** Remplit la popup de filtres depuis `bemFilters`. */
function renderBemFilterRows(root) {
  const host = root.querySelector('#bem-filter-rows');
  if (!host) return;
  host.innerHTML = Array.from({ length: BEM_FILTER_SLOTS }, (_, i) => {
    const f = bemFilters[i] || {};
    const type = f.type || 'off';
    const alignment = f.alignment || 'bw';
    // Un Linkwitz-Riley est une cascade de deux Butterworth d'ordre moitié :
    // les ordres impairs n'ont pas d'équivalent et sont retirés du choix.
    const orders = [1, 2, 3, 4, 5, 6, 7, 8]
      .map(n => `<option value="${n}"${(f.order || 2) === n ? ' selected' : ''}${alignment === 'lr' && n % 2 ? ' disabled' : ''}>${n} · ${6 * n} dB/oct</option>`).join('');
    return `<div class="bem-filter-row" data-slot="${i}">
      <label class="bem-switch">
        <input type="checkbox" class="-on"${f.enabled === false ? '' : ' checked'} title="Bypass this band without losing its settings">
        <span class="-track"></span>
      </label>
      <select class="dir-input -type">${BEM_FILTER_TYPES
        .map(t => `<option value="${t.value}"${type === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}</select>
      <input type="number" class="dir-input -freq" min="1" step="1" value="${f.freq_Hz ?? 40}">
      <select class="dir-input -align">${BEM_FILTER_ALIGNMENTS
        .map(a => `<option value="${a.value}"${alignment === a.value ? ' selected' : ''}>${a.label}</option>`).join('')}</select>
      <input type="number" class="dir-input -q" min="0.1" max="20" step="0.01" value="${f.q ?? 0.707}">
      <input type="number" class="dir-input -gain" min="-24" max="24" step="0.5" value="${f.gain_dB ?? 0}">
      <select class="dir-input -order">${orders}</select>
    </div>`;
  }).join('');
  host.querySelectorAll('.bem-filter-row').forEach(row => {
    const refresh = () => {
      const alignEl = row.querySelector('.-align');
      const orderEl = row.querySelector('.-order');
      const type = row.querySelector('.-type').value;
      const cut = type === 'hpf' || type === 'lpf';
      const alignment = alignEl.value;

      // Un LR n'existe qu'en ordre pair, et un Q libre ne décrit qu'un biquad :
      // on interdit les combinaisons plutôt que de les corriger en silence.
      [...orderEl.options].forEach(opt => { opt.disabled = alignment === 'lr' && Number(opt.value) % 2 === 1; });
      if (alignment === 'custom') orderEl.value = '2';
      else if (alignment === 'lr' && Number(orderEl.value) % 2 === 1) {
        orderEl.value = String(Math.min(8, Number(orderEl.value) + 1));
      }

      row.querySelector('.-freq').disabled = type === 'off';
      row.querySelector('.-gain').disabled = type !== 'peak';
      alignEl.disabled = !cut;
      orderEl.disabled = !cut || alignment === 'custom';
      row.querySelector('.-q').disabled = type === 'peak' ? false : !(cut && alignment === 'custom');
      row.classList.toggle('-bypassed', !row.querySelector('.-on').checked);
    };
    row.addEventListener('change', () => { refresh(); updateBemFilterSummary(root); });
    row.addEventListener('input', () => updateBemFilterSummary(root));
    refresh();
  });
  updateBemFilterSummary(root);
}

/** Lit la popup sans y toucher, pour l'aperçu comme pour l'application. */
function readBemFilterRows(root) {
  return [...root.querySelectorAll('#bem-filter-rows .bem-filter-row')]
    .map(row => ({
      type: row.querySelector('.-type').value,
      enabled: row.querySelector('.-on').checked,
      freq_Hz: parseFloat(row.querySelector('.-freq').value) || 0,
      alignment: row.querySelector('.-align').value,
      q: parseFloat(row.querySelector('.-q').value) || Math.SQRT1_2,
      gain_dB: parseFloat(row.querySelector('.-gain').value) || 0,
      order: parseInt(row.querySelector('.-order').value, 10) || 2,
    }))
    // Une bande contournée est conservée : elle garde ses réglages et se
    // réactive d'un clic. `filterResponse` la rend transparente d'ici là.
    .filter(f => f.type !== 'off' && f.freq_Hz > 0);
}

/** Bandes qui pèsent réellement sur la réponse. */
function activeBemFilters() {
  return bemFilters.filter(f => f.enabled !== false);
}

/** Aperçu du gain aux fréquences qui comptent pour un bass-reflex. */
function updateBemFilterSummary(root) {
  const el = root.querySelector('#bem-filter-summary');
  if (!el) return;
  const filters = readBemFilterRows(root).filter(f => f.enabled !== false);
  if (!filters.length) { el.textContent = 'No filter — the drive voltage is applied flat.'; return; }
  const freqs = bemResults?.freqs?.length
    ? [20, 30, 40, 50, 60, 80, 120].filter(f => f >= bemResults.freqs[0] && f <= bemResults.freqs[bemResults.freqs.length - 1])
    : [20, 30, 40, 50, 60, 80, 120];
  el.textContent = `Chain gain: ${freqs.map(f => `${f} Hz ${filterChainGainDb(filters, f).toFixed(1)} dB`).join('  ·  ')}`;
}

/**
 * Applique la chaîne de filtres : rien n'est resolvé côté BEM, tout est
 * réévalué. La CFD, elle, est non linéaire — un débit d'event modifié rend son
 * résultat caduc, on le jette plutôt que d'afficher un champ faux.
 */
function applyBemFilters(root) {
  bemFilters = readBemFilterRows(root);
  const active = activeBemFilters().length;
  root.querySelector('#bem-btn-filters')?.classList.toggle('-active', active > 0);

  const stale = [...bemFieldCfd.entries()].filter(([id, cfd]) => {
    const item = bemTreeItems.find(it => it.id === id);
    if (!item) return true;
    const u0 = bemVentInletVelocityFor(root, cfd.freq);
    return !u0 || Math.abs(u0 - cfd.inletVelocity_ms) > 0.02 * cfd.inletVelocity_ms;
  });
  stale.forEach(([id]) => bemFieldCfd.delete(id));

  if (bemResults) updateSplDataFromBemResult(bemResults, buildBemSolverConfig(root));
  if (bemResults) applyBemResultsToGraphs(root, bemResults, false);
  paintBemFields(root);
  updateBemFieldControls(root);
  setBemStatus(root, stale.length
    ? `Filters applied. ${stale.length} CFD result(s) dropped: the port velocity changed and `
      + 'Navier-Stokes does not scale — press Start CFD to recompute.'
    : active
      ? `Filters applied (${active} active) — no re-solve needed, the BEM is linear.`
      : 'Filters cleared.', stale.length > 0);
}

/** Débit d'event sous les filtres courants, pour juger une CFD périmée. */
function bemVentInletVelocityFor(root, freq) {
  const duct = detectBemVentDuct();
  return duct?.groups ? bemVentInletVelocity(root, freq, duct.groups) : null;
}

// Dernière sonde du backend CFD, pour ne pas retraverser WSL à chaque clic.
let bemCfdEnv = null;

const BEM_WSL_INSTALL_CMD = 'wsl --install -d Ubuntu-24.04';

/**
 * Traduit le diagnostic du backend en un remède concret.
 *
 * Activer WSL ou installer une distribution demande l'élévation Windows, qu'une
 * application ne peut pas s'accorder : on donne la commande à lancer. Installer
 * OpenFOAM dans une distribution existante, en revanche, se fait en root DANS
 * la distribution — donc sans privilège Windows, et donc depuis ici.
 */
function bemCfdRemedy(env) {
  switch (env?.stage) {
    case 'ok':
      return {
        ok: true,
        html: `<span class="-ok">Ready.</span> OpenFOAM ${escapeHtml(env.version || '?')} in `
          + `${escapeHtml(env.distro)} · ${env.cores || '?'} cores.`,
      };
    case 'no-scripts':
      return {
        html: '<span class="-warn">The CFD helper scripts are missing from this installation.</span>\n'
          + `${escapeHtml(env.reason || '')}\nReinstall the application — this is a packaging fault, not a missing dependency.`,
      };
    case 'no-wsl':
      // Hors Windows, WSL ne peut pas exister : proposer `wsl --install` y
      // enverrait l'utilisateur exécuter une commande qui n'existe pas.
      if (window.electronAPI?.platform !== 'win32') {
        return {
          html: '<span class="-warn">The vent CFD pipeline requires Windows.</span>\n'
            + 'It runs OpenFOAM inside WSL, which is only available on Windows 10/11. '
            + 'Every other module of the application works on this platform.',
        };
      }
      return {
        html: '<span class="-warn">WSL is not available on this machine.</span>\n'
          + 'WSL ships with Windows 10/11 but has to be enabled once, from a terminal opened '
          + '<b>as administrator</b>. A reboot is required afterwards.',
        command: BEM_WSL_INSTALL_CMD,
      };
    case 'no-distro':
      return {
        html: '<span class="-warn">WSL is present, but no Linux distribution is installed.</span>\n'
          + 'Run this once in a terminal, let it finish, then come back and press Re-check.',
        command: BEM_WSL_INSTALL_CMD,
      };
    case 'no-openfoam':
    case 'missing-tools':
      return {
        html: `<span class="-warn">OpenFOAM is missing from ${escapeHtml(env.distro || 'the distribution')}.</span>\n`
          + 'It can be installed from here: about 1 GB of download, no administrator rights needed.'
          + (env.missing?.length ? `\nMissing tools: ${escapeHtml(env.missing.join(', '))}` : ''),
        install: true,
      };
    default:
      return { html: escapeHtml(env?.reason || 'CFD backend unavailable.') };
  }
}

/** Sonde le backend et met la popup à jour. */
async function refreshBemCfdSetup(root, refresh = false) {
  const statusEl = root.querySelector('#bem-cfd-setup-status');
  const cmdRow = root.querySelector('#bem-cfd-setup-cmd-row');
  const installBtn = root.querySelector('#bem-cfd-setup-install');
  if (statusEl) statusEl.textContent = 'Checking…';
  cmdRow?.classList.add('-hidden');
  installBtn?.classList.add('-hidden');

  bemCfdEnv = await window.electronAPI.foamCheckAvailability({ refresh });
  const remedy = bemCfdRemedy(bemCfdEnv);
  if (statusEl) statusEl.innerHTML = remedy.html;
  if (remedy.command) {
    root.querySelector('#bem-cfd-setup-cmd').value = remedy.command;
    cmdRow?.classList.remove('-hidden');
  }
  installBtn?.classList.toggle('-hidden', !remedy.install);
  return bemCfdEnv;
}

function openBemCfdSetup(root) {
  root.querySelector('#bem-popup-cfd-setup')?.classList.remove('-hidden');
  root.querySelector('#bem-cfd-setup-log')?.classList.add('-hidden');
  refreshBemCfdSetup(root, true);
}

/** Rend lisible le flux KEY=VALUE du script d'installation. */
function bemCfdInstallLine(line) {
  const stage = /^FOAM_STAGE=(.*)$/.exec(line);
  if (stage) {
    return {
      prepare: 'Preparing the distribution…',
      repository: 'Adding the OpenFOAM repository…',
      index: 'Refreshing the package index…',
      download: 'Downloading and installing (~1 GB)…',
      verify: 'Checking the installed tools…',
    }[stage[1]] || stage[1];
  }
  const progress = /^FOAM_PROGRESS=(.*)$/.exec(line);
  if (progress) return `  ${progress[1]}`;
  const distro = /^FOAM_DISTRO=(.*)$/.exec(line);
  if (distro) return `Target: ${distro[1]}`;
  const error = /^FOAM_ERROR=(.*)$/.exec(line);
  if (error) return `Failed: ${error[1]}`;
  return null;
}

/** Fréquence choisie dans la toolbar pour la coloration des nappes. */
function selectedBemFieldFreq(root) {
  const value = parseFloat(root.querySelector('#bem-field-freq')?.value);
  return Number.isFinite(value) ? value : null;
}

/** Visibilité du sélecteur de fréquence, du bouton « Start field » et de la légende. */
function updateBemFieldControls(root) {
  const active = activeBemFields().length;
  const fieldBtn = root.querySelector('#bem-btn-start-field');
  if (fieldBtn) {
    fieldBtn.classList.toggle('-hidden', !bemTreeItems.some(it => it.kind === 'Field'));
    fieldBtn.disabled = !bemWorkersHaveSolution || !active;
  }

  const wrap = root.querySelector('#bem-field-freq-wrap');
  const select = root.querySelector('#bem-field-freq');
  if (wrap && select) {
    // Les fréquences viennent de la simulation, pas des résultats de nappe : un
    // field ajouté après coup doit pouvoir choisir la sienne avant d'être calculé.
    const freqs = bemResults?.freqs || [];
    wrap.classList.toggle('-hidden', !freqs.length || !active);
    if (!freqs.length) {
      select.innerHTML = '';
    } else {
      const previous = select.value;
      select.innerHTML = freqs.map(f => `<option value="${f}">${formatFrequency(f, true)}</option>`).join('');
      if (freqs.some(f => String(f) === previous)) select.value = previous;
    }
  }
  // Le bouton CFD n'a de sens qu'avec une nappe couplée et une fréquence à viser.
  const cfdReady = (bemResults?.freqs || []).length
    && activeBemFields().some(it => it.cfd === true && bemFieldNeedsVelocity(it));
  root.querySelector('#bem-btn-start-cfd')?.classList.toggle('-hidden', !cfdReady);
  updateBemFieldLegend(root);
}

/** Recolore et redéforme une nappe depuis les résultats de la fréquence sélectionnée. */
function paintBemField(root, fieldId) {
  const item = bemTreeItems.find(it => it.id === fieldId);
  if (item) renderBemField(root, item);
}

/** Sature la rampe REW : sur le fond noir du viewer, les teintes brutes paraissent délavées. */
function vividColor([r, g, b]) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  if (hi === lo) return [r, g, b];
  const gain = 255 / hi;
  return [r, g, b].map(c => Math.round(clamp((lo + (c - lo) * 1.35) * gain, 0, 255)));
}

function paintBemFields(root) {
  bemTreeItems.filter(it => it.kind === 'Field').forEach(it => paintBemField(root, it.id));
  updateBemFieldLegend(root);
}

/**
 * Échelle de couleurs affichée à droite de la vue 3D. Elle suit le premier
 * field affiché ayant des résultats : c'est sa dynamique et son maximum qui
 * fixent la correspondance couleur ↔ dB SPL.
 */
function updateBemFieldLegend(root) {
  const canvas = root.querySelector('#bem-field-legend');
  if (!canvas) return;
  const hide = () => canvas.classList.add('-hidden');

  const item = activeBemFields().find(it => bemFieldResults.has(it.id));
  const freq = selectedBemFieldFreq(root);
  const entry = item ? bemFieldResults.get(item.id).find(e => e.f === freq) : null;
  if (!entry) { hide(); updateBemFlowReadout(root, null, null, null); return; }
  const spl = entry.mag.map(m => pressureToSpl(m));
  const max = spl.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);
  if (!Number.isFinite(max)) { hide(); updateBemFlowReadout(root, null, null, null); return; }
  canvas.classList.remove('-hidden');

  const drive = bemDriveScaleAt(root, freq);
  let speedScale = (drive ? drive.vCone_ms : 1) * Math.SQRT2;
  let velEntry = entry;
  const merged = mergeBemFieldCfd(item, entry, speedScale, freq);
  if (merged) { velEntry = merged.entry; speedScale = merged.scale; }
  const speeds = bemFieldSpeeds(velEntry, speedScale);
  const velocity = bemFieldNeedsVelocity(item);
  updateBemFlowReadout(root, velocity ? item : null, speeds, drive, freq);

  const dbRange = Math.max(1, Number(item.dbRange_db) || BEM_FIELD_DB_RANGE);
  const turbulence = item.quantity === 'turbulence' && !!merged;
  const showVelocity = velocity && !!speeds;
  const vMax = turbulence ? bemTurbulenceScale(merged.cfd, item)
    : showVelocity ? (Number(item.vMax_ms) > 0 ? Number(item.vMax_ms) : bemPercentileScale(speeds.peak))
    : 0;
  const phase = item.quantity === 'phase';
  const logScale = showVelocity && item.velocityScale === 'log';
  const dpr = window.devicePixelRatio || 1;
  const w = 56, h = 320, headerH = 30, bands = 12;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(17, 24, 39, 0.85)';
  ctx.fillRect(0, 0, w, headerH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.fillText(showVelocity ? (turbulence ? 'm/s turb' : 'm/s pk') : (phase ? 'Phase °' : 'dB rel'), w / 2, 9);
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(logScale ? `${formatFrequency(entry.f, true)} log` : formatFrequency(entry.f, true), w / 2, 21);

  const bandH = (h - headerH) / bands;
  ctx.font = '600 10px ui-monospace, monospace';
  for (let i = 0; i < bands; i++) {
    const t = (i + 0.5) / bands;
    const value = showVelocity ? velocityAtRamp(1 - t, vMax, logScale)
      : (phase ? 180 - t * 360 : -t * dbRange);
    const [r, g, b] = showVelocity ? velocityColor(value, vMax, logScale)
      : (phase ? phaseColor(value) : vividColor(rewColor(value, dbRange)));
    const y = headerH + i * bandH;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, w, bandH + 0.5);
    ctx.fillStyle = (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111827' : '#f9fafb';
    ctx.fillText(showVelocity ? formatVelocityTick(value) : value.toFixed(0), w / 2, y + bandH / 2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// Au-delà de ~17 m/s de crête (≈ 5 % de la célérité) un event se met à souffler :
// le jet décolle des parois et le bruit d'écoulement devient audible. C'est le
// critère usuel de dimensionnement, d'où le code couleur.
const BEM_PORT_NOISE_MS = 17;
const NU_AIR = 1.5e-5;   // viscosité cinématique de l'air, m²/s

/**
 * Régime d'écoulement dans un event, déduit de la vitesse de crête et du
 * diamètre hydraulique. Le BEM est LINÉAIRE : il donne le champ de vitesse
 * exact tant que l'écoulement reste attaché, mais il ne peut pas prédire lui
 * même le décollement. Ce sont ces deux nombres sans dimension qui le disent,
 * et ce sont eux qu'utilise la littérature sur le bruit d'event.
 *
 * - Re = u·D/ν : laminaire sous ~2000, turbulent au-delà de ~4000.
 * - KC = u·T/D = u/(f·D) (Keulegan–Carpenter) : c'est LE paramètre d'un
 *   écoulement ALTERNATIF. Sous ~1 l'air fait des allers-retours sans se
 *   détacher ; au-delà de ~4 il se forme un tourbillon à chaque demi-période
 *   qui est éjecté à la suivante — c'est exactement le mécanisme du souffle.
 */
function portFlowRegime(peak_ms, freq, diameter_mm) {
  const D = (Number(diameter_mm) || 0) / 1000;
  if (!(D > 0) || !(freq > 0) || !(peak_ms > 0)) return null;
  const re = peak_ms * D / NU_AIR;
  const kc = peak_ms / (freq * D);
  const verdict = kc > 4 ? 'vortex shedding each half-cycle'
    : kc > 1 ? 'flow starts to separate at the port ends'
    : re > 4000 ? 'turbulent but attached'
    : 'attached, laminar';
  const severity = kc > 4 ? 2 : (kc > 1 || re > 4000) ? 1 : 0;
  return { re, kc, verdict, severity };
}

/**
 * Bandeau « écoulement » sous la vue 3D : vitesse d'event, niveau d'excitation
 * qui l'a produite, et nombre de Mach. Sans lui la carte de couleurs ne dit pas
 * si l'event est bon ou s'il siffle.
 *
 * Le critère de souffle porte sur la vitesse DÉBITANTE (débit / section), la
 * seule grandeur robuste : le maximum local du plan tombe sur la singularité
 * d'arête de la bouche, où la vitesse diverge, et grimpe donc indéfiniment à
 * mesure qu'on raffine la nappe. Il n'est gardé qu'à titre indicatif.
 */
function updateBemFlowReadout(root, item, speeds, drive, freq) {
  const el = root.querySelector('#bem-flow-readout');
  if (!el) return;
  if (!item) { el.classList.add('-hidden'); return; }
  el.classList.remove('-hidden');
  if (!speeds) {
    el.innerHTML = '<span style="color:#fbbf24;">No air-flow data for this field '
      + '— press <b>Start field</b> (or re-run <b>Start Sim</b>) to compute particle velocity.</span>';
    return;
  }

  const duct = detectBemVentDuct();
  const mouths = duct?.groups ? bemVentMouthVelocities(root, freq, duct.groups) : null;
  // C'est la bouche la plus rapide qui siffle : sur un event évasé, l'entrée
  // étroite peut dépasser la sortie sans que le jet extérieur soit bruyant,
  // et l'inverse est vrai sur un event convergent.
  const port = mouths ? Math.max(mouths.inlet?.v || 0, mouths.outlet?.v || 0) : null;
  const peak = port || speeds.max;
  const mach = peak / 344;
  const state = peak > BEM_PORT_NOISE_MS ? 'audible port noise'
    : peak > BEM_PORT_NOISE_MS * 0.7 ? 'borderline' : 'clean';
  const color = peak > BEM_PORT_NOISE_MS ? '#f87171'
    : peak > BEM_PORT_NOISE_MS * 0.7 ? '#fbbf24' : '#34d399';
  const mouthText = mouths && mouths.inlet && mouths.outlet
    ? ` (in ${mouths.inlet.v.toFixed(1)} / out ${mouths.outlet.v.toFixed(1)})` : '';

  // Diamètre équivalent de la bouche retenue : le BEM connaît déjà son aire,
  // inutile de la faire saisir — et sur un event évasé une valeur unique
  // saisie à la main n'aurait de toute façon aucun sens.
  const fastest = mouths && (mouths.outlet?.v || 0) >= (mouths.inlet?.v || 0) ? mouths.outlet : mouths?.inlet;
  const dEq_mm = fastest ? 2000 * Math.sqrt(fastest.area / Math.PI) : 0;
  const regime = portFlowRegime(peak, freq, dEq_mm);
  const regimeColor = ['#34d399', '#fbbf24', '#f87171'][regime?.severity ?? 0];
  // Re et KC sont analytiques et donc disponibles à TOUTES les fréquences,
  // alors que la CFD n'existe qu'à celles qu'on a payées : sans cette mention
  // le verdict se lit à tort comme un résultat de calcul Navier-Stokes.
  const cfdHere = bemFieldCfd.get(item.id)?.freq === freq;
  const regimeText = regime
    ? ` · <span style="color:${regimeColor};">${regime.verdict}</span>`
      + ` <span style="opacity:.6;">(${cfdHere ? 'CFD' : 'estimate'})</span>`
    : '';

  el.innerHTML = `<b style="color:${color};">${peak.toFixed(1)} m/s ${port ? 'port' : 'peak'}</b>${mouthText}`
    + ` · <span style="color:${color};">${state}</span>`
    + regimeText
    + (item.cfd && !cfdHere
      ? ` · <span style="color:#fbbf24;">BEM-only here — press <b>Start CFD</b></span>` : '');

  // Le reste est du contexte, pas une lecture : il encombrait le bandeau.
  el.title = [
    `Port ${peak.toFixed(2)} m/s peak · ${(peak / Math.SQRT2).toFixed(2)} m/s rms · Mach ${mach.toFixed(3)}`,
    `Chuffing limit ${BEM_PORT_NOISE_MS} m/s peak`,
    regime ? `Re ${regime.re.toExponential(1)} · KC ${regime.kc.toFixed(1)} · equivalent mouth Ø ${dEq_mm.toFixed(0)} mm` : '',
    `Local max ${speeds.max.toFixed(1)} m/s — edge singularity, grid-dependent, not a chuffing criterion`,
    drive
      ? `Drive ${drive.vRms.toFixed(2)} V (${drive.watts.toFixed(1)} W into ${drive.zNom} Ω — ${drive.driverName}) · cone ${(drive.vCone_ms * 1000).toFixed(1)} mm/s rms`
      : 'Unit diaphragm velocity (no driver assigned)',
    drive && drive.filterDb ? `Filters: ${drive.filterDb >= 0 ? '+' : ''}${drive.filterDb.toFixed(1)} dB at this frequency` : '',
    speeds.masked ? `${speeds.masked} points sit on a wall and are excluded (grey)` : '',
    'Re and KC are analytic and exist at every frequency; OpenFOAM only where you ran it.',
  ].filter(Boolean).join('\n');
}

function assignBemSurface(targetItem, meshSurface, kind) {  let record = null;
  bemTreeItems.forEach(item => {
    const index = item.surfaces.findIndex(surface => surface.meshSurfaceId === meshSurface.id);
    if (index < 0) return;
    const [existing] = item.surfaces.splice(index, 1);
    if (!record) record = existing;
  });
  targetItem.surfaces.push(record || {
    id: `srf-${++bemTreeSeq}`,
    name: meshSurface.name,
    meshSurfaceName: meshSurface.name,
    visible: false,
    kind,
    meshSurfaceId: meshSurface.id,
    role: 'boundary',
    velocity: 1,
  });
}

function remapBemTreeSurfaces(meshSurfaces) {
  const byId = new Map(meshSurfaces.map(surface => [surface.id, surface]));
  const byName = new Map();
  meshSurfaces.forEach(surface => {
    const key = `${surface.kind}:${surface.name.trim().toLowerCase()}`;
    if (!byName.has(key)) byName.set(key, surface);
    else byName.set(key, null);
  });
  let remapped = 0;
  let removed = 0;
  bemTreeItems.forEach(item => {
    item.surfaces = item.surfaces.filter(surface => {
      const oldMeshName = surface.meshSurfaceName || surface.name;
      const idMatch = byId.get(surface.meshSurfaceId);
      const nameMatch = byName.get(`${surface.kind}:${oldMeshName.trim().toLowerCase()}`);
      const match = surface.kind === 'physical' ? (nameMatch || idMatch) : (idMatch || nameMatch);
      if (!match) {
        removed++;
        return false;
      }
      if (match.id !== surface.meshSurfaceId) remapped++;
      if (surface.name === oldMeshName) surface.name = match.name;
      surface.meshSurfaceId = match.id;
      surface.meshSurfaceName = match.name;
      surface.kind = match.kind;
      return true;
    });
  });
  return { remapped, removed };
}

function restoreBemTreeViewerState(root) {
  const viewer = root._bemMeshViewer;
  bemTreeItems.forEach(item => {
    if (item.kind === 'Field') { syncBemField(root, item); return; }
    (item.components || []).forEach(component => syncBemComponent(root, item, component));
    item.surfaces.forEach(surface => {
      viewer?.setSurfaceVisible(surface.meshSurfaceId, surface.visible && item.visible !== false);
    });
  });
  applyBemSurfaceColors(root);
}

/** Détache une surface de son nœud : elle redevient libre et visible dans la vue 3D. */
function removeBemSurface(root, item, surfaceId) {
  const index = item.surfaces.findIndex(s => s.id === surfaceId);
  if (index < 0) return false;
  const [surface] = item.surfaces.splice(index, 1);
  if (surface.meshSurfaceId) {
    root._bemMeshViewer?.setSurfaceColor(surface.meshSurfaceId, null);
    root._bemMeshViewer?.setSurfaceVisible(surface.meshSurfaceId, true);
  }
  return true;
}

function moveBemTreeSurface(sourceNodeId, surfaceId, targetNodeId) {
  if (!sourceNodeId || !surfaceId || sourceNodeId === targetNodeId) return false;
  const source = bemTreeItems.find(item => item.id === sourceNodeId);
  const target = bemTreeItems.find(item => item.id === targetNodeId);
  const index = source?.surfaces.findIndex(surface => surface.id === surfaceId) ?? -1;
  if (!source || !target || index < 0) return false;
  const [surface] = source.surfaces.splice(index, 1);
  if (!target.surfaces.some(existing => existing.meshSurfaceId === surface.meshSurfaceId)) {
    target.surfaces.push(surface);
  }
  target.expanded = true;
  return true;
}

function moveBemTreeNode(sourceNodeId, targetNodeId) {
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return false;
  const sourceIndex = bemTreeItems.findIndex(item => item.id === sourceNodeId);
  const targetIndex = bemTreeItems.findIndex(item => item.id === targetNodeId);
  if (sourceIndex < 0 || targetIndex < 0) return false;
  const [item] = bemTreeItems.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  bemTreeItems.splice(adjustedTargetIndex + 1, 0, item);
  return true;
}

function removeBemTreeItem(root, nodeId) {
  const index = bemTreeItems.findIndex(item => item.id === nodeId);
  if (index < 0) return false;
  const [item] = bemTreeItems.splice(index, 1);
  if (item.kind === 'Field') syncBemField(root, item, true);
  (item.components || []).forEach(component => syncBemComponent(root, item, component, true));
  (item.surfaces || []).forEach(surface => {
    if (!surface.meshSurfaceId) return;
    root._bemMeshViewer?.setSurfaceColor(surface.meshSurfaceId, null);
    root._bemMeshViewer?.setSurfaceVisible(surface.meshSurfaceId, true);
  });
  syncBemTreeCountInputs(root);
  updateBemDriveVisibility(root);
  return true;
}

function syncBemTreeCountInputs(root) {
  const subInput = root.querySelector('#bem-subdomain-count');
  const ifInput = root.querySelector('#bem-interface-count');
  if (subInput) subInput.value = String(bemTreeItems.filter(it => it.kind === 'Subdomain').length);
  if (ifInput) ifInput.value = String(bemTreeItems.filter(it => it.kind === 'Interface').length);
}

function renderBemTree(root) {
  const container = root.querySelector('#bem-tree-root');
  updateBemDriveVisibility(root);
  updateBemFieldControls(root);
  if (!container) return;
  if (!bemTreeItems.length) {
    container.innerHTML = '';
    return;
  }
  // Le dépôt reste en tête, avant les sous-domaines et les interfaces.
  const ordered = bemTreeItems.filter(it => it.kind === 'Repository')
    .concat(bemTreeItems.filter(it => it.kind !== 'Repository'));
  container.innerHTML = ordered.map(renderBemTreeNode).join('');
}

function toggleBemTreeVisibility(root, fieldsOnly) {
  const items = bemTreeItems.filter(item => item.kind !== 'Repository' && (item.kind === 'Field') === fieldsOnly);
  const repositorySurfaceIds = new Set(bemTreeItems
    .filter(item => item.kind === 'Repository')
    .flatMap(item => item.surfaces || [])
    .map(surface => surface.meshSurfaceId));
  const meshSurfaces = fieldsOnly ? [] : (root._bemMeshViewer?.getSurfaces() || []);
  if (!items.length && !meshSurfaces.length) return;

  const allVisible = (fieldsOnly || root._bemAllElementsVisible !== false) && items.every(item => (fieldsOnly ? item.visible !== false : true)
    && (item.components || []).filter(component => component.type !== 'baffle').every(component => component.visible !== false)
    && (item.surfaces || []).every(surface => surface.visible !== false));
  const visible = !allVisible;

  if (!fieldsOnly) {
    root._bemAllElementsVisible = visible;
    root._bemMeshViewer?.setAllSurfacesVisibleExcept(visible, [...repositorySurfaceIds]);
  }

  items.forEach(item => {
    if (item.kind === 'Field') {
      item.visible = visible;
      syncBemField(root, item);
      return;
    }
    if (visible) item.visible = true;
    (item.components || []).filter(component => component.type !== 'baffle').forEach(component => {
      component.visible = visible;
      syncBemComponent(root, item, component);
    });
    (item.surfaces || []).forEach(surface => {
      surface.visible = visible;
    });
  });
  renderBemTree(root);
}

function normalizeBemHotkeyEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  const key = event.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

function initializeBemHotkeys(root) {
  const state = { settings: {} };
  const load = async () => {
    state.settings = (await window.electronAPI.getSettings()).hotkeys || {};
  };
  const handler = (event) => {
    if (root.offsetParent === null) return;
    const keyCombo = normalizeBemHotkeyEvent(event);
    const elementsKey = state.settings.bemToggleElements?.toLowerCase();
    const fieldsKey = state.settings.bemToggleFields?.toLowerCase();
    if (!keyCombo || (keyCombo !== elementsKey && keyCombo !== fieldsKey)) return;
    event.preventDefault();
    toggleBemTreeVisibility(root, keyCombo === fieldsKey);
  };

  root._bemHotkeyCleanup?.();
  document.addEventListener('keydown', handler);
  const settingsListener = () => load().catch(error => console.error('[BEM Solver] failed to reload hotkeys', error));
  window.panelEvents?.addEventListener('settings-updated', settingsListener);
  root._bemHotkeyCleanup = () => {
    document.removeEventListener('keydown', handler);
    window.panelEvents?.removeEventListener('settings-updated', settingsListener);
  };
  load().catch(error => console.error('[BEM Solver] failed to load hotkeys', error));
}

/** La tension de commande n'a de sens qu'avec un diaphragme pour la porter. */
function updateBemDriveVisibility(root) {
  const wrap = root.querySelector('#bem-drive-vrms-wrap');
  if (!wrap) return;
  const hasDiaphragm = bemTreeItems.some(it => (it.components || []).some(c => c.type === 'diaphragm'));
  wrap.classList.toggle('-hidden', !hasDiaphragm);
}

function bemDriveVrms(root) {
  const value = parseFloat(root.querySelector('#bem-drive-vrms')?.value);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DRIVE_VRMS;
}

function formatDiaphragmMeshStats(stats) {
  if (!stats) return 'Not meshed yet — apply to generate.';
  if (stats.error) return stats.error;
  const snapped = stats.snappedNodes ? ` · ${stats.snappedNodes} rim nodes snapped` : '';
  const cap = stats.capTriangleCount ? ` · ${stats.capTriangleCount} fixed cap triangles` : '';
  return `${stats.triangleCount} triangles · ${stats.nodeCount} nodes · h≈${stats.targetSize_mm.toFixed(2)} mm `
    + `(${stats.minEdge_mm.toFixed(2)}–${stats.maxEdge_mm.toFixed(2)} mm)${snapped}${cap}`;
}

function renderBemTreeNode(item) {
  if (item.kind === 'Field') {
    const stats = bemFieldGeometries.get(item.id)?.stats;
    return `
    <div class="bem-tree-node">
      <div class="bem-tree-row">
        <span class="bem-tree-toggle" style="visibility:hidden;">&#9656;</span>
        <span class="bem-tree-label" draggable="false" data-props-target="node:${item.id}" style="color:#38bdf8;"
              title="${stats ? `${stats.pointCount} observation points` : ''}">${escapeHtml(item.name)}<em style="opacity:.6;font-style:normal;font-size:10px;"> [${item.displayMode === 'directivity' ? 'directivity' : item.fieldType}]</em></span>
        <input type="checkbox" class="bem-tree-vis" data-node-vis="${item.id}" title="Show the field and compute it on Start Sim" ${item.visible !== false ? 'checked' : ''}>
      </div>
    </div>`;
  }
  const componentsHtml = (item.components || []).map(c => `
        <div class="bem-tree-row">
          <input type="checkbox" class="bem-tree-vis" data-component-vis="${item.id}:${c.id}" ${c.visible !== false ? 'checked' : ''}>
          <span class="bem-tree-label -component" draggable="false" data-props-target="component:${item.id}:${c.id}"
                style="color:${c.type === 'baffle' ? '#94a3b8' : '#fbbf24'};">${escapeHtml(c.name)}<em>[${c.type}]</em></span>
        </div>`).join('');
  const surfacesHtml = item.surfaces.map(s => `
  <div class="bem-tree-row" draggable="true" data-drag-surface="${item.id}:${s.id}">
          <input type="checkbox" class="bem-tree-vis" data-surface-vis="${item.id}:${s.id}" ${s.visible ? 'checked' : ''}>
          <span class="bem-tree-label" draggable="false" data-props-target="surface:${item.id}:${s.id}"
                style="${s.role === 'driven' ? 'color:#f87171;' : ''}">${s.name}${s.kind ? ` <em style="opacity:.6;font-style:normal;font-size:10px;">[${s.kind}]</em>` : ''}</span>
        </div>`).join('');
  // Interface = bleu ; sous-domaine intérieur = rouge, extérieur = blanc ; dépôt = gris.
  const nodeColor = item.kind === 'Repository'
    ? '#9ca3af'
    : (item.kind === 'Interface'
      ? '#60a5fa'
      : (item.domainType === 'interior' ? '#f87171' : '#ffffff'));
  return `
    <div class="bem-tree-node" data-drop-node="${item.id}">
      <div class="bem-tree-row" draggable="true" data-drag-node="${item.id}" data-toggle-node="${item.id}">
        <span class="bem-tree-toggle${item.expanded ? ' -open' : ''}">&#9656;</span>
        <span class="bem-tree-label" draggable="false" data-props-target="node:${item.id}" style="color:${nodeColor};">${item.name}</span>
        <input type="checkbox" class="bem-tree-vis" data-node-vis="${item.id}" title="Show/hide all surfaces" ${item.visible !== false ? 'checked' : ''}>
      </div>
      <div class="bem-tree-children"${item.expanded ? '' : ' style="display:none;"'}>
        ${componentsHtml}${surfacesHtml}
      </div>
    </div>`;
}

const BEM_COLOR_INTERFACE = 0x1e40af; // bleu foncé
const BEM_COLOR_DRIVEN    = 0xdc2626; // rouge
// Dynamique de la coloration des nappes d'observation, sous le max du champ.
const BEM_FIELD_DB_RANGE = 24;

/** Repaints every assigned mesh surface from its BEM role (interface > driven > default grey). */
function applyBemSurfaceColors(root) {
  const viewer = root._bemMeshViewer;
  if (!viewer) return;
  bemTreeItems.forEach(item => {
    item.surfaces.forEach(s => {
      if (!s.meshSurfaceId) return;
      const color = item.kind === 'Interface'
        ? BEM_COLOR_INTERFACE
        : (s.role === 'driven' ? BEM_COLOR_DRIVEN : null);
      viewer.setSurfaceColor(s.meshSurfaceId, color);
    });
  });
}

/** Properties dialog opened by double-clicking a tree item. */
function openBemPropsPopup(root, target) {
  const [type, nodeId, childId] = target.split(':');
  const item = bemTreeItems.find(it => it.id === nodeId);
  if (!item) return;
  const surface = type === 'surface' ? item.surfaces.find(s => s.id === childId) : null;
  if (type === 'surface' && !surface) return;
  const component = type === 'component' ? findBemComponent(item, childId) : null;
  if (type === 'component' && !component) return;

  const overlay = root.querySelector('#bem-popup-props');
  const title = root.querySelector('#bem-props-title');
  const body = root.querySelector('#bem-props-body');
  if (!overlay || !body) return;

  // Diaphragme et field partagent des identifiants de champ (les offsets, par
  // exemple) : laisser le HTML de la fois précédente ferait lire par
  // `root.querySelector` les valeurs de l'AUTRE objet.
  ['bem-props-position-body', 'bem-props-shape-body', 'bem-props-mesh-body',
    'bem-props-field-geometry-body', 'bem-props-field-display-body', 'bem-props-field-flow-body']
    .forEach(id => { const el = root.querySelector(`#${id}`); if (el) el.innerHTML = ''; });

  const nameRow = (value) => `
    <div class="bem-popup-row">
      <label class="dir-label" style="margin:0;">Name</label>
      <input type="text" id="bem-props-name" class="dir-input" style="width:200px;" value="${escapeHtmlAttr(value)}">
    </div>`;
  const axisRow = (id, selected) => `
    <div class="bem-popup-row">
      <label class="dir-label" style="margin:0;">Orientation axis</label>
      <select id="${id}" class="dir-input" style="width:200px;">
        ${BEM_AXES.map(a => `<option value="${a.value}"${a.value === (selected || '+z') ? ' selected' : ''}>${a.label}</option>`).join('')}
      </select>
    </div>`;
  const numberRow = (label, id, value, step = '1') => `
    <div class="bem-popup-row">
      <label class="dir-label" style="margin:0;">${label}</label>
      <input type="number" id="${id}" class="dir-input" value="${value}" step="${step}" style="width:200px;">
    </div>`;

  if (type === 'component' && component.type === 'baffle') {
    title.textContent = 'Infinite Baffle Properties';
    body.innerHTML = `${nameRow(component.name)}
      ${axisRow('bem-props-axis', component.axis)}
      ${numberRow('Offset (mm)', 'bem-props-offset', Number(component.offset_mm) || 0, '1')}
      <div style="font-size:11px;color:var(--dir-muted);">
        The baffle plane is normal to the selected axis and passes through the
        origin, shifted by the offset along that axis. Observation stays on +Z,
        so a non-Z axis only makes sense for a model rotated accordingly.
      </div>`;
  } else if (type === 'component') {
    title.textContent = 'Diaphragm Properties';
    const stats = bemDiaphragmMeshes.get(component.id)?.stats;
    const side = component.side === 'back' ? 'back' : 'front';
    const diaphragmOptions = bemTreeItems.flatMap(item => (item.components || []))
      .filter(candidate => candidate.type === 'diaphragm' && candidate.id !== component.id)
      .map(candidate => `<option value="${candidate.id}">${escapeHtml(candidate.name)}</option>`)
      .join('');

    // Corps réduit : nom, trois boutons qui ouvrent chacun une popup dédiée
    // (Position / Shape / Mesh), et le driver — laissé ici comme demandé.
    body.innerHTML = `${nameRow(component.name)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Geometry</label>
        <span style="display:flex;gap:6px;">
          <button type="button" id="bem-props-open-position" class="bem-tool-btn">Position</button>
          <button type="button" id="bem-props-open-shape" class="bem-tool-btn">Shape</button>
          <button type="button" id="bem-props-open-mesh" class="bem-tool-btn">Mesh</button>
        </span>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Copy diaphragm</label>
        <span style="display:flex;gap:6px;">
          <select id="bem-props-copy-source" class="dir-input" style="width:132px;">
            <option value="">Select...</option>${diaphragmOptions}
          </select>
          <button type="button" id="bem-props-copy-diaphragm" class="bem-tool-btn">Copy</button>
        </span>
      </div>
      <div id="bem-props-mesh-stats" style="font-size:11px;color:var(--dir-muted);font-family:ui-monospace,monospace;">${formatDiaphragmMeshStats(stats)}</div>

      <div class="bem-driver-picker">
        <label class="dir-label" style="margin:0 0 6px;">Driver</label>
        <input type="search" id="bem-props-driver-search" class="dir-input" placeholder="Search for a driver...">
        <div id="bem-props-driver-list" class="bem-driver-list -hidden"></div>
        <button type="button" id="bem-props-driver-toggle" class="bem-tool-btn" style="width:100%;margin-top:6px;">[ ${escapeHtml(component.driverName || 'None')} ]</button>
        <div id="bem-props-driver-info" style="font-size:11px;color:var(--dir-muted);font-family:ui-monospace,monospace;margin-top:6px;"></div>
      </div>`;
    initBemDriverPicker(body, component);
    body.querySelector('#bem-props-copy-diaphragm').addEventListener('click', () => {
      const sourceId = body.querySelector('#bem-props-copy-source').value;
      const source = bemTreeItems.flatMap(item => item.components || [])
        .find(candidate => candidate.type === 'diaphragm' && candidate.id === sourceId);
      if (!source) return;
      const { id, type, name, ...parameters } = source;
      Object.assign(component, parameters);
      delete component.geometrySourceId;
      syncBemComponent(root, item, component);
      renderBemTree(root);
      openBemPropsPopup(root, target);
    });

    // Popup "Position" : axe, offset, échelle.
    const positionBody = root.querySelector('#bem-props-position-body');
    positionBody.innerHTML = `${axisRow('bem-props-axis', component.axis)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Offset X / Y / Z (mm)</label>
        <span style="display:flex;gap:6px;">
          <input type="number" id="bem-props-offx" class="dir-input" value="${component.offsetX ?? 0}" step="1" style="width:62px;">
          <input type="number" id="bem-props-offy" class="dir-input" value="${component.offsetY ?? 0}" step="1" style="width:62px;">
          <input type="number" id="bem-props-offz" class="dir-input" value="${component.offsetZ ?? 0}" step="1" style="width:62px;">
        </span>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Scale X / Y / Z</label>
        <span style="display:flex;gap:6px;">
          <input type="number" id="bem-props-sclx" class="dir-input" value="${component.scaleX ?? 1}" step="0.05" min="0.01" style="width:62px;">
          <input type="number" id="bem-props-scly" class="dir-input" value="${component.scaleY ?? 1}" step="0.05" min="0.01" style="width:62px;">
          <input type="number" id="bem-props-sclz" class="dir-input" value="${component.scaleZ ?? 1}" step="0.05" min="0.01" style="width:62px;">
        </span>
      </div>`;
    positionBody.innerHTML += `<div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Rotation X / Y / Z (deg)</label>
        <span style="display:flex;gap:6px;">
          <input type="number" id="bem-props-rotx" class="dir-input" value="${component.rotationX_deg ?? 0}" step="1" style="width:62px;">
          <input type="number" id="bem-props-roty" class="dir-input" value="${component.rotationY_deg ?? 0}" step="1" style="width:62px;">
          <input type="number" id="bem-props-rotz" class="dir-input" value="${component.rotationZ_deg ?? 0}" step="1" style="width:62px;">
        </span>
      </div>`;

    // Popup "Shape" : côté (front/back) + les dimensions propres à ce côté.
    const shapeBody = root.querySelector('#bem-props-shape-body');
    shapeBody.innerHTML = `
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Side</label>
        <select id="bem-props-side" class="dir-input" style="width:200px;">
          <option value="front"${side === 'front' ? ' selected' : ''}>Front (cone + dust cap dome)</option>
          <option value="back"${side === 'back' ? ' selected' : ''}>Back (cone, rear radiation)</option>
        </select>
      </div>
      <div id="bem-props-shape-front">
        ${numberRow('Outer diameter dD (mm)', 'bem-props-dD', component.dD ?? 100, '1')}
        ${numberRow('Inner diameter dD1 (mm)', 'bem-props-dD1', component.dD1 ?? 50, '1')}
        ${numberRow('Cone depth tD1 (mm)', 'bem-props-tD1', component.tD1 ?? 50, '1')}
        ${numberRow('Dome height hD1 (mm)', 'bem-props-hD1', component.hD1 ?? 30, '1')}
        <div style="font-size:11px;color:var(--dir-muted);">A positive hD1 creates a convex dome, a negative value a concave dome.</div>
      </div>
      <div id="bem-props-shape-back">
        ${numberRow('Outer diameter dD (mm)', 'bem-props-dD-back', component.dD ?? 100, '1')}
        ${numberRow('Voice coil diameter dVC (mm)', 'bem-props-dVC', component.dVC ?? 50, '1')}
        ${numberRow('Cone depth hD2 (mm)', 'bem-props-hD2', component.hD2 ?? 20, '1')}
        <div style="font-size:11px;color:var(--dir-muted);">
          Same cone as the front, from dD down to dVC over a depth hD2, but the
          center disc (Ø dVC) stays a fixed boundary instead of a driven dome —
          only the cone annulus is driven, and it radiates into the rear
          subdomain it sits in.
        </div>
      </div>`;
    const sideSelect = shapeBody.querySelector('#bem-props-side');
    const updateShapeVisibility = () => {
      const isBack = sideSelect.value === 'back';
      shapeBody.querySelector('#bem-props-shape-front').style.display = isBack ? 'none' : '';
      shapeBody.querySelector('#bem-props-shape-back').style.display = isBack ? '' : 'none';
    };
    sideSelect.addEventListener('change', updateShapeVisibility);
    updateShapeVisibility();

    // Popup "Mesh" : maillage de Delaunay partagé par les deux côtés.
    const meshBody = root.querySelector('#bem-props-mesh-body');
    meshBody.innerHTML = `${numberRow('Element size (mm, 0 = auto)', 'bem-props-mesh-size', component.meshSize_mm ?? 0, '0.5')}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Bifurcation</label>
        <input type="checkbox" id="bem-props-mesh-bifurcation" ${component.meshBifurcation !== false ? 'checked' : ''}>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Conform to loaded mesh</label>
        <input type="checkbox" id="bem-props-mesh-conform" ${component.meshConform !== false ? 'checked' : ''}>
      </div>
      <div style="font-size:11px;color:var(--dir-muted);">
        Bifurcation doubles the number of sectors as the radius grows, so
        elements stay the size of the surrounding mesh from apex to rim. The
        rim is snapped onto the loaded mesh vertices so the solver welds the
        diaphragm to the surface carrying it, and drives it as the source.
      </div>`;

    body.querySelector('#bem-props-open-position').addEventListener('click', () => {
      root.querySelector('#bem-popup-diaphragm-position').classList.remove('-hidden');
    });
    body.querySelector('#bem-props-open-shape').addEventListener('click', () => {
      root.querySelector('#bem-popup-diaphragm-shape').classList.remove('-hidden');
    });
    body.querySelector('#bem-props-open-mesh').addEventListener('click', () => {
      root.querySelector('#bem-popup-diaphragm-mesh').classList.remove('-hidden');
    });
  } else if (type === 'node' && item.kind === 'Subdomain') {
    title.textContent = 'Subdomain Properties';
    body.innerHTML = `${nameRow(item.name)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Domain type</label>
        <select id="bem-props-domain-type" class="dir-input" style="width:200px;">
          <option value="interior"${item.domainType !== 'exterior' ? ' selected' : ''}>Interior</option>
          <option value="exterior"${item.domainType === 'exterior' ? ' selected' : ''}>Exterior</option>
        </select>
      </div>
      <div style="font-size:11px;color:var(--dir-muted);">
        Right-click the subdomain in the tree to add an infinite baffle or a diaphragm.
      </div>`;
  } else if (type === 'node' && item.kind === 'Field') {
    title.textContent = 'Field Properties';
    const isBalloon = item.fieldType === 'balloon';

    // Corps réduit : ce qui change TOUT (type de nappe, grandeur affichée) plus
    // trois boutons vers des popups dédiées, comme pour le diaphragme.
    body.innerHTML = `${nameRow(item.name)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Shell</label>
        <select id="bem-props-field-type" class="dir-input" style="width:200px;">
          <option value="plane"${isBalloon ? '' : ' selected'}>Plane</option>
          <option value="balloon"${isBalloon ? ' selected' : ''}>Balloon (sphere)</option>
        </select>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Quantity</label>
        <select id="bem-props-field-quantity" class="dir-input" style="width:200px;">
          <option value="level"${bemFieldNeedsVelocity(item) || item.quantity === 'phase' ? '' : ' selected'}>Level (dB)</option>
          <option value="phase"${item.quantity === 'phase' ? ' selected' : ''}>Phase (°)</option>
          <option value="velocity"${item.quantity === 'velocity' ? ' selected' : ''}>Air speed (m/s) — BEM, or BEM + CFD</option>
          <option value="turbulence"${item.quantity === 'turbulence' ? ' selected' : ''}>Turbulence (m/s) — CFD, port only</option>
        </select>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Setup</label>
        <span style="display:flex;gap:6px;">
          <button type="button" id="bem-props-open-field-geometry" class="bem-tool-btn">Position</button>
          <button type="button" id="bem-props-open-field-display" class="bem-tool-btn">Display</button>
          <button type="button" id="bem-props-open-field-flow" class="bem-tool-btn">Air flow</button>
        </span>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Show field mesh</label>
        <input type="checkbox" id="bem-props-field-wireframe" ${item.showWireframe === true ? 'checked' : ''}>
      </div>
      <div id="bem-props-field-stats" style="font-size:11px;color:var(--dir-muted);font-family:ui-monospace,monospace;"></div>
      <div style="font-size:11px;color:var(--dir-muted);">
        Every point costs one field evaluation per frequency — keep the sampling
        coarse first, then refine once the plane is where you want it.
      </div>`;

    const geometryBody = root.querySelector('#bem-props-field-geometry-body');
    geometryBody.innerHTML = `${axisRow('bem-props-axis', item.axis)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Offset X / Y / Z (mm)</label>
        <span style="display:flex;gap:6px;">
          <input type="number" id="bem-props-offx" class="dir-input" value="${item.offsetX_mm ?? 0}" step="10" style="width:62px;">
          <input type="number" id="bem-props-offy" class="dir-input" value="${item.offsetY_mm ?? 0}" step="10" style="width:62px;">
          <input type="number" id="bem-props-offz" class="dir-input" value="${item.offsetZ_mm ?? 0}" step="10" style="width:62px;">
        </span>
      </div>
      <div id="bem-props-field-plane" style="display:${isBalloon ? 'none' : ''};">
        <div class="bem-popup-section">Plane</div>
        ${numberRow('Width (mm)', 'bem-props-field-width', item.width_mm ?? 2000, '10')}
        ${numberRow('Height (mm)', 'bem-props-field-height', item.height_mm ?? 2000, '10')}
        ${numberRow('Delta (mm)', 'bem-props-field-delta', item.delta_mm ?? 100, '5')}
      </div>
      <div id="bem-props-field-balloon" style="display:${isBalloon ? '' : 'none'};">
        <div class="bem-popup-section">Balloon</div>
        ${numberRow('Radius (mm)', 'bem-props-field-radius', item.radius_mm ?? 1000, '10')}
        ${numberRow('Delta theta (°)', 'bem-props-field-dtheta', item.deltaTheta_deg ?? 10, '1')}
        ${numberRow('Delta phi (°)', 'bem-props-field-dphi', item.deltaPhi_deg ?? 10, '1')}
      </div>
      <div style="font-size:11px;color:var(--dir-muted);">
        The axis is the plane normal, or the balloon pole.
      </div>`;

    const displayBody = root.querySelector('#bem-props-field-display-body');
    displayBody.innerHTML = `
      <div class="bem-popup-row" id="bem-props-field-display-row" style="display:${isBalloon ? '' : 'none'};">
        <label class="dir-label" style="margin:0;">Display</label>
        <select id="bem-props-field-display" class="dir-input" style="width:200px;">
          <option value="shell"${item.displayMode === 'directivity' ? '' : ' selected'}>Shell (fixed radius)</option>
          <option value="directivity"${item.displayMode === 'directivity' ? ' selected' : ''}>Directivity 3D (radius = level)</option>
        </select>
      </div>
      ${numberRow('Dynamic range (dB)', 'bem-props-field-dbrange', item.dbRange_db ?? BEM_FIELD_DB_RANGE, '1')}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Draw &minus;6 dB contour</label>
        <input type="checkbox" id="bem-props-field-minus6" ${item.showMinus6 !== false ? 'checked' : ''}>
      </div>`;

    const flowBody = root.querySelector('#bem-props-field-flow-body');
    flowBody.innerHTML = `
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;" title="A cabinet and a port are more than a thousand times apart in velocity. On a linear scale, setting the range on the port blacks out the whole cabinet; the log scale shows both, at the cost of a floor three decades below the maximum.">Colour scale</label>
        <select id="bem-props-field-vscale" class="dir-input" style="width:200px;">
          <option value="log"${item.velocityScale === 'linear' ? '' : ' selected'}>Logarithmic (3 decades)</option>
          <option value="linear"${item.velocityScale === 'linear' ? ' selected' : ''}>Linear</option>
        </select>
      </div>
      ${numberRow('Velocity scale (m/s, 0 = auto)', 'bem-props-field-vmax', item.vMax_ms ?? 0, '1')}
      <div id="bem-props-field-overlay-rows">
        <div class="bem-popup-row">
          <label class="dir-label" style="margin:0;">Flow overlay</label>
          <select id="bem-props-field-flow" class="dir-input" style="width:200px;">
            <option value="none"${item.flowOverlay === 'none' ? ' selected' : ''}>None</option>
            <option value="streamlines"${item.flowOverlay !== 'particles' && item.flowOverlay !== 'none' ? ' selected' : ''}>Streamlines + arrows</option>
            <option value="particles"${item.flowOverlay === 'particles' ? ' selected' : ''}>Animated air particles</option>
          </select>
        </div>
        <div class="bem-popup-row">
          <label class="dir-label" style="margin:0;">Iso-velocity lines</label>
          <input type="checkbox" id="bem-props-field-iso" ${item.showIsoLines !== false ? 'checked' : ''}>
        </div>
        <div id="bem-props-field-stream-rows">
          ${numberRow('Streamline spacing (cells)', 'bem-props-field-density', item.streamDensity ?? 3, '1')}
          ${numberRow('Phase (°, blank = peak flow)', 'bem-props-field-phase', item.flowPhaseDeg ?? '', '15')}
        </div>
        <div id="bem-props-field-particle-rows">
          ${numberRow('Particle count', 'bem-props-field-pcount', item.particleCount ?? 1200, '100')}
          ${numberRow('Periods per second', 'bem-props-field-pspeed', item.particleSpeed ?? 1, '0.25')}
        </div>
      </div>
      <div class="bem-popup-section" title="The BEM holds wherever air behaves as a linear acoustic wave. Inside the port it does not: the flow separates, sheds vortices and loses energy to viscosity. Ticking this runs a real unsteady Navier-Stokes calculation in the duct, driven by the flow rate the BEM computed at your voltage and frequency, and overwrites the field map wherever the CFD mesh reaches. Outside the duct the BEM result is kept.">Navier-Stokes coupling (OpenFOAM) &#9432;</div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Solve the port with CFD</label>
        <input type="checkbox" id="bem-props-field-cfd" ${item.cfd === true ? 'checked' : ''}>
      </div>
      <div class="bem-popup-row" id="bem-props-field-vent-row">
        <label class="dir-label" style="margin:0;" title="The duct solved by OpenFOAM. &quot;Auto&quot; picks the only interior subdomain that has no diaphragm and is connected to two interfaces, one of which leads outside.">Vent subdomain</label>
        <select id="bem-props-field-vent" class="dir-input" style="width:200px;">
          ${bemVentOptions()}
        </select>
      </div>
      <div class="bem-popup-row" id="bem-props-field-cfd-rows">
        <label class="dir-label" style="margin:0;" title="Starting preset. Draft: coarse mesh, no boundary layer, a few tens of seconds &mdash; enough to compare two profiles. Normal: fine mesh and three wall layers, several minutes to several hours.">Preset</label>
        <select id="bem-props-field-cfdq" class="dir-input" style="width:200px;">
          <option value="draft"${item.cfdQuality === 'normal' ? '' : ' selected'}>Draft (seconds)</option>
          <option value="normal"${item.cfdQuality === 'normal' ? ' selected' : ''}>Normal (minutes to hours)</option>
        </select>
      </div>
      <div id="bem-props-field-cfdmesh-rows">
        <div class="bem-popup-row">
          <label class="dir-label" style="margin:0;" title="Background cell size, the CFD equivalent of the BEM clmax. Cost scales as the inverse cube: halving it multiplies the cell count by eight, and the time step shrinks on top of that. 0 keeps the preset value.">Base cell (mm, 0 = preset)</label>
          <input type="number" id="bem-props-field-cfdcell" class="dir-input" value="${item.cfdCell_mm ?? 0}" min="0" step="0.5" style="width:200px;">
        </div>
        <div class="bem-popup-row">
          <label class="dir-label" style="margin:0;" title="Extra subdivision levels applied along the port walls, the CFD equivalent of the BEM curvature accuracy. Each level halves the cell size at the wall only.">Wall refinement</label>
          <select id="bem-props-field-cfdwall" class="dir-input" style="width:200px;">
            <option value="0"${(item.cfdWallLevel ?? 0) === 0 ? ' selected' : ''}>Preset</option>
            <option value="1"${item.cfdWallLevel === 1 ? ' selected' : ''}>1 level</option>
            <option value="2"${item.cfdWallLevel === 2 ? ' selected' : ''}>2 levels</option>
            <option value="3"${item.cfdWallLevel === 3 ? ' selected' : ''}>3 levels</option>
          </select>
        </div>
        <div class="bem-popup-row">
          <label class="dir-label" style="margin:0;" title="Number of acoustic periods simulated. The first ones only establish the flow; only the last one is analysed. Two are enough in draft, four for a settled result.">Periods simulated</label>
          <input type="number" id="bem-props-field-cfdper" class="dir-input" value="${item.cfdPeriods ?? 2}" min="1" max="12" step="1" style="width:200px;">
        </div>
        <div id="bem-props-field-cfdcost" style="font-size:11px;color:var(--dir-muted);"></div>
      </div>
      <div id="bem-props-field-what" style="font-size:11px;color:var(--dir-muted);"></div>`;

    const typeSelect = body.querySelector('#bem-props-field-type');
    const updateFieldPreview = () => {
      const balloon = typeSelect.value === 'balloon';
      const quantity = body.querySelector('#bem-props-field-quantity').value;
      const isVelocity = quantity === 'velocity' || quantity === 'turbulence';
      geometryBody.querySelector('#bem-props-field-plane').style.display = balloon ? 'none' : '';
      geometryBody.querySelector('#bem-props-field-balloon').style.display = balloon ? '' : 'none';
      displayBody.querySelector('#bem-props-field-display-row').style.display = balloon ? '' : 'none';
      // Un bouton par grandeur : l'échelle dB ne dit rien d'une carte de vitesse,
      // et l'écoulement n'existe pas sur une carte de niveau ou de phase.
      body.querySelector('#bem-props-open-field-display').style.display = isVelocity ? 'none' : '';
      body.querySelector('#bem-props-open-field-flow').style.display = isVelocity ? '' : 'none';
      // Les surcouches vivent dans la grille (u, v) d'un plan : sur un ballon
      // seules l'échelle de vitesse et la vérification de turbulence subsistent.
      flowBody.querySelector('#bem-props-field-overlay-rows').style.display = balloon ? 'none' : '';
      const mode = flowBody.querySelector('#bem-props-field-flow').value;
      flowBody.querySelector('#bem-props-field-stream-rows').style.display = mode === 'streamlines' ? '' : 'none';
      flowBody.querySelector('#bem-props-field-particle-rows').style.display = mode === 'particles' ? '' : 'none';
      // Une carte de turbulence n'a de contenu que si la CFD tourne.
      const cfdBox = flowBody.querySelector('#bem-props-field-cfd');
      if (quantity === 'turbulence') cfdBox.checked = true;
      cfdBox.disabled = quantity === 'turbulence';
      flowBody.querySelector('#bem-props-field-cfd-rows').style.display = cfdBox.checked ? '' : 'none';
      flowBody.querySelector('#bem-props-field-vent-row').style.display = cfdBox.checked ? '' : 'none';
      flowBody.querySelector('#bem-props-field-cfdmesh-rows').style.display = cfdBox.checked ? '' : 'none';
      if (cfdBox.checked) {
        const form = readBemFieldForm(root, item);
        const cost = estimateBemCfdCost(form);
        flowBody.querySelector('#bem-props-field-cfdcost').textContent = cost
          ? `≈ ${cost.cells.toLocaleString('fr-FR')} cells · ${cost.steps.toLocaleString('fr-FR')} time steps · ~${cost.label}`
          : 'Run the BEM once to size the duct and get an estimate.';
      }

      // Dire noir sur blanc ce que la nappe montrera : c'est la question que
      // pose tout le monde devant une carte moitié BEM moitié CFD.
      const ventName = flowBody.querySelector('#bem-props-field-vent')
        ?.selectedOptions[0]?.textContent.replace(/^Auto — /, '') || 'the vent';
      flowBody.querySelector('#bem-props-field-what').innerHTML = quantity === 'turbulence'
        ? `<b>Colours = turbulence only</b>, inside ${ventName} and nowhere else: the`
          + ' part of the motion that is not the pure sine tone. Everything outside'
          + ' the duct is grey, because the CFD does not reach it.'
        : cfdBox.checked
          ? `<b>Colours = air speed everywhere.</b> BEM outside, replaced by OpenFOAM`
            + ` inside ${ventName}. This is the map to read the real vent velocity.`
          : '<b>Colours = air speed everywhere</b>, from the BEM alone. Valid while the'
            + ' flow stays attached — tick the CFD box to get the real velocity in the port.';

      const stats = buildFieldGeometry(readBemFieldForm(root, item)).stats;
      body.querySelector('#bem-props-field-stats').textContent =
        `${stats.pointCount} observation points · ${stats.gridU} × ${stats.gridV}`;
    };
    [body, geometryBody, displayBody, flowBody].forEach(container => {
      container.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input', updateFieldPreview);
        el.addEventListener('change', updateFieldPreview);
      });
    });
    updateFieldPreview();

    body.querySelector('#bem-props-open-field-geometry').addEventListener('click', () => {
      root.querySelector('#bem-popup-field-geometry').classList.remove('-hidden');
    });
    body.querySelector('#bem-props-open-field-display').addEventListener('click', () => {
      root.querySelector('#bem-popup-field-display').classList.remove('-hidden');
    });
    body.querySelector('#bem-props-open-field-flow').addEventListener('click', () => {
      root.querySelector('#bem-popup-field-flow').classList.remove('-hidden');
    });
  } else if (type === 'node' && item.kind === 'Repository') {
    title.textContent = 'Repository Properties';
    body.innerHTML = `${nameRow(item.name)}
      <div style="font-size:11px;color:var(--dir-muted);">
        Surfaces parked here are kept out of the model: they are not solved and
        no longer reported as unassigned. Drag them onto a subdomain or an
        interface to bring them back.
      </div>`;
  } else if (type === 'node' && item.kind === 'Interface') {
    title.textContent = 'Interface Properties';
    const subdomains = bemTreeItems.filter(it => it.kind === 'Subdomain');
    const options = (selectedId) => ['<option value="">— none —</option>']
      .concat(subdomains.map(sd => `<option value="${sd.id}"${sd.id === selectedId ? ' selected' : ''}>${sd.name}</option>`))
      .join('');
    body.innerHTML = `${nameRow(item.name)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">From subdomain</label>
        <select id="bem-props-from" class="dir-input" style="width:200px;">${options(item.fromId)}</select>
      </div>
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">To subdomain</label>
        <select id="bem-props-to" class="dir-input" style="width:200px;">${options(item.toId)}</select>
      </div>`;
  } else {
    title.textContent = 'Surface Properties';
    const role = surface.role || 'boundary';
    const velocity = Number.isFinite(surface.velocity) ? surface.velocity : 1;
    body.innerHTML = `${nameRow(surface.name)}
      <div class="bem-popup-row">
        <label class="dir-label" style="margin:0;">Role</label>
        <select id="bem-props-role" class="dir-input" style="width:200px;">
          <option value="boundary"${role === 'boundary' ? ' selected' : ''}>Boundary</option>
          <option value="driven"${role === 'driven' ? ' selected' : ''}>Driven</option>
        </select>
      </div>
      <div class="bem-popup-row" id="bem-fixed-drive-row" style="display:${role === 'driven' ? '' : 'none'};">
        <label class="dir-label" style="margin:0;">Velocity (m/s RMS)</label>
        <input type="number" id="bem-props-velocity" class="dir-input" value="${velocity}" min="0" step="0.01" style="width:200px;">
      </div>
      <div style="font-size:11px;color:var(--dir-muted);">
        Driven surfaces always use fixed driving. Attach a driver to the
        subdomain's diaphragm component to couple the SPL response.
      </div>`;

    const roleSelect = body.querySelector('#bem-props-role');
    roleSelect.addEventListener('change', () => {
      body.querySelector('#bem-fixed-drive-row').style.display = roleSelect.value === 'driven' ? '' : 'none';
    });
  }

  const applyBtn = root.querySelector('#bem-props-apply');
  const onApply = () => {
    const name = root.querySelector('#bem-props-name')?.value.trim();
    const record = type === 'surface' ? surface : (type === 'component' ? component : item);
    if (name) record.name = name;
    if (type === 'component') {
      component.axis = root.querySelector('#bem-props-axis').value;
      if (component.type === 'baffle') {
        component.offset_mm = parseFloat(root.querySelector('#bem-props-offset').value) || 0;
      } else {
        const num = (id, fallback) => {
          const v = parseFloat(root.querySelector(id)?.value);
          return Number.isFinite(v) ? v : fallback;
        };
        component.dD = Math.max(0, num('#bem-props-dD', 100));
        component.dD1 = Math.max(0, num('#bem-props-dD1', 50));
        component.tD1 = num('#bem-props-tD1', 50);
        component.hD1 = num('#bem-props-hD1', 30);
        component.side = root.querySelector('#bem-props-side')?.value === 'back' ? 'back' : 'front';
        if (component.side === 'back') component.dD = Math.max(0, num('#bem-props-dD-back', 100));
        component.dVC = Math.max(0, num('#bem-props-dVC', 50));
        component.hD2 = num('#bem-props-hD2', 20);
        component.offsetX = num('#bem-props-offx', 0);
        component.offsetY = num('#bem-props-offy', 0);
        component.offsetZ = num('#bem-props-offz', 0);
        component.scaleX = num('#bem-props-sclx', 1) || 1;
        component.scaleY = num('#bem-props-scly', 1) || 1;
        component.scaleZ = num('#bem-props-sclz', 1) || 1;
        component.rotationX_deg = num('#bem-props-rotx', 0);
        component.rotationY_deg = num('#bem-props-roty', 0);
        component.rotationZ_deg = num('#bem-props-rotz', 0);
        component.meshSize_mm = Math.max(0, num('#bem-props-mesh-size', 0));
        component.meshBifurcation = root.querySelector('#bem-props-mesh-bifurcation').checked;
        component.meshConform = root.querySelector('#bem-props-mesh-conform').checked;
        const picker = root.querySelector('#bem-props-driver-toggle');
        component.driverName = picker?._bemDriver?.name || null;
        component.driverParams = picker?._bemDriver ? { ...picker._bemDriver.params } : null;
      }
      syncBemComponent(root, item, component);
      const meshError = bemDiaphragmMeshes.get(component.id)?.stats?.error;
      if (meshError) setBemStatus(root, `${component.name}: ${meshError}`, true);
    } else if (type === 'node' && item.kind === 'Subdomain') {
      item.domainType = root.querySelector('#bem-props-domain-type').value;
    } else if (type === 'node' && item.kind === 'Field') {
      Object.assign(item, readBemFieldForm(root, item));
      applyBemVentChoice(item.cfdVentId);
      syncBemField(root, item);
    } else if (type === 'node' && item.kind === 'Repository') {
      // Rien d'autre que le nom.
    } else if (type === 'node') {
      item.fromId = root.querySelector('#bem-props-from').value || null;
      item.toId = root.querySelector('#bem-props-to').value || null;
    } else {
      surface.role = root.querySelector('#bem-props-role').value;
      if (surface.role === 'driven') {
        surface.velocity = Math.max(0, parseFloat(root.querySelector('#bem-props-velocity')?.value) || 0);
      }
    }
    overlay.classList.add('-hidden');
    closeDiaphragmSubPopups(root);
    renderBemTree(root);
    applyBemSurfaceColors(root);
  };
  applyBtn.replaceWith(applyBtn.cloneNode(true)); // drop the previous target's handler
  root.querySelector('#bem-props-apply').addEventListener('click', onApply);

  overlay.classList.remove('-hidden');
  root.querySelector('#bem-props-name')?.focus();
}

/** Referme les sous-popups (diaphragme et field) quand la popup de propriétés se ferme. */
function closeDiaphragmSubPopups(root) {
  ['bem-popup-diaphragm-position', 'bem-popup-diaphragm-shape', 'bem-popup-diaphragm-mesh',
    'bem-popup-field-geometry', 'bem-popup-field-display', 'bem-popup-field-flow']
    .forEach(id => root.querySelector(`#${id}`)?.classList.add('-hidden'));
}

// Les champs sont répartis entre la popup principale et ses sous-popups : on
// interroge donc la RACINE du panneau, où tous les identifiants sont uniques.
function readBemFieldForm(scope, item) {
  const num = (id, fallback) => {
    const v = parseFloat(scope.querySelector(id)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const quantity = scope.querySelector('#bem-props-field-quantity')?.value;
  return {
    fieldType: scope.querySelector('#bem-props-field-type')?.value === 'balloon' ? 'balloon' : 'plane',
    displayMode: scope.querySelector('#bem-props-field-display')?.value === 'directivity' ? 'directivity' : 'shell',
    quantity: ['phase', 'velocity', 'turbulence'].includes(quantity) ? quantity : 'level',
    axis: scope.querySelector('#bem-props-axis')?.value || item.axis || '+z',
    showWireframe: scope.querySelector('#bem-props-field-wireframe')?.checked === true,
    showMinus6: scope.querySelector('#bem-props-field-minus6')?.checked !== false,
    dbRange_db: Math.max(1, num('#bem-props-field-dbrange', item.dbRange_db ?? BEM_FIELD_DB_RANGE)),
    vMax_ms: Math.max(0, num('#bem-props-field-vmax', item.vMax_ms ?? 0)),
    velocityScale: scope.querySelector('#bem-props-field-vscale')?.value === 'linear' ? 'linear' : 'log',
    flowOverlay: ['none', 'particles'].includes(scope.querySelector('#bem-props-field-flow')?.value)
      ? scope.querySelector('#bem-props-field-flow').value : 'streamlines',
    showIsoLines: scope.querySelector('#bem-props-field-iso')?.checked !== false,
    streamDensity: Math.min(20, Math.max(1, num('#bem-props-field-density', item.streamDensity ?? 3))),
    // Vide = instant de débit maximal, recalculé à chaque fréquence.
    flowPhaseDeg: scope.querySelector('#bem-props-field-phase')?.value.trim() === ''
      ? null : num('#bem-props-field-phase', 0),
    particleCount: Math.min(20000, Math.max(50, num('#bem-props-field-pcount', item.particleCount ?? 1200))),
    particleSpeed: Math.max(0.05, num('#bem-props-field-pspeed', item.particleSpeed ?? 1)),
    cfd: quantity === 'turbulence' || scope.querySelector('#bem-props-field-cfd')?.checked === true,
    cfdQuality: scope.querySelector('#bem-props-field-cfdq')?.value === 'normal' ? 'normal' : 'draft',
    cfdCell_mm: Math.max(0, num('#bem-props-field-cfdcell', item.cfdCell_mm ?? 0)),
    cfdWallLevel: Math.min(3, Math.max(0, num('#bem-props-field-cfdwall', item.cfdWallLevel ?? 0))),
    cfdPeriods: Math.min(12, Math.max(1, num('#bem-props-field-cfdper', item.cfdPeriods ?? 2))),
    cfdVentId: scope.querySelector('#bem-props-field-vent')?.value || null,
    offsetX_mm: num('#bem-props-offx', item.offsetX_mm ?? 0),
    offsetY_mm: num('#bem-props-offy', item.offsetY_mm ?? 0),
    offsetZ_mm: num('#bem-props-offz', item.offsetZ_mm ?? 0),
    width_mm: Math.max(1, num('#bem-props-field-width', item.width_mm ?? 2000)),
    height_mm: Math.max(1, num('#bem-props-field-height', item.height_mm ?? 2000)),
    delta_mm: Math.max(1, num('#bem-props-field-delta', item.delta_mm ?? 100)),
    radius_mm: Math.max(1, num('#bem-props-field-radius', item.radius_mm ?? 1000)),
    deltaTheta_deg: Math.max(1, num('#bem-props-field-dtheta', item.deltaTheta_deg ?? 10)),
    deltaPhi_deg: Math.max(1, num('#bem-props-field-dphi', item.deltaPhi_deg ?? 10)),
  };
}

/** Turns a tree label into an inline text input on right-click and commits the rename on blur/Enter. */
function startBemTreeRename(root, labelEl) {
  const target = labelEl.dataset.propsTarget;
  if (!target) return;
  const [type, nodeId, childId] = target.split(':');
  const item = bemTreeItems.find(it => it.id === nodeId);
  const record = type === 'node'
    ? item
    : (type === 'component' ? findBemComponent(item, childId) : item?.surfaces.find(s => s.id === childId));
  if (!record) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bem-tree-rename-input';
  input.value = record.name;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    record.name = input.value.trim() || record.name;
    renderBemTree(root);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = record.name; input.blur(); }
  });
  input.addEventListener('blur', commit, { once: true });
}

async function loadBemDriverDb() {
  if (!bemDriverDbPromise) {
    bemDriverDbPromise = Promise.resolve(window.electronAPI?.getAllDrivers?.())
      .then(drivers => Array.isArray(drivers) ? drivers : [])
      .then(drivers => drivers.map(driver => ({
        ...driver,
        params: normalizeBemDriverParams(driver.params, driver.content),
      })).filter(driver => driver.name));
  }
  return bemDriverDbPromise;
}

/** Searchable driver picker (same interaction as Horn Studio's driver search). */
function initBemDriverPicker(body, component) {
  const search = body.querySelector('#bem-props-driver-search');
  const list = body.querySelector('#bem-props-driver-list');
  const toggle = body.querySelector('#bem-props-driver-toggle');
  const info = body.querySelector('#bem-props-driver-info');
  if (!search || !list || !toggle) return;

  let drivers = [];
  const select = (driver) => {
    toggle._bemDriver = driver;
    toggle.textContent = `[ ${driver ? driver.name : 'None'} ]`;
    if (info) info.textContent = driver ? formatDriverSummary(driver.params) : '';
  };
  if (component.driverName && component.driverParams) {
    select({ name: component.driverName, params: normalizeBemDriverParams(component.driverParams) });
  } else {
    select(null);
  }

  loadBemDriverDb().then(loaded => {
    if (!search.isConnected) return;
    drivers = loaded;
    const known = drivers.find(d => d.name === component.driverName);
    if (known) select(known);
  }).catch(err => {
    console.error('[BEM Solver] failed to load driver DB', err);
    if (info) info.textContent = 'Driver DB unavailable';
  });

  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    if (!term) { list.classList.add('-hidden'); return; }
    const filtered = drivers.filter(d => d.name.toLowerCase().includes(term)).slice(0, 100);
    list.innerHTML = filtered.length
      ? filtered.map(d => `<div class="bem-driver-item" data-driver-name="${escapeHtmlAttr(d.name)}">${escapeHtml(d.name)}</div>`).join('')
      : '<div class="bem-driver-item -empty">No match</div>';
    list.classList.remove('-hidden');
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-driver-name]');
    if (!row) return;
    select(drivers.find(d => d.name === row.dataset.driverName) || null);
    list.classList.add('-hidden');
    search.value = '';
  });
  toggle.addEventListener('click', () => {
    select(null);
    list.classList.add('-hidden');
  });
}

// --------------------------------------------------------
//  PUBLIC : INIT
// --------------------------------------------------------
export function initializeBemSolverPanel(rootElement, options = {}) {
  const root = rootElement.querySelector('#directivity-root');
  if (!root) return;
  const embeddedPro = root.dataset.embeddedPro === 'true';
  const graphsOnly = root.dataset.graphsOnly === 'true';
  bemPanelRoots.add(root);

  // Waveguide Studio fournit ici l'accès à Gmsh sur sa géométrie courante.
  bemMeshProvider = options.getBemMesh || null;

  if (!graphsOnly) {
    initBemMainTabs(root);
    initBemConfigTab(root);
    initializeBemHotkeys(root);
  }

  // Tabs
  const tabBtns = root.querySelectorAll('.dir-tab-btn');
  const tabContents = root.querySelectorAll('.dir-tab-content');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('-active'));
      btn.classList.add('-active');
      tabContents.forEach(c => c.classList.add('-hidden'));
      root.querySelector(`#dir-tab-${target}`).classList.remove('-hidden');
      if (currentResults) {
        renderActiveTab(root, target);
        requestAnimationFrame(() => renderActiveTab(root, target));
      }
    });
  });

  // Imports from Horn Expansion
  const importListener = (event) => {
    const data = event.detail;
    if (!embeddedPro && data.waveguideStudio) return;
    advancedGeometryData = {
      lastSegmentWidth: data.lastSegmentWidth,
      lastSegmentHeight: data.lastSegmentHeight,
      wallAngleH: data.calculatedWallAngleH,
      wallAngleV: data.calculatedWallAngleV,
      expansionType: data.expansionType,
      cutoffFrequency: data.cutoffFrequency,
      // Le maillage BEM ne dépend plus des cases Show Interface / Split de
      // l'UI (il les force), mais il dépend du Z Offset de l'interface : c'est
      // lui qui fixe le plan du baffle.
      interfaceTipOffset: data.interfaceTipOffset ?? 0,
    };
    currentSegments = Array.isArray(data.segments) ? data.segments : null;
    const keepDisplayedResults = embeddedPro && data.sync && !!currentResults;
    const shouldRecalculate = !embeddedPro || data.sync || !currentResults;
    lastMouthWidth = data.lastSegmentWidth;
    lastMouthHeight = data.lastSegmentHeight;
    if (shouldRecalculate && !keepDisplayedResults) recalcResults(root);
  };
  window.panelEvents?.addEventListener('export-to-directivity', importListener);

  // Tab-specific controls
  root.querySelectorAll('.dir-plane-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.dir-plane-btn').forEach(b => b.classList.remove('-active'));
      btn.classList.add('-active');
      if (currentResults) renderHeatmap(root);
    });
  });
  ['dir-hm-fmin', 'dir-hm-fmax', 'dir-hm-range'].forEach(id => {
    const control = root.querySelector(`#${id}`);
    control.addEventListener('input', () => {
      if (currentResults) renderHeatmap(root);
    });
    control.addEventListener('change', () => {
      if (currentResults) renderHeatmap(root);
    });
  });
  const hmContour = root.querySelector('#dir-hm-show-contour');
  if (hmContour) hmContour.addEventListener('change', () => {
    if (currentResults) renderHeatmap(root);
  });
  const exportDirBtn = root.querySelector('#dir-export-directivity-txt');
  if (exportDirBtn) exportDirBtn.addEventListener('click', async () => {
    const planeBtn = root.querySelector('.dir-plane-btn.-active');
    const plane = planeBtn?.dataset.plane === 'vertical' ? 'v' : 'h';
    const step = parseFloat(root.querySelector('#dir-export-angle-step')?.value);
    const content = buildAkabakDirectivityTxt(plane, Number.isFinite(step) && step > 0 ? step : 10);
    if (!content) { flashButton(exportDirBtn, 'Run BEM first', true); return; }
    await saveAkabakTxt(exportDirBtn, content, `contour ${plane}.txt`);
  });
  const exportSplBtn = root.querySelector('#dir-export-spl-txt');
  if (exportSplBtn) exportSplBtn.addEventListener('click', async () => {
    const content = buildAkabakSplTxt();
    if (!content) { flashButton(exportSplBtn, 'No SPL data', true); return; }
    await saveAkabakTxt(exportSplBtn, content, 'spl curves.txt');
  });
  ['dir-spl-fmin', 'dir-spl-fmax', 'dir-spl-dbmin', 'dir-spl-dbmax'].forEach(id => {
    const control = root.querySelector(`#${id}`);
    if (!control) return;
    control.addEventListener('input', () => renderSplCurve(root));
    control.addEventListener('change', () => renderSplCurve(root));
  });
  const snapshotBtn = root.querySelector('#dir-spl-snapshot');
  if (snapshotBtn) snapshotBtn.addEventListener('click', () => {
    if (!addSplSnapshot(root)) flashButton(snapshotBtn, 'No SPL data', true);
  });
  root.querySelector('#dir-spl-autoscale')?.addEventListener('click', () => {
    autoscaleSplControls(root);
    renderSplCurve(root);
  });
  ['dir-exc-fmin', 'dir-exc-fmax', 'dir-exc-mmmax', 'dir-exc-xmax'].forEach(id => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('input', () => renderExcursionCurve(root));
    el.addEventListener('change', () => renderExcursionCurve(root));
  });
  const excSnapshotBtn = root.querySelector('#dir-exc-snapshot');
  if (excSnapshotBtn) excSnapshotBtn.addEventListener('click', () => {
    if (!addSplSnapshot(root)) flashButton(excSnapshotBtn, 'No data', true);
  });
  root.querySelector('#dir-exc-autoscale')?.addEventListener('click', () => {
    autoscaleExcursionControls(root);
    renderExcursionCurve(root);
  });
  ['dir-polar-slider', 'dir-polar-show-h', 'dir-polar-show-v', 'dir-polar-range']
    .forEach(id => {
      root.querySelector(`#${id}`).addEventListener('input', () => {
        if (currentResults) renderPolar(root);
      });
      root.querySelector(`#${id}`).addEventListener('change', () => {
        if (currentResults) renderPolar(root);
      });
    });
  ['dir-bw-show-h', 'dir-bw-show-v', 'dir-bw-show-q'].forEach(id => {
    root.querySelector(`#${id}`).addEventListener('change', () => {
      if (currentResults) renderBeamwidth(root);
    });
  });

  // Heatmap hover readout
  setupHeatmapHover(root);
  setupSplHover(root);
  setupExcursionHover(root);

  // Handle resize
  root._bemResizeObserver?.disconnect();
  root._bemResizeObserver = new ResizeObserver(() => {
    if (currentResults) renderActiveTab(root, getActiveTab(root));
  });
  root._bemResizeObserver.observe(root);

  if (graphsOnly && currentResults) {
    requestAnimationFrame(() => recalcResults(root));
  }
}

function resolveBemRoot(rootElement) {
  if (!rootElement) return null;
  return rootElement.matches?.('#directivity-root')
    ? rootElement
    : rootElement.querySelector?.('#directivity-root');
}

export async function importBemMeshContent(rootElement, mshContent, fileName = 'waveguide.msh') {
  const root = resolveBemRoot(rootElement);
  if (!root || root.dataset.graphsOnly === 'true') {
    throw new Error('The BEM Solver configuration panel is not available.');
  }
  if (!mshContent) throw new Error('The generated mesh is empty.');

  for (let attempt = 0; attempt < 4 && !root._bemMeshViewer; attempt++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  if (!root._bemMeshViewer) throw new Error('The BEM mesh viewer is not ready.');

  bemMeshContent = String(mshContent);
  root._bemMeshViewer.loadMeshFromText(bemMeshContent);
  const remap = remapBemTreeSurfaces(root._bemMeshViewer.getSurfaces());
  restoreBemTreeViewerState(root);
  renderBemTree(root);
  const hint = root.querySelector('.bem-viewer-hint');
  if (hint) hint.textContent = fileName;
  if (remap.removed) {
    setBemStatus(root, `${remap.removed} surface assignment(s) not found in the new mesh.`, true);
  } else if (remap.remapped) {
    setBemStatus(root, `${remap.remapped} surface tag(s) remapped to the new mesh.`);
  } else {
    setBemStatus(root, 'Mesh imported; surface assignments preserved.');
  }
  return remap;
}

export function hasCompletedBemSimulation() {
  return bemHasCompletedRun;
}

export function refreshBemGraphs(rootElement) {
  const root = resolveBemRoot(rootElement);
  if (!root || !currentResults) return;
  recalcResults(root);
  requestAnimationFrame(() => renderActiveTab(root, getActiveTab(root)));
}

export async function rerunBemSolver(rootElement) {
  const root = resolveBemRoot(rootElement);
  if (!root || root.dataset.graphsOnly === 'true') {
    throw new Error('The BEM Solver configuration panel is not available.');
  }
  if (!bemHasCompletedRun) {
    throw new Error('Run the first simulation manually in BEM Solver before enabling SYNC.');
  }
  const startBtn = root.querySelector('#bem-btn-start');
  const abortBtn = root.querySelector('#bem-btn-abort');
  if (!startBtn || !abortBtn) throw new Error('The BEM Solver controls are not ready.');
  const completed = await runBemSolve(root, startBtn, abortBtn, true);
  if (!completed) {
    throw new Error(root.querySelector('#bem-solve-status')?.textContent || 'BEM simulation failed.');
  }
}

function getActiveTab(root) {
  const active = root.querySelector('.dir-tab-btn.-active');
  return active ? active.dataset.tab : 'heatmap';
}

function renderActiveTab(root, tab) {
  if (tab === 'heatmap') renderHeatmap(root);
  else if (tab === 'polar') renderPolar(root);
  else if (tab === 'beamwidth') renderBeamwidth(root);
  else if (tab === 'table') renderDataTable(root);
  else if (tab === 'spl') renderSplCurve(root);
  else if (tab === 'excursion') renderExcursionCurve(root);
}

// =========================================================
//  ACOUSTICS ENGINE
// =========================================================
/**
 * Table frequency points used for the data table and summary dropdown.
 */
const TABLE_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * (Re)builds the analytic model from the last imported mouth dimensions and
 * refreshes the Graphs tab. Replaces the old manual "Calculate Directivity"
 * button now that Simple mode is gone — geometry always comes from an import.
 */
function recalcResults(root) {
  if (!(lastMouthWidth > 0) || !(lastMouthHeight > 0)) return;
  currentResults = buildResults(lastMouthWidth, lastMouthHeight, advancedGeometryData);
  renderDataTable(root);
  root.querySelector('#dir-results')?.classList.remove('-hidden');
  renderActiveTab(root, getActiveTab(root));
}

/**
 * Build full result model.
 */
function buildResults(widthMm, heightMm, adv) {
  const widthM = widthMm / 1000;
  const heightM = heightMm / 1000;
  const isProMode = adv !== null;

  // Pre-compute -6 dB beamwidth per frequency
  const rows = TABLE_FREQS.map(f => {
    const h = findBeamwidthMinus6(f, widthM, 'h', adv);
    const v = findBeamwidthMinus6(f, heightM, 'v', adv);
    const q = 40000 / Math.max(1, h * v); // Keele approximation
    const di = 10 * Math.log10(q);
    return {
      frequency: f,
      horizontalAngle: h,
      verticalAngle: v,
      q,
      di
    };
  });

  return {
    widthM, heightM,
    isProMode,
    advancedData: adv,
    rows
  };
}

/**
 * Find -6 dB half beamwidth numerically by sampling the directivity function.
 * Returns the FULL beamwidth (2 × half) in degrees.
 * When BEM results are available (Pro mode + preview run), uses them instead
 * of the analytic model.
 */
function findBeamwidthMinus6(frequency, dimension, plane, adv) {
  // Use BEM polar data across its whole solved range — interpolateBemPolar
  // clamps to the nearest computed frequency past the ends, so there is no
  // reason to fall back to the analytic model early and create a seam.
  if (bemResults && bemResults.polarH && bemResults.polarH.length) {
    const polar = interpolateBemPolar(bemResults, plane === 'h' ? 'H' : 'V', frequency);
    if (polar) return clamp(polarBeamwidthMinus6(polar), 1, 180);
  }
  const target = dbToLinear(-6); // pressure amplitude at -6 dB ≈ 0.5012
  let prevAngle = 0;
  let prevVal = 1;
  let half = 90;
  for (let a = 0.5; a <= 90; a += 0.5) {
    const val = Math.abs(directivityPressure(a, frequency, dimension, plane, adv));
    if (val <= target) {
      // Linear-interpolate the crossing point between prevAngle and a
      const t = (prevVal - target) / Math.max(1e-9, (prevVal - val));
      half = prevAngle + t * (a - prevAngle);
      return clamp(2 * half, 1, 180);
    }
    prevAngle = a;
    prevVal = val;
  }
  return 180;
}

/**
 * Normalized pressure directivity D(θ) at a single off-axis angle in a given
 * principal plane (horizontal uses width, vertical uses height).
 *
 * Simple mode:  rectangular piston in infinite baffle  →  |sinc(kL/2 · sinθ)|
 *               multiplied by obliquity factor (1+cosθ)/2 (baffled radiator).
 *
 * Pro mode:     effective aperture L_eff(f) that enforces horn behavior per
 *               expansion type.  Models the transition between diffraction-
 *               controlled (low-f) and wall-angle-controlled (high-f) regimes.
 *               Below the horn cutoff, additional LF roll-off is applied and
 *               the response broadens (mouth unable to load the wavefront).
 *
 * Returns a value in [0, 1].
 */
function directivityPressure(angleDeg, frequency, dimension, plane, adv) {
  // BEM data takes precedence over the analytic model whenever it exists,
  // across the whole solved range (see findBeamwidthMinus6 above).
  if (bemResults && bemResults.polarH && bemResults.polarH.length) {
    const polar = interpolateBemPolar(bemResults, plane === 'h' ? 'H' : 'V', frequency);
    if (polar) {
      const a = clamp(angleDeg, polar.angles[0], polar.angles[polar.angles.length - 1]);
      // Linear interp between neighboring polar samples
      for (let i = 0; i < polar.angles.length - 1; i++) {
        const a0 = polar.angles[i], a1 = polar.angles[i + 1];
        if (a0 <= a && a <= a1) {
          const t = (a - a0) / Math.max(1e-9, a1 - a0);
          return polar.normalized[i] * (1 - t) + polar.normalized[i + 1] * t;
        }
      }
      return polar.normalized[polar.normalized.length - 1];
    }
  }

  const angleRad = (angleDeg * Math.PI) / 180;
  const sinA = Math.sin(angleRad);
  const k = calculateWaveNumber(frequency);

  // Effective aperture
  const Leff = effectiveAperture(frequency, dimension, plane, adv);

  // Sinc pattern of a uniform line source of length Leff
  const u = (k * Leff / 2) * sinA;
  const s = sinc(u);

  // NOTE: We intentionally do NOT apply an (1+cosθ)/2 obliquity factor here.
  // Although physically meaningful for an infinite-baffle rigid piston, it
  // reaches -6 dB near θ = 55° on its own — which would force the -6 dB
  // beamwidth to plateau at ~110° regardless of aperture or frequency,
  // masking both the piston-diffraction (LF broadening) and wall-angle
  // (HF control) regimes. Classical horn directivity plots are based on
  // the Fraunhofer aperture pattern alone.
  //
  // We also do NOT attenuate the response based on the horn cutoff: this
  // function returns a *normalized* pressure directivity pattern
  // D(θ)/D(0) ∈ [0,1]. Below cutoff the pattern naturally broadens toward
  // omnidirectional through the piston-diffraction term in effectiveAperture().

  return Math.abs(s);
}

/**
 * Effective aperture of the radiator at a given frequency.
 *
 * Derivation: to make the -6 dB beamwidth equal a target θ_target, we need
 *   L_eff = 1.895 c / (π f sin(θ_target/2))
 * because sinc(1.895) ≈ 0.5 (pressure -6 dB).
 */
function effectiveAperture(frequency, dimension, plane, adv) {
  if (!adv) return dimension; // Simple mode — use real mouth size.

  const wallAngle = (plane === 'h' ? adv.wallAngleH : adv.wallAngleV); // degrees, half-angle
  const fc = adv.cutoffFrequency > 0 ? adv.cutoffFrequency : 200;

  // Below cutoff → pure piston diffraction on the physical mouth: pattern
  // broadens toward omni as frequency drops (λ >> mouth).
  if (frequency <= fc) return dimension;

  // Above cutoff → wall-angle controlled pattern. Back-solve for Leff.
  const halfWallDeg = wallDrivenHalfBeamwidth(frequency, wallAngle, fc, adv.expansionType);
  if (halfWallDeg <= 0) return dimension;

  const halfTargetRad = (Math.min(halfWallDeg, 89) * Math.PI) / 180;
  const sinHalf = Math.sin(halfTargetRad);
  if (sinHalf <= 1e-6) return dimension * 10; // effectively very narrow

  const Leff = (1.895 * SPEED_OF_SOUND) / (Math.PI * frequency * sinHalf);

  // Smooth transition across the cutoff so the beamwidth curve doesn't kink.
  // Blend piston (physical dimension) → wall-controlled over half an octave.
  const xOct = Math.log2(frequency / fc);
  const blend = clamp(xOct / 0.5, 0, 1);
  return dimension * (1 - blend) + Leff * blend;
}

/**
 * Half beamwidth (-6 dB) in degrees for a rectangular piston of size L.
 * sinc(1.895) = 0.5  →  half angle = arcsin(1.895 c / (π f L))
 */
function pistonHalfBeamwidth(L, f) {
  const arg = (1.895 * SPEED_OF_SOUND) / (Math.PI * f * L);
  if (arg >= 1) return 90;
  return (Math.asin(arg) * 180) / Math.PI;
}

/**
 * Half beamwidth imposed by the wall angle, depending on horn expansion type.
 * Below cutoff — formula falls back to "wide", allowing piston diffraction to dominate.
 */
function wallDrivenHalfBeamwidth(f, wallHalfAngleDeg, fc, expansion) {
  if (f <= fc) return 0; // let diffraction dominate
  switch ((expansion || '').toLowerCase()) {
    case 'conical':
    case 'os':
    case 'oblate-spheroidal':
      // Constant directivity — beam equals wall angle above cutoff
      return wallHalfAngleDeg;
    case 'hypex':
      // Mild narrowing with frequency
      return wallHalfAngleDeg * Math.pow(fc / f, 0.15);
    case 'exponential':
    case 'expo':
      // Moderate narrowing
      return wallHalfAngleDeg * Math.pow(fc / f, 0.30);
    case 'parabolic':
    case 'para':
      // Strong narrowing (beaming)
      return wallHalfAngleDeg * Math.pow(fc / f, 0.45);
    default:
      return wallHalfAngleDeg;
  }
}

// =========================================================
//  RESULTS — TABLE
// =========================================================

function renderDataTable(root) {
  const tableContainer = root.querySelector('#dir-frequency-table');
  if (!tableContainer) return;
  const rows = currentResults.rows;
  tableContainer.innerHTML = `
    <table class="dir-table">
      <thead>
        <tr>
          <th>Frequency</th>
          <th>H Coverage (-6 dB)</th>
          <th>V Coverage (-6 dB)</th>
          <th>Q</th>
          <th>DI (dB)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="-freq">${formatFrequency(r.frequency)}</td>
            <td class="dir-angle ${coverageColorClass(r.horizontalAngle)}">${r.horizontalAngle.toFixed(0)}°</td>
            <td class="dir-angle ${coverageColorClass(r.verticalAngle)}">${r.verticalAngle.toFixed(0)}°</td>
            <td>${r.q.toFixed(1)}</td>
            <td>${r.di.toFixed(1)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function getSimulationFrequencyRange() {
  if (bemRequestedRange && bemResults?.polarH?.length) {
    return {
      fMin: Math.max(10, bemRequestedRange.fMin),
      fMax: Math.max(bemRequestedRange.fMin * 1.001, bemRequestedRange.fMax),
    };
  }
  return { fMin: 50, fMax: 20000 };
}

function getGraphFrequencyRange(root) {
  const bounds = getSimulationFrequencyRange();
  const requestedMin = parseFloat(root.querySelector('#dir-hm-fmin')?.value);
  const requestedMax = parseFloat(root.querySelector('#dir-hm-fmax')?.value);
  const fMin = clamp(Number.isFinite(requestedMin) ? requestedMin : bounds.fMin, bounds.fMin, bounds.fMax);
  const fMax = clamp(Number.isFinite(requestedMax) ? requestedMax : bounds.fMax, bounds.fMin, bounds.fMax);
  return fMax > fMin ? { fMin, fMax } : bounds;
}

function syncGraphControlsToSimulation(root, fMin, fMax) {
  root.querySelector('#dir-hm-fmin').value = String(fMin);
  root.querySelector('#dir-hm-fmax').value = String(fMax);
  root.querySelector('#dir-hm-range').value = '20';
  root.querySelector('#dir-polar-range').value = '20';
  root.querySelector('#dir-polar-slider').value = '50';
  // Le SPL suit les Hz de la simulation ; l'échelle dB garde son défaut 70–120.
  const splFMin = root.querySelector('#dir-spl-fmin');
  const splFMax = root.querySelector('#dir-spl-fmax');
  if (splFMin) splFMin.value = String(fMin);
  if (splFMax) splFMax.value = String(fMax);
}

// =========================================================
//  HEATMAP  (REW-style rainbow bands, per-pixel)
// =========================================================
function renderHeatmap(root) {
  const canvas = root.querySelector('#dir-heatmap-canvas');
  if (!canvas || !canvas.isConnected) return;

  const plane = currentHeatmapPlane(root);
  const dbRange = clamp(parseFloat(root.querySelector('#dir-hm-range').value) || 20, 1, 120);
  const dimension = plane === 'horizontal' ? currentResults.widthM : currentResults.heightM;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.max(300, Math.floor(rect.width  * dpr));
  canvas.height = Math.max(200, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width;
  const H = rect.height;

  // Plot area insets — padR leaves room for the color legend
  const padL = 62, padR = 98, padT = 40, padB = 52;
  const plotW = Math.max(50, W - padL - padR);
  const plotH = Math.max(50, H - padT - padB);

  // Frequency range (log axis) follows the editable graph controls. Values are
  // clamped to the solved interval because BEM data outside it would only be a
  // repeated endpoint, not a simulated result.
  const { fMin, fMax } = getGraphFrequencyRange(root);
  const aMin = -90, aMax = 90;
  const logFMin = Math.log10(fMin), logFMax = Math.log10(fMax);

  ctx.clearRect(0, 0, W, H);

  // Fill plot area pixel-by-pixel at the canvas' physical resolution.
  // putImageData works in device pixels and ignores the active transform.
  const pixelPlotW = Math.max(1, Math.floor(plotW * dpr));
  const pixelPlotH = Math.max(1, Math.floor(plotH * dpr));
  const img = ctx.createImageData(pixelPlotW, pixelPlotH);
  const data = img.data;
  for (let py = 0; py < pixelPlotH; py++) {
    const angle = aMax - (py / Math.max(1, pixelPlotH - 1)) * (aMax - aMin);
    for (let px = 0; px < pixelPlotW; px++) {
      const logF = logFMin + (px / Math.max(1, pixelPlotW - 1)) * (logFMax - logFMin);
      const f = Math.pow(10, logF);
      const p = directivityPressure(Math.abs(angle), f, dimension, plane === 'horizontal' ? 'h' : 'v', currentResults.advancedData);
      const db = linearToDb(Math.max(1e-6, p));
      const [r, g, b] = rewColor(db, dbRange);
      const i = (py * pixelPlotW + px) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, Math.floor(padL * dpr), Math.floor(padT * dpr));

  // Frame
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Grid + ticks: angle (y)
  ctx.fillStyle = '#d1d5db';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const angleTicks = [-90, -60, -30, 0, 30, 60, 90];
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  angleTicks.forEach(a => {
    const y = padT + (1 - (a - aMin) / (aMax - aMin)) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(`${a}°`, padL - 8, y);
  });

  // Grid + ticks: freq (x)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const allFreqTicks = [20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000];
  const freqTicks = [...new Set([fMin, ...allFreqTicks, fMax])]
    .filter(f => f >= fMin * 0.999 && f <= fMax * 1.001)
    .sort((a, b) => a - b);
  freqTicks.forEach(f => {
    const x = padL + (Math.log10(f) - logFMin) / (logFMax - logFMin) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, padT + plotH + 8);
  });

  // Axis titles
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // Y-axis title above the plot, horizontally above the tick column
  ctx.fillText('Angle (°)', padL - 30, padT - 14);
  // X-axis title centered below
  ctx.fillText('Frequency (Hz)', padL + plotW / 2, H - 8);

  // Optional -6 dB contour overlay
  const contourCheck = root.querySelector('#dir-hm-show-contour');
  if (contourCheck && contourCheck.checked) {
    drawMinus6Contour(ctx, {
      padL, padT, plotW, plotH, logFMin, logFMax, aMin, aMax,
      dimension, plane, advancedData: currentResults.advancedData
    });
  }

  // Draw legend inside padR column, aligned with plot vertical range
  drawLegendInline(ctx, {
    x: padL + plotW + 18,
    y: padT,
    w: 18,
    h: plotH
  }, dbRange);

  // Store layout for hover
  canvas._layout = { padL, padT, plotW, plotH, logFMin, logFMax, aMin, aMax };
}

/**
 * In-canvas legend, aligned vertically with the plot area.
 */
function drawLegendInline(ctx, box, dbRange) {
  const { x, y, w, h } = box;
  // Gradient fill
  for (let py = 0; py < h; py++) {
    const db = -(py / (h - 1)) * dbRange;
    const [r, g, b] = rewColor(db, dbRange);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y + py, w, 1);
  }
  // Border
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  // Ticks
  ctx.fillStyle = '#d1d5db';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const step = dbRange >= 24 ? 6 : (dbRange >= 18 ? 3 : 2);
  for (let db = 0; db >= -dbRange; db -= step) {
    const ty = y + ((-db) / dbRange) * h;
    ctx.strokeStyle = '#9ca3af';
    ctx.beginPath();
    ctx.moveTo(x + w, ty); ctx.lineTo(x + w + 3, ty);
    ctx.stroke();
    ctx.fillText(`${db}`, x + w + 5, ty);
  }
  // Title above
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('dB', x + w / 2, y - 6);
}

/**
 * Draws the -6 dB contour as two polylines (upper / lower) on top of the heatmap.
 * Sweeps frequencies column-by-column and finds the angle where the polar
 * response crosses -6 dB relative to the on-axis value.
 */
function drawMinus6Contour(ctx, layout) {
  const { padL, padT, plotW, plotH, logFMin, logFMax, aMin, aMax, dimension, plane, advancedData } = layout;
  const planeCode = plane === 'horizontal' ? 'h' : 'v';
  const nCols = Math.min(480, Math.max(120, Math.floor(plotW)));
  const upper = [];
  const lower = [];

  for (let i = 0; i < nCols; i++) {
    const t = i / (nCols - 1);
    const logF = logFMin + t * (logFMax - logFMin);
    const f = Math.pow(10, logF);
    const x = padL + t * plotW;

    const p0 = Math.max(1e-6, directivityPressure(0, f, dimension, planeCode, advancedData));
    const target = p0 * Math.pow(10, -6 / 20);

    const N = 180;
    let crossAngle = null;
    let prevP = p0;
    for (let j = 1; j <= N; j++) {
      const a = (j / N) * 90;
      const p = directivityPressure(a, f, dimension, planeCode, advancedData);
      if (prevP >= target && p <= target) {
        const aPrev = ((j - 1) / N) * 90;
        const dbPrev = 20 * Math.log10(Math.max(1e-9, prevP) / p0);
        const dbCur  = 20 * Math.log10(Math.max(1e-9, p)      / p0);
        const denom = (dbPrev - dbCur) || 1e-9;
        const frac = (dbPrev - (-6)) / denom;
        crossAngle = aPrev + frac * (a - aPrev);
        break;
      }
      prevP = p;
    }
    if (crossAngle == null) continue;

    const yUp = padT + (1 - (crossAngle - aMin) / (aMax - aMin)) * plotH;
    const yLo = padT + (1 - (-crossAngle - aMin) / (aMax - aMin)) * plotH;
    upper.push([x, yUp]);
    lower.push([x, yLo]);
  }

  if (upper.length < 2) return;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000000';
  ctx.shadowColor = 'rgba(255,255,255,0.5)';
  ctx.shadowBlur = 2;

  ctx.beginPath();
  ctx.moveTo(upper[0][0], upper[0][1]);
  for (let i = 1; i < upper.length; i++) ctx.lineTo(upper[i][0], upper[i][1]);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(lower[0][0], lower[0][1]);
  for (let i = 1; i < lower.length; i++) ctx.lineTo(lower[i][0], lower[i][1]);
  ctx.stroke();
  ctx.restore();
}

function currentHeatmapPlane(root) {
  const active = root.querySelector('.dir-plane-btn.-active');
  return active ? active.dataset.plane : 'horizontal';
}

/**
 * REW-style rainbow colormap (0 dB → red, then orange, yellow, green, cyan, blue, deep blue).
 * dbRange is the full window that maps 0..-dbRange to color span.
 */
function rewColor(db, dbRange) {
  const t = clamp(-db / dbRange, 0, 1); // 0 (top, red) → 1 (bottom, deep blue)
  // Stops approx. matching REW palette
  const stops = [
    [0.00, [165,  30,  30]],  // dark red
    [0.08, [220,  40,  40]],  // red
    [0.20, [240, 110,  30]],  // orange
    [0.33, [245, 205,  40]],  // yellow
    [0.45, [100, 200,  60]],  // green
    [0.58, [ 40, 190, 170]],  // teal/cyan
    [0.72, [ 40, 140, 220]],  // blue
    [0.88, [ 30,  70, 190]],  // deep blue
    [1.00, [ 20,  30, 100]]   // navy
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / Math.max(1e-9, (t1 - t0));
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2]))
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function setupHeatmapHover(root) {
  const canvas  = root.querySelector('#dir-heatmap-canvas');
  const overlay = root.querySelector('#dir-heatmap-overlay');
  const readout = root.querySelector('#dir-hm-readout');
  if (!canvas || !overlay) return;

  const clearOverlay = () => {
    if (!overlay.isConnected) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    readout.innerHTML = '&mdash;';
  };

  canvas.addEventListener('mousemove', (e) => {
    const layout = canvas._layout;
    if (!layout || !currentResults) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { padL, padT, plotW, plotH, logFMin, logFMax, aMin, aMax } = layout;
    if (x < padL || x > padL + plotW || y < padT || y > padT + plotH) {
      readout.innerHTML = '&mdash;';
      return;
    }
    const f = Math.pow(10, logFMin + (x - padL) / plotW * (logFMax - logFMin));
    const a = aMax - (y - padT) / plotH * (aMax - aMin);
    const plane = currentHeatmapPlane(root);
    const dim = plane === 'horizontal' ? currentResults.widthM : currentResults.heightM;
    const p = directivityPressure(Math.abs(a), f, dim, plane === 'horizontal' ? 'h' : 'v', currentResults.advancedData);
    const db = linearToDb(Math.max(1e-6, p));

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    readout.innerHTML =
      `<span style="color:#f9a8d4">${formatFrequency(f, true)}</span>` +
      ` &middot; <span style="color:#6ee7b7">${a.toFixed(0)}°</span>` +
      ` &middot; <span style="color:#fcd34d">${db.toFixed(1)} dB</span>`;
  });

  canvas.addEventListener('mouseleave', clearOverlay);
}

// =========================================================
//  POLAR PLOT  (half circle, dB rings)
// =========================================================
function renderPolar(root) {
  const canvas = root.querySelector('#dir-polar-canvas');
  if (!canvas || !canvas.isConnected) return;

  const slider   = root.querySelector('#dir-polar-slider');
  const freqLabel = root.querySelector('#dir-polar-freq-label');
  const showH    = root.querySelector('#dir-polar-show-h').checked;
  const showV    = root.querySelector('#dir-polar-show-v').checked;
  const dbRange  = clamp(parseFloat(root.querySelector('#dir-polar-range').value) || 20, 1, 120);

  // Map slider [0..100] onto the frequency interval of the latest simulation.
  const t = parseInt(slider.value, 10) / 100;
  const { fMin, fMax } = getSimulationFrequencyRange();
  const f = Math.pow(10, Math.log10(fMin) + t * (Math.log10(fMax) - Math.log10(fMin)));
  freqLabel.textContent = formatFrequency(f, true);

  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    requestAnimationFrame(() => {
      if (currentResults && getActiveTab(root) === 'polar') renderPolar(root);
    });
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(rect.width  * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  // Geometry — half circle, 0° at top
  const cx = W / 2;
  const cy = H - 30;
  const R = Math.min(W / 2 - 40, H - 50);
  if (R <= 10) return;

  // Rings
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ringStep = dbRange >= 24 ? 6 : (dbRange >= 18 ? 6 : 3);
  for (let db = 0; db >= -dbRange; db -= ringStep) {
    const r = R * (1 - (-db) / dbRange);
    if (r <= 0) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
    ctx.stroke();
    ctx.fillText(`${db}`, cx - 3, cy - r);
  }
  // Baseline
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.stroke();

  // Angular spokes
  const spokeAngles = [-90, -60, -30, 0, 30, 60, 90];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  spokeAngles.forEach(deg => {
    const rad = ((deg - 90) * Math.PI) / 180; // rotate so 0° is up
    const x2 = cx + R * Math.cos(rad);
    const y2 = cy + R * Math.sin(rad);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillStyle = '#9ca3af';
    const lx = cx + (R + 16) * Math.cos(rad);
    const ly = cy + (R + 16) * Math.sin(rad);
    ctx.fillText(`${deg}°`, lx, ly);
  });

  // Curves
  const drawCurve = (dim, plane, color) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color.replace('rgb', 'rgba').replace(')', ',0.18)');
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let a = -90; a <= 90; a += 1) {
      const p = directivityPressure(Math.abs(a), f, dim, plane, currentResults.advancedData);
      const db = linearToDb(Math.max(1e-6, p));
      const norm = clamp(1 - (-db) / dbRange, 0, 1);
      const rad = ((a - 90) * Math.PI) / 180;
      const x = cx + R * norm * Math.cos(rad);
      const y = cy + R * norm * Math.sin(rad);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  if (showH) drawCurve(currentResults.widthM,  'h', 'rgb(244, 63, 94)');  // rose
  if (showV) drawCurve(currentResults.heightM, 'v', 'rgb(16, 185, 129)'); // emerald

  // Outer arc
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI);
  ctx.stroke();

  // Title
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 13px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Polar response @ ${formatFrequency(f, true)}`, 14, 10);
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(`Scale: 0 to -${dbRange} dB`, 14, 28);
}

// =========================================================
//  BEAMWIDTH CURVE
// =========================================================
function renderBeamwidth(root) {
  const canvas = root.querySelector('#dir-beamwidth-canvas');
  if (!canvas || !canvas.isConnected) return;

  const showH = root.querySelector('#dir-bw-show-h').checked;
  const showV = root.querySelector('#dir-bw-show-v').checked;
  const showQ = root.querySelector('#dir-bw-show-q').checked;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(rect.width  * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 62, padR = showQ ? 80 : 60, padT = 40, padB = 52;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // X log freq
  const fMin = 50, fMax = 20000;
  const logFMin = Math.log10(fMin), logFMax = Math.log10(fMax);
  // Y0: beamwidth 0..180 ; Y1: Q 1..40 (log)
  const bwMin = 0, bwMax = 180;
  const qMin = 1, qMax = 40;

  // Title (above the plot, centered, no overlap)
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 13px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Beamwidth vs Frequency', padL, 22);

  // Plot frame
  ctx.strokeStyle = '#4b5563';
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const yTicks = [0, 30, 60, 90, 120, 150, 180];
  yTicks.forEach(v => {
    const y = padT + plotH * (1 - (v - bwMin) / (bwMax - bwMin));
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillText(`${v}°`, padL - 8, y);
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const fTicks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  fTicks.forEach(f => {
    const x = padL + (Math.log10(f) - logFMin) / (logFMax - logFMin) * plotW;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, padT + plotH + 8);
  });

  // Right axis — Q (log)
  if (showQ) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#d97706';
    [1, 2, 5, 10, 20, 40].forEach(q => {
      const yN = (Math.log10(q) - Math.log10(qMin)) / (Math.log10(qMax) - Math.log10(qMin));
      const y = padT + plotH * (1 - yN);
      ctx.fillText(`Q=${q}`, padL + plotW + 4, y);
    });
  }

  // Compute curves
  const NPTS = 180;
  const advData = currentResults.advancedData;
  const points = [];
  for (let i = 0; i < NPTS; i++) {
    const f = Math.pow(10, logFMin + i / (NPTS - 1) * (logFMax - logFMin));
    const h = findBeamwidthMinus6(f, currentResults.widthM,  'h', advData);
    const v = findBeamwidthMinus6(f, currentResults.heightM, 'v', advData);
    const q = 40000 / Math.max(1, h * v);
    points.push({ f, h, v, q });
  }

  const xOf = f => padL + (Math.log10(f) - logFMin) / (logFMax - logFMin) * plotW;
  const yBw = v => padT + plotH * (1 - (v - bwMin) / (bwMax - bwMin));
  const yQ = q => padT + plotH * (1 - (Math.log10(q) - Math.log10(qMin)) / (Math.log10(qMax) - Math.log10(qMin)));

  const drawLine = (yFn, key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xOf(p.f);
      const y = yFn(p[key]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  if (showH) drawLine(yBw, 'h', 'rgb(244, 63, 94)');
  if (showV) drawLine(yBw, 'v', 'rgb(16, 185, 129)');
  if (showQ) drawLine(yQ,  'q', 'rgb(251, 191, 36)');

  // Axis titles
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Beamwidth (°)', padL - 30, padT - 12);
  ctx.fillText('Frequency (Hz)', padL + plotW / 2, H - 8);
}

// =========================================================
//  UTILITIES
// =========================================================
function formatFrequency(f, precise = false) {
  if (f >= 1000) return precise ? `${(f / 1000).toFixed(2)} kHz` : `${f / 1000} kHz`;
  return precise ? `${f.toFixed(0)} Hz` : `${f} Hz`;
}

function coverageColorClass(angle) {
  if (angle > 120) return '-sky';
  if (angle > 60) return '-emerald';
  if (angle > 30) return '-amber';
  return '-orange';
}

// ============================================================
//  SPL Response (BEM + driver coupling) — helpers
// ============================================================

function updateSplDataFromBemResult(result, config, log = false) {
  const onAxis = result.onAxis || [];
  if (!onAxis.length) { splData = null; return; }

  const drivenSurfaces = [];
  let diaphragm = null;
  for (const subdomain of bemTreeItems.filter(item => item.kind === 'Subdomain')) {
    for (const surface of subdomain.surfaces) {
      if (surface.role === 'driven') drivenSurfaces.push(surface);
    }
    if (!diaphragm) {
      diaphragm = (subdomain.components || []).find(c => c.type === 'diaphragm' && c.driverParams) || null;
    }
  }
  // Le baffle infini est DÉJÀ dans le BEM (sources images du domaine bafflé) :
  // lui rajouter +6 dB compterait le demi-espace deux fois.
  const loads = result.drivenLoad || [];

  if (diaphragm) {
    const params = normalizeBemDriverParams(diaphragm.driverParams);
    const vRMS = Number.isFinite(config.driveVrms) ? config.driveVrms : DEFAULT_DRIVE_VRMS;
    // Le diaphragme dessiné EST le piston : il se translate à la vitesse de la
    // membrane, et Sd ne sert qu'à l'affichage. C'est la convention d'Akabak,
    // et la seule qui soit cohérente — la surface maillée, pas Sd, est ce que
    // le BEM fait rayonner.
    const splDb = onAxis.map((point, i) => {
      const coneVelocity = driverVelocityFromTs(params, point.f, vRMS * filterChainGain(bemFilters, point.f), loads[i] || null);
      return pressureToSpl(point.p_ref * coneVelocity);
    });
    // Excursion crête simple sens. En régime harmonique le déplacement est la
    // vitesse divisée par ω, et √2 passe de l'efficace à la crête : c'est cette
    // crête qui se compare au Xmax du constructeur.
    const xPeakMm = onAxis.map((point, i) => {
      const v = driverVelocityFromTs(params, point.f, vRMS * filterChainGain(bemFilters, point.f), loads[i] || null);
      return point.f > 0 ? (Math.SQRT2 * v) / (2 * Math.PI * point.f) * 1000 : NaN;
    });
    if (log) logSplCoupling(onAxis, loads, splDb, params, vRMS);
    splData = {
      freqs: onAxis.map(point => point.f),
      splDb,
      xPeakMm,
      xmaxMm: params.Xmax_mm > 0 ? params.Xmax_mm : null,
      phaseDeg: onAxis.map(point => point.phaseDeg ?? 0),
      driverName: diaphragm.driverName || 'Selected driver',
      vRMS,
      baffleGainDB: 0,
      // Un résultat enregistré avant l'ajout de la charge BEM n'en contient pas :
      // le driver serait alors calculé « en l'air », donc plus de 10 dB trop haut.
      bemLoaded: loads.length === onAxis.length,
      distance_m: result.distance_m,
      SR: null,
      Sd_cm2: params.Sd_m2 ? params.Sd_m2 * 1e4 : 0,
      St_cm2: result.meshInfo?.apertureBBox_mm ? estimateBBoxAreaCm2(result.meshInfo.apertureBBox_mm) : 0,
    };
    return;
  }

  splData = {
    freqs: onAxis.map(point => point.f),
    splDb: onAxis.map(point => pressureToSpl(point.p_ref)),
    // Sans driver, la surface est pilotée à vitesse imposée : il n'y a ni
    // membrane ni Xmax, donc aucune excursion à afficher.
    xPeakMm: null,
    xmaxMm: null,
    phaseDeg: onAxis.map(point => point.phaseDeg ?? 0),
    driverName: 'Fixed driving',
    vRMS: drivenSurfaces.length ? `${formatNumber(drivenSurfaces[0].velocity ?? 1)} m/s` : '1 m/s',
    baffleGainDB: 0,
    distance_m: result.distance_m,
    SR: null,
    Sd_cm2: 0,
    St_cm2: result.meshInfo?.apertureBBox_mm ? estimateBBoxAreaCm2(result.meshInfo.apertureBBox_mm) : 0,
  };
}

function pressureToSpl(pressurePa) {
  return 20 * Math.log10(Math.max(Math.abs(pressurePa), 1e-12) / P_REF);
}

// Le SPL est le produit de trois choses qu'aucun graphe ne montre : la charge
// acoustique, la vitesse de membrane et la pression BEM à vitesse unité. Les
// tracer permet de comparer une exécution de l'app au harnais hors-ligne
// (scripts/akabak_compare.mjs) ligne à ligne.
function logSplCoupling(onAxis, loads, splDb, params, vRMS) {
  const rows = onAxis.map((point, i) => ({
    'f (Hz)': Number(point.f.toFixed(2)),
    'Za.re': Number((loads[i]?.re ?? 0).toFixed(3)),
    'Za.im': Number((loads[i]?.im ?? 0).toFixed(3)),
    'S (cm2)': Number(((loads[i]?.area ?? 0) * 1e4).toFixed(1)),
    'v (m/s)': Number(driverVelocityFromTs(params, point.f, vRMS, loads[i] || null).toExponential(3)),
    'p1m (Pa/(m/s))': Number(point.p_ref.toFixed(3)),
    'SPL (dB)': Number(splDb[i].toFixed(2)),
  }));
  console.groupCollapsed(`[BEM SPL] ${rows.length} freqs · U=${vRMS} V · Sd=${((params.Sd_m2 || 0) * 1e4).toFixed(0)} cm² · BEM load: ${loads.length === onAxis.length ? 'yes' : 'MISSING'}`);
  console.table(rows);
  console.groupEnd();
}

/**
 * Vitesse de la membrane sous `voltageRms`, CHARGÉE par l'impédance mécanique
 * de rayonnement `load` (N·s/m) que le BEM vient de calculer.
 *
 * Convention de signe : le solveur travaille en e^{-iωt} (une masse y donne une
 * partie imaginaire NÉGATIVE, vérifié en basse fréquence). Zm et Ze sont donc
 * écrits dans la même convention — comme le fait BeatEngineCoupled.jl du
 * Boundary Lab — sinon la réactance acoustique se retranche de celle du moteur
 * au lieu de s'y ajouter, et la bande de charge du pavillon s'effondre.
 */
function driverVelocityFromTs(params, frequency, voltageRms, load = null) {
  const Bl = params.BL;
  const Re = params.Re;
  const Mms = params.Mms_kg;
  const fs = params.fs;
  if (!(Bl > 0) || !(Re > 0) || !(Mms > 0) || !(fs > 0) || !(voltageRms >= 0)) return 0;
  const w = 2 * Math.PI * Math.max(1e-6, frequency);
  const w0 = 2 * Math.PI * fs;
  const Cms = params.Cms_mPerN > 0 ? params.Cms_mPerN : 1 / (w0 * w0 * Mms);
  const Qms = params.Qms > 0 ? params.Qms : 5;
  const Rms = params.Rms_Nsm > 0 ? params.Rms_Nsm : (w0 * Mms) / Qms;
  const Le = params.Le_H || 0;

  const zmRe = Rms + (load ? load.re : 0);
  const zmIm = -w * Mms + 1 / (w * Cms) + (load ? load.im : 0);
  const zeRe = Re;
  const zeIm = -w * Le;
  const prodRe = zmRe * zeRe - zmIm * zeIm;
  const prodIm = zmRe * zeIm + zmIm * zeRe;
  const denomRe = prodRe + Bl * Bl;
  const denomIm = prodIm;
  const denomAbs = Math.hypot(denomRe, denomIm);
  return denomAbs > 0 ? (Bl * voltageRms) / denomAbs : 0;
}

// Les paramètres bruts de la driver DB sont en cm² (SDf/SDr), g (Mms), mH (Le)
// et mm/N (Cms). La fonction est idempotente : un objet déjà normalisé
// (Sd_m2, Mms_kg, …) repasse sans seconde conversion.
function normalizeBemDriverParams(params = {}, content = '') {
  const parsed = { ...parseBemDriverContent(content), ...(params || {}) };
  const scaled = (already, raw, factor) => {
    const done = firstFinite(already);
    if (done > 0) return done;
    const value = firstFinite(raw);
    return value > 0 ? value * factor : null;
  };
  // SDf = surface avant du cône : c'est elle qui rayonne dans le domaine BEM.
  const sd_cm2 = firstFinite(parsed.SDf, parsed.SD, parsed.Sd, parsed.SDr);
  return {
    Sd_m2: scaled(parsed.Sd_m2, sd_cm2, 1e-4),
    Mms_kg: scaled(parsed.Mms_kg, firstFinite(parsed.Mms, parsed.MMS), 1e-3),
    fs: firstFinite(parsed.fs, parsed.Fs, parsed.FS),
    Qms: firstFinite(parsed.Qms, parsed.QMS),
    Qes: firstFinite(parsed.Qes, parsed.QES),
    Qts: firstFinite(parsed.Qts, parsed.QTS),
    Re: firstFinite(parsed.Re, parsed.RE, parsed.Rdc),
    Znom: firstFinite(parsed.Znom, parsed.Zn, parsed.ZNOM, parsed.Impedance),
    BL: firstFinite(parsed.BL, parsed.Bl, parsed.bl),
    Le_H: scaled(parsed.Le_H, firstFinite(parsed.Le, parsed.LE), 1e-3) || 0,
    Cms_mPerN: scaled(parsed.Cms_mPerN, firstFinite(parsed.Cms, parsed.CMS), 1e-3),
    Rms_Nsm: firstFinite(parsed.Rms_Nsm, parsed.Rms, parsed.RMS),
    // Rarement déclaré dans les fiches : l'interface laisse le saisir à la main.
    Xmax_mm: firstFinite(parsed.Xmax_mm, parsed.Xmax, parsed.XMAX, parsed.xmax),
  };
}

function parseBemDriverContent(content) {
  const out = {};
  if (!content) return out;
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([-+]?\d+(?:[\.,]\d+)?(?:e[-+]?\d+)?)/i);
    if (!match) continue;
    out[match[1]] = parseFloat(match[2].replace(',', '.'));
  }
  return out;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = typeof value === 'string' ? parseFloat(value.replace(',', '.')) : value;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function estimateBBoxAreaCm2(bbox) {
  return Math.max(0, (bbox.width || 0) * (bbox.height || 0) / 100);
}

function formatDriverSummary(params) {
  const bits = [];
  if (params?.Sd_m2) bits.push(`Sd=${(params.Sd_m2 * 1e4).toFixed(0)} cm²`);
  if (params?.fs) bits.push(`Fs=${formatNumber(params.fs)} Hz`);
  if (params?.Re) bits.push(`Re=${formatNumber(params.Re)} Ω`);
  if (params?.BL) bits.push(`BL=${formatNumber(params.BL)}`);
  return bits.join(' · ');
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2).replace(/\.00$/, '') : '0';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

const SPL_SNAPSHOT_COLORS = ['#38bdf8', '#a3e635', '#fbbf24', '#c084fc', '#2dd4bf', '#fb923c', '#f87171', '#94a3b8'];

/**
 * Fige la courbe courante. La copie est autonome — ni le maillage, ni les
 * filtres, ni un nouveau solve ne la touchent — c'est ce qui permet de
 * superposer plusieurs réglages.
 *
 * SPL et excursion sont figés ensemble : ils décrivent le même point de
 * fonctionnement, et les séparer permettrait de comparer un SPL à une
 * excursion obtenue sous une autre tension.
 */
function addSplSnapshot(root) {
  if (!splData?.freqs?.length) return false;
  const active = activeBemFilters().length;
  const volts = typeof splData.vRMS === 'number' ? `${splData.vRMS} V` : String(splData.vRMS);
  splSnapshots.push({
    id: `snap${++splSnapshotSeq}`,
    name: `${volts}${active ? ` · ${active} filter${active > 1 ? 's' : ''}` : ' · flat'}`,
    color: SPL_SNAPSHOT_COLORS[splSnapshots.length % SPL_SNAPSHOT_COLORS.length],
    visible: true,
    freqs: [...splData.freqs],
    splDb: [...splData.splDb],
    xPeakMm: splData.xPeakMm ? [...splData.xPeakMm] : null,
  });
  renderSplSnapshotList(root);
  renderSplCurve(root);
  renderExcursionCurve(root);
  return true;
}

/** Une seule liste de courbes figées, rendue à l'identique dans les deux onglets. */
function renderSplSnapshotList(root) {
  const redraw = () => { renderSplCurve(root); renderExcursionCurve(root); };
  ['#dir-spl-curves', '#dir-exc-curves'].forEach(selector => {
    const host = root.querySelector(selector);
    if (!host) return;
    host.classList.toggle('-hidden', !splSnapshots.length);
    host.innerHTML = splSnapshots.map(snapshot => `<span class="dir-spl-curve" data-id="${escapeHtmlAttr(snapshot.id)}">
        <input type="checkbox" class="-vis"${snapshot.visible === false ? '' : ' checked'} title="Show this curve">
        <input type="color" class="-color" value="${escapeHtmlAttr(snapshot.color)}">
        <input type="text" class="-name" value="${escapeHtmlAttr(snapshot.name)}" title="Rename this curve">
        <button type="button" class="-del" title="Delete this curve">&times;</button>
      </span>`).join('');

    host.querySelectorAll('.dir-spl-curve').forEach(el => {
      const snapshot = splSnapshots.find(s => s.id === el.dataset.id);
      if (!snapshot) return;
      el.querySelector('.-vis').addEventListener('change', e => {
        snapshot.visible = e.target.checked;
        renderSplSnapshotList(root);
      });
      el.querySelector('.-color').addEventListener('input', e => {
        snapshot.color = e.target.value;
        redraw();
      });
      el.querySelector('.-name').addEventListener('input', e => {
        snapshot.name = e.target.value;
        redraw();
      });
      el.querySelector('.-del').addEventListener('click', () => {
        splSnapshots = splSnapshots.filter(s => s.id !== snapshot.id);
        renderSplSnapshotList(root);
      });
    });
  });
  redraw();
}

/**
 * Tracé commun aux graphes SPL et excursion : grille logarithmique en
 * fréquence, ordonnée linéaire, courbes figées sous la courbe vivante.
 * Publie `canvas._layout`, dont le curseur se sert pour relire les coordonnées.
 */
function drawCurveGraph(canvas, spec) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
  const cssH = canvas.clientHeight || 420;
  canvas.width  = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  canvas._layout = null;

  if (!spec.curves.length) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.emptyText, cssW / 2, cssH / 2);
    return null;
  }

  const padL = 60, padR = 20, padT = 28, padB = 42;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const { fMin, fMax, yMin, yMax } = spec;
  const logFMin = Math.log10(fMin);
  const logFMax = Math.log10(fMax);
  const xLog = (f) => padL + (Math.log10(f) - logFMin) / (logFMax - logFMin) * plotW;
  const yMap = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  canvas._layout = { padL, padT, plotW, plotH, logFMin, logFMax, yMin, yMax };

  ctx.font = '11px ui-monospace, monospace';

  const decades = [];
  for (let d = Math.floor(logFMin); d <= Math.ceil(logFMax); d++) {
    for (let m = 1; m <= 9; m++) {
      const f = m * Math.pow(10, d);
      if (f < fMin || f > fMax) continue;
      const x = xLog(f);
      ctx.beginPath();
      ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
      ctx.strokeStyle = (m === 1) ? 'rgba(156, 163, 175, 0.28)' : 'rgba(156, 163, 175, 0.08)';
      ctx.stroke();
      if (m === 1 || m === 2 || m === 5) decades.push({ f, x });
    }
  }
  ctx.fillStyle = '#9ca3af';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const { f, x } of decades) {
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, padT + plotH + 6);
  }

  const stepMinor = spec.minorStep;
  const stepMajor = stepMinor * 2;
  for (let v = Math.ceil(yMin / stepMinor) * stepMinor; v <= yMax + 1e-6; v += stepMinor) {
    const y = yMap(v);
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = (Math.abs(v % stepMajor) < 1e-6) ? 'rgba(156, 163, 175, 0.28)' : 'rgba(156, 163, 175, 0.1)';
    ctx.stroke();
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(yMin / stepMajor) * stepMajor; v <= yMax + 1e-6; v += stepMajor) {
    ctx.fillText(spec.formatTick(v), padL - 6, yMap(v));
  }

  ctx.strokeStyle = 'rgba(156, 163, 175, 0.5)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.fillStyle = '#e5e7eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Frequency (Hz)', padL + plotW / 2, cssH - 8);
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(spec.yLabel, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  if (spec.limit && spec.limit.y > yMin && spec.limit.y < yMax) {
    const y = yMap(spec.limit.y);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = spec.limit.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = spec.limit.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(spec.limit.label, padL + 6, y - 3);
  }

  for (const curve of spec.curves) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < curve.xs.length; i++) {
      const v = curve.ys?.[i];
      if (!Number.isFinite(v)) continue;
      const x = xLog(curve.xs[i]);
      const y = yMap(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = curve.width;
    ctx.stroke();
  }
  ctx.restore();

  // Légende — indispensable dès qu'on superpose des réglages nommés.
  if (spec.curves.length > 1) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    spec.curves.forEach((entry, i) => {
      const y = padT + 12 + i * 15;
      const xRight = padL + plotW - 8;
      ctx.fillStyle = entry.color;
      ctx.fillRect(xRight - 14, y - 1, 12, 2);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(entry.name || '—', xRight - 20, y);
    });
  }

  ctx.fillStyle = '#e5e7eb';
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(spec.title, padL, 8);
  return canvas._layout;
}

function renderSplCurve(root) {
  const canvas = root.querySelector('#dir-spl-canvas');
  const meta   = root.querySelector('#dir-spl-meta');
  if (!canvas) return;
  clearSplOverlay(root);

  const snapshots = splSnapshots.filter(s => s.visible !== false && s.freqs?.length);
  const hasLive = !!splData?.freqs?.length;

  if (meta) {
    if (!hasLive && !snapshots.length) {
      meta.innerHTML = 'Set a surface to <b>Driven</b> and run BEM Preview to compute SPL.';
    } else if (!hasLive) {
      meta.textContent = `${snapshots.length} frozen curve(s) — no live result, run Start Sim.`;
    } else {
      const sourceLabel = splData.driverName === 'Fixed driving'
        ? `${splData.driverName} · v=${splData.vRMS}`
        : `${splData.driverName} · Sd=${(splData.Sd_cm2 || 0).toFixed(0)} cm² · V=${splData.vRMS} V`;
      meta.textContent = `${sourceLabel} · St=${(splData.St_cm2 || 0).toFixed(0)} cm² · obs ${splData.distance_m ?? '?'} m`
        + (splData.bemLoaded === false
          ? ' · NO BEM LOAD in this saved result — re-run Start Sim'
          : ' · loaded by BEM');
    }
  }

  const { fMin, fMax } = getSplFrequencyRange(root);
  const { dbMin, dbMax } = getSplLevelRange(root);
  drawCurveGraph(canvas, {
    fMin, fMax, yMin: dbMin, yMax: dbMax,
    minorStep: splGridStep(dbMax - dbMin),
    formatTick: (v) => `${v}`,
    yLabel: 'SPL (dB, 1 m)',
    title: `SPL @ 1 m · ${splData?.driverName || 'frozen curves'}`,
    emptyText: 'No SPL data — run BEM Preview with a Driven surface.',
    // Les courbes figées passent dessous : la vivante doit rester lisible.
    curves: [
      ...snapshots.map(s => ({ xs: s.freqs, ys: s.splDb, color: s.color, width: 1.5, name: s.name })),
      ...(hasLive ? [{ xs: splData.freqs, ys: splData.splDb, color: '#ec4899', width: 2, name: 'Live' }] : []),
    ],
  });
}

/**
 * Excursion de membrane, crête simple sens, comparée au Xmax.
 *
 * C'est le second garde-fou d'un bass-reflex : l'event décharge la membrane à
 * l'accord, mais sous l'accord la charge disparaît et la course s'emballe. Un
 * passe-haut se juge ici autant que sur le SPL.
 */
function renderExcursionCurve(root) {
  const canvas = root.querySelector('#dir-exc-canvas');
  const meta   = root.querySelector('#dir-exc-meta');
  if (!canvas) return;
  clearExcursionOverlay(root);

  const snapshots = splSnapshots.filter(s => s.visible !== false && s.xPeakMm?.length);
  const hasLive = !!splData?.xPeakMm?.length;
  const xmax = excursionXmaxMm(root);

  if (meta) {
    if (!hasLive && !snapshots.length) {
      meta.textContent = splData
        ? 'Excursion needs a driver: assign one to the diaphragm, then run Start Sim.'
        : 'Assign a driver to the diaphragm and run BEM Preview to compute cone excursion.';
    } else if (!hasLive) {
      meta.textContent = `${snapshots.length} frozen curve(s) — no live result, run Start Sim.`;
    } else {
      const peak = Math.max(...splData.xPeakMm.filter(Number.isFinite));
      const worst = splData.freqs[splData.xPeakMm.indexOf(peak)];
      meta.textContent = `${splData.driverName} · V=${splData.vRMS} V · peak ${peak.toFixed(2)} mm at ${formatFrequency(worst, true)}`
        + (xmax ? ` · Xmax ${xmax} mm${peak > xmax ? ' — EXCEEDED' : ''}` : ' · no Xmax declared');
    }
  }

  const { fMin, fMax } = getExcursionFrequencyRange(root);
  const mmMax = getExcursionScale(root);
  drawCurveGraph(canvas, {
    fMin, fMax, yMin: 0, yMax: mmMax,
    minorStep: excursionGridStep(mmMax),
    formatTick: (v) => (mmMax <= 2 ? v.toFixed(2) : mmMax <= 20 ? v.toFixed(1) : v.toFixed(0)),
    yLabel: 'Excursion (mm, one-way peak)',
    title: `Cone excursion · ${splData?.driverName || 'frozen curves'}`,
    emptyText: 'No excursion data — a driver must be assigned to the diaphragm.',
    limit: xmax ? { y: xmax, color: '#f87171', label: `Xmax ${xmax} mm` } : null,
    curves: [
      ...snapshots.map(s => ({ xs: s.freqs, ys: s.xPeakMm, color: s.color, width: 1.5, name: s.name })),
      ...(hasLive ? [{ xs: splData.freqs, ys: splData.xPeakMm, color: '#ec4899', width: 2, name: 'Live' }] : []),
    ],
  });
}

/** Xmax retenu : la saisie manuelle prime sur la valeur de la fiche driver. */
function excursionXmaxMm(root) {
  const typed = parseFloat(root.querySelector('#dir-exc-xmax')?.value);
  if (Number.isFinite(typed) && typed > 0) return typed;
  return splData?.xmaxMm > 0 ? splData.xmaxMm : null;
}

function excursionGridStep(span) {
  if (span <= 1) return 0.1;
  if (span <= 2.5) return 0.25;
  if (span <= 6) return 0.5;
  if (span <= 12) return 1;
  if (span <= 30) return 2.5;
  return 5;
}

function splGridStep(span) {
  if (span <= 12) return 1;
  if (span <= 30) return 2.5;
  if (span <= 60) return 5;
  if (span <= 120) return 10;
  return 20;
}

/** Fenêtre fréquentielle du graphe SPL : champs de la barre d'outils, sinon plage de simulation. */
function getSplFrequencyRange(root) {
  const bounds = getSimulationFrequencyRange();
  const rawMin = parseFloat(root.querySelector('#dir-spl-fmin')?.value);
  const rawMax = parseFloat(root.querySelector('#dir-spl-fmax')?.value);
  const fMin = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : bounds.fMin;
  const fMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : bounds.fMax;
  return fMax > fMin ? { fMin, fMax } : bounds;
}

/** Fenêtre en niveau du graphe SPL (par défaut 70–120 dB). */
function getSplLevelRange(root) {
  const rawMin = parseFloat(root.querySelector('#dir-spl-dbmin')?.value);
  const rawMax = parseFloat(root.querySelector('#dir-spl-dbmax')?.value);
  const dbMin = Number.isFinite(rawMin) ? rawMin : DEFAULT_SPL_DB_MIN;
  const dbMax = Number.isFinite(rawMax) ? rawMax : DEFAULT_SPL_DB_MAX;
  return dbMax > dbMin ? { dbMin, dbMax } : { dbMin: DEFAULT_SPL_DB_MIN, dbMax: DEFAULT_SPL_DB_MAX };
}

/** Recadre les champs sur les données affichées, courbes figées comprises. */
function autoscaleSplControls(root) {
  const curves = [
    ...(splData?.freqs?.length ? [splData] : []),
    ...splSnapshots.filter(s => s.visible !== false && s.freqs?.length),
  ];
  if (!curves.length) return;
  let yMin = Infinity, yMax = -Infinity, fMin = Infinity, fMax = -Infinity;
  for (const curve of curves) {
    for (const v of curve.splDb) {
      if (!Number.isFinite(v)) continue;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    fMin = Math.min(fMin, curve.freqs[0]);
    fMax = Math.max(fMax, curve.freqs[curve.freqs.length - 1]);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
  yMin = Math.floor((yMin - 5) / 5) * 5;
  yMax = Math.ceil((yMax + 5) / 5) * 5;
  if (yMax - yMin < 20) yMax = yMin + 20;
  const fminEl = root.querySelector('#dir-spl-fmin');
  const fmaxEl = root.querySelector('#dir-spl-fmax');
  if (fminEl) fminEl.value = String(Math.round(fMin));
  if (fmaxEl) fmaxEl.value = String(Math.round(fMax));
  const dbminEl = root.querySelector('#dir-spl-dbmin');
  const dbmaxEl = root.querySelector('#dir-spl-dbmax');
  if (dbminEl) dbminEl.value = String(yMin);
  if (dbmaxEl) dbmaxEl.value = String(yMax);
}

/** Fenêtre fréquentielle du graphe d'excursion. */
function getExcursionFrequencyRange(root) {
  const bounds = getSimulationFrequencyRange();
  const rawMin = parseFloat(root.querySelector('#dir-exc-fmin')?.value);
  const rawMax = parseFloat(root.querySelector('#dir-exc-fmax')?.value);
  const fMin = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : bounds.fMin;
  const fMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : bounds.fMax;
  return fMax > fMin ? { fMin, fMax } : bounds;
}

/** Pleine échelle du graphe d'excursion, en mm. */
function getExcursionScale(root) {
  const raw = parseFloat(root.querySelector('#dir-exc-mmmax')?.value);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXC_MM_MAX;
}

/** Recadre le graphe d'excursion, en gardant le Xmax dans le cadre. */
function autoscaleExcursionControls(root) {
  const curves = [
    ...(splData?.xPeakMm?.length ? [splData] : []),
    ...splSnapshots.filter(s => s.visible !== false && s.xPeakMm?.length),
  ];
  if (!curves.length) return;
  let yMax = -Infinity, fMin = Infinity, fMax = -Infinity;
  for (const curve of curves) {
    for (const v of curve.xPeakMm) {
      if (Number.isFinite(v) && v > yMax) yMax = v;
    }
    fMin = Math.min(fMin, curve.freqs[0]);
    fMax = Math.max(fMax, curve.freqs[curve.freqs.length - 1]);
  }
  if (!Number.isFinite(yMax)) return;
  // Le Xmax est la référence de lecture : le laisser hors cadre rendrait le
  // graphe inutilisable au moment précis où il compte.
  yMax = Math.max(yMax, excursionXmaxMm(root) || 0) * 1.15;
  const step = excursionGridStep(yMax);
  const fminEl = root.querySelector('#dir-exc-fmin');
  const fmaxEl = root.querySelector('#dir-exc-fmax');
  if (fminEl) fminEl.value = String(Math.round(fMin));
  if (fmaxEl) fmaxEl.value = String(Math.round(fMax));
  const mmEl = root.querySelector('#dir-exc-mmmax');
  if (mmEl) mmEl.value = String(Number((Math.ceil(yMax / step) * step).toFixed(3)));
}

function clearExcursionOverlay(root) {
  const overlay = root.querySelector('#dir-exc-overlay');
  const readout = root.querySelector('#dir-exc-readout');
  if (overlay?.isConnected) {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  if (readout) readout.innerHTML = '&mdash;';
}

function clearSplOverlay(root) {
  const overlay = root.querySelector('#dir-spl-overlay');
  const readout = root.querySelector('#dir-spl-readout');
  if (overlay?.isConnected) {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  if (readout) readout.innerHTML = '&mdash;';
}

/** Curseur du graphe SPL : réticule + lecture Hz/dB, comme sur la Directivity Map. */
function setupSplHover(root) {
  const canvas  = root.querySelector('#dir-spl-canvas');
  const overlay = root.querySelector('#dir-spl-overlay');
  const readout = root.querySelector('#dir-spl-readout');
  if (!canvas || !overlay) return;

  canvas.addEventListener('mousemove', (e) => {
    const layout = canvas._layout;
    if (!layout || !splData?.freqs?.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { padL, padT, plotW, plotH, logFMin, logFMax, yMin, yMax } = layout;
    if (x < padL || x > padL + plotW || y < padT || y > padT + plotH) {
      if (readout) readout.innerHTML = '&mdash;';
      return;
    }
    const f = Math.pow(10, logFMin + (x - padL) / plotW * (logFMax - logFMin));
    const cursorDb = yMax - (y - padT) / plotH * (yMax - yMin);
    const curveDb = splAt(f);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    if (Number.isFinite(curveDb)) {
      const cy = padT + (1 - (curveDb - yMin) / (yMax - yMin)) * plotH;
      if (cy >= padT && cy <= padT + plotH) {
        ctx.fillStyle = '#ec4899';
        ctx.beginPath();
        ctx.arc(x, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (readout) {
      readout.innerHTML =
        `<span style="color:#f9a8d4">${formatFrequency(f, true)}</span>` +
        ` &middot; <span style="color:#fcd34d">${cursorDb.toFixed(1)} dB</span>` +
        (Number.isFinite(curveDb) ? ` &middot; <span style="color:#6ee7b7">SPL ${curveDb.toFixed(1)} dB</span>` : '');
    }
  });

  canvas.addEventListener('mouseleave', () => clearSplOverlay(root));
}

/** Niveau SPL interpolé (log-fréquence) à la fréquence demandée. */
function splAt(f) {
  return curveValueAt(splData?.freqs, splData?.splDb, f);
}

function curveValueAt(freqs, values, f) {
  if (!freqs?.length || !values?.length) return NaN;
  if (f <= freqs[0] || f >= freqs[freqs.length - 1]) {
    const v = f <= freqs[0] ? values[0] : values[values.length - 1];
    return Number.isFinite(v) ? v : NaN;
  }
  let i = 1;
  while (i < freqs.length - 1 && freqs[i] < f) i++;
  const f0 = freqs[i - 1], f1 = freqs[i];
  const v0 = values[i - 1], v1 = values[i];
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return NaN;
  const t = (Math.log10(f) - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0));
  return v0 + t * (v1 - v0);
}

/** Curseur du graphe d'excursion : réticule, lecture Hz/mm et marge au Xmax. */
function setupExcursionHover(root) {
  const canvas  = root.querySelector('#dir-exc-canvas');
  const overlay = root.querySelector('#dir-exc-overlay');
  const readout = root.querySelector('#dir-exc-readout');
  if (!canvas || !overlay) return;

  canvas.addEventListener('mousemove', (e) => {
    const layout = canvas._layout;
    if (!layout || !splData?.xPeakMm?.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { padL, padT, plotW, plotH, logFMin, logFMax, yMin, yMax } = layout;
    if (x < padL || x > padL + plotW || y < padT || y > padT + plotH) {
      if (readout) readout.innerHTML = '&mdash;';
      return;
    }
    const f = Math.pow(10, logFMin + (x - padL) / plotW * (logFMax - logFMin));
    const curveMm = curveValueAt(splData.freqs, splData.xPeakMm, f);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    if (Number.isFinite(curveMm)) {
      const cy = padT + (1 - (curveMm - yMin) / (yMax - yMin)) * plotH;
      if (cy >= padT && cy <= padT + plotH) {
        ctx.fillStyle = '#ec4899';
        ctx.beginPath();
        ctx.arc(x, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (readout) {
      const xmax = excursionXmaxMm(root);
      // La marge en dB est la seule lecture directement actionnable : c'est de
      // combien on peut monter le niveau avant de taper dans la butée.
      const headroom = xmax && curveMm > 0 ? 20 * Math.log10(xmax / curveMm) : NaN;
      readout.innerHTML =
        `<span style="color:#f9a8d4">${formatFrequency(f, true)}</span>` +
        (Number.isFinite(curveMm) ? ` &middot; <span style="color:#6ee7b7">${curveMm.toFixed(2)} mm</span>` : '') +
        (Number.isFinite(headroom)
          ? ` &middot; <span style="color:${headroom < 0 ? '#f87171' : '#fcd34d'}">${headroom >= 0 ? '+' : ''}${headroom.toFixed(1)} dB to Xmax</span>`
          : '');
    }
  });

  canvas.addEventListener('mouseleave', () => clearExcursionOverlay(root));
}

