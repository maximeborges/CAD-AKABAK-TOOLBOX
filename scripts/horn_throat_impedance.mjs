// =======================================================
// scripts/horn_throat_impedance.mjs
//
// Isole le PAVILLON du reste du modèle : la gorge (Itf_Throat) devient une
// surface pilotée, la bouche reste sur l'extérieur bafflé. On en tire
// l'impédance acoustique de gorge Z = p̄/Q, qu'on compare à la théorie 1-D
// (matrice de transfert sur le profil réel + rayonnement de piston bafflé).
// C'est l'arbitre : il ne dépend d'aucun couplage driver ni du diaphragme.
//
// Usage : node scripts/horn_throat_impedance.mjs [study.TBBS]
// =======================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { resolveDataFile } from './lib/env_paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const study = JSON.parse(readFileSync(resolveDataFile('AKABAK CURVES/horn.TBBS', { explicit: process.argv[2] }), 'utf8'));

const C = 344, RHO = 1.21;

// ---- BEM : pavillon seul ----
let doneResult = null, errorMessage = null;
const selfStub = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'done') doneResult = msg.result;
    if (msg.type === 'error') errorMessage = msg.message;
    if (msg.type === 'progress' && msg.ev.phase === 'meshReady') {
      const mi = msg.ev.meshInfo;
      console.log(`mesh : ${mi.elementCount} él., ${mi.unknowns} inconnues, volumes ${mi.volumes.map(v => `${v.name}=${v.litres.toFixed(3)}L`).join(' ')}`);
    }
  },
};
const ctx = vm.createContext({ console, performance, self: selfStub });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js', 'src/js/bem/bemGalerkin.js', 'src/js/bem/bemDomainWorker.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}

const config = {
  symmetry: study.symmetry,
  subdomains: [
    { id: 'horn', name: 'Horn', type: 'interior', baffle: false, surfaces: [
      { surfaceId: 'p:1', role: 'boundary' },
      { surfaceId: 'p:2', role: 'boundary' },
      { surfaceId: 'p:3', role: 'driven', velocity: 1 },
    ] },
    { id: 'ext', name: 'Air', type: 'exterior', baffle: true, baffleAxis: '+z', baffleOffset_mm: 0, surfaces: [] },
  ],
  interfaces: [{ id: 'mouth', name: 'Mouth', fromId: 'horn', toId: 'ext', surfaces: [{ surfaceId: 'p:5' }] }],
  diaphragms: [],
};

const freqs = [];
for (let i = 0; i <= 20; i++) freqs.push(Math.pow(2, Math.log2(100) + (i / 20) * Math.log2(10)));

selfStub.onmessage({ data: { type: 'computeDomain', id: 'z', mshContent: study.mesh, config,
  opts: { freqs, distance_m: 1, angleStep: 45, angleMax: 90 } } });
if (errorMessage) { console.error('worker:', errorMessage); process.exit(1); }

// ---- Théorie 1-D : matrice de transfert sur le profil rectangulaire réel ----
// Sections du .msh : 80x40 @ z=-350, 223.3x135 @ z=-106.6, 350x230 @ z=0 (mm),
// interpolation LINÉAIRE des cotes (vérifiée sur les nœuds intermédiaires).
const STATIONS = [
  { z: -350, w: 80, h: 40 },
  { z: -106.6, w: 223.3, h: 135 },
  { z: 0, w: 350, h: 230 },
];
function areaAt(z_mm) {
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    if (z_mm >= a.z && z_mm <= b.z) {
      const t = (z_mm - a.z) / (b.z - a.z);
      return (a.w + t * (b.w - a.w)) * (a.h + t * (b.h - a.h)) * 1e-6;
    }
  }
  return STATIONS[STATIONS.length - 1].w * STATIONS[STATIONS.length - 1].h * 1e-6;
}

function besselJ1(x) {
  if (x === 0) return 0;
  const y = x * x;
  const p1 = x * (72362614232 + y * (-7895059235 + y * (242396853.1 + y * (-2972611.439 + y * (15704.4826 + y * (-30.16036606))))));
  const p2 = 144725228442 + y * (2300535178 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
  return p1 / p2;
}
function gammaFn(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * a;
}
function struveH1(z) {
  const h = z / 2, h2 = h * h;
  let sum = 0, pow = 1;
  for (let k = 0; k < 80; k++) {
    const term = ((k % 2 === 0) ? 1 : -1) * pow / (gammaFn(k + 1.5) * gammaFn(k + 2.5));
    sum += term;
    if (Math.abs(term) < 1e-18 * Math.abs(sum) && k > 3) break;
    pow *= h2;
  }
  return h2 * sum;
}

const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cdiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};

/** Impédance acoustique de gorge par matrice de transfert (N tranches). */
function throatImpedance1D(f, N = 800) {
  const k = 2 * Math.PI * f / C;
  const S_mouth = areaAt(0);
  const a = Math.sqrt(S_mouth / Math.PI);
  const w = 2 * k * a;
  let Z = [RHO * C / S_mouth * (1 - 2 * besselJ1(w) / w), RHO * C / S_mouth * (2 * struveH1(w) / w)];

  const z0 = -350, z1 = 0, dz = (z1 - z0) / N;
  for (let i = N - 1; i >= 0; i--) {
    const S = areaAt(z0 + (i + 0.5) * dz);
    const Zc = RHO * C / S;
    const t = Math.tan(k * dz * 1e-3);
    const num = [Z[0], Z[1] + Zc * t];
    const den = [Zc - Z[1] * t, Z[0] * t];
    Z = cmul([Zc, 0], cdiv(num, den));
  }
  return Z;
}

const S_throat = areaAt(-350);
console.log(`\ngorge = ${(S_throat * 1e4).toFixed(1)} cm²   bouche = ${(areaAt(0) * 1e4).toFixed(1)} cm²`);
console.log(`ρc/S_gorge = ${(RHO * C / S_throat).toExponential(3)} Pa·s/m³\n`);
console.log('   f(Hz)   BEM Re    BEM -Im      1D Re     1D Im   (normalisés par rho·c/S_gorge)');

const norm = RHO * C / S_throat;
doneResult.onAxis.forEach((pt, i) => {
  const ld = doneResult.drivenLoad[i];
  const S = ld.area;
  // Convention e^{-iωt} du solveur : une masse y donne Im<0, d'où le signe.
  const zRe = ld.re / (S * S), zIm = -ld.im / (S * S);
  const z1d = throatImpedance1D(pt.f);
  console.log(`${pt.f.toFixed(1).padStart(8)} ${(zRe / norm).toFixed(3).padStart(9)} ${(zIm / norm).toFixed(3).padStart(9)} ` +
    `${(z1d[0] / norm).toFixed(3).padStart(10)} ${(z1d[1] / norm).toFixed(3).padStart(9)}`);
});
