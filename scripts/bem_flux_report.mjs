// =======================================================
// scripts/bem_flux_report.mjs
//
// Débit volumique (m³/s) rayonné par CHAQUE surface du domaine extérieur, à
// vitesse de diaphragme unité. C'est le seul diagnostic qui dise si la bouche
// d'une ligne de transmission travaille EN PHASE ou EN OPPOSITION avec le cône
// — un signe d'interface à l'envers ne se voit nulle part ailleurs.
//
// Usage : node scripts/bem_flux_report.mjs <study.TBBS> [f1,f2,...] [convention]
// =======================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildConfigFromStudy } from './lib/tbbs_config.mjs';
import { resolveDataFile } from './lib/env_paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const studyPath = resolveDataFile('AKABAK CURVES/ESW1018.TBBS', { explicit: process.argv[2] });
const freqs = (process.argv[3] || '30,45,63,100').split(',').map(Number);
const study = JSON.parse(readFileSync(studyPath, 'utf8'));
const { config } = buildConfigFromStudy(study, study.mesh);
if (process.argv[4]) config.normalConvention = process.argv[4];

const ctx = vm.createContext({ console, performance });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js', 'src/js/bem/bemGalerkin.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}
const api = vm.runInContext(`({
  buildMultiDomainModel, pickRadiatingDomain, domainMirrors, complexLUSolve, C_AIR,
  galerkinNodeTable, solveMultiDomainGalerkin, galerkinNodalQ, galerkinFieldPressure,
})`, ctx);

const RHO = 1.2;
const model = api.buildMultiDomainModel(study.mesh, config);
const nodesArr = api.galerkinNodeTable(model);
const radiating = api.pickRadiatingDomain(model);
const mirrors = api.domainMirrors(model, radiating);
const deps = { domainMirrors: api.domainMirrors, complexLUSolve: api.complexLUSolve, C_AIR: api.C_AIR };

const label = (el) => el.diaphragmId ? `d:${el.diaphragmId}`
  : (el.physicalTag != null ? `p:${el.physicalTag}` : `e:${el.elementaryTag}`);

console.log(`convention=${model.normalConvention} · domaine rayonnant = ${radiating.name} · mirrors=${mirrors.length}`);
for (const c of model.interfaceChecks || []) {
  console.log(`  interface "${c.name}" ${c.fromName}→${c.toName} : normale vers le From = ${c.pointsToFrom}`);
}

for (const f of freqs) {
  const omega = 2 * Math.PI * f;
  const k = omega / api.C_AIR;
  const sol = api.solveMultiDomainGalerkin(f, model, deps, { nodesArr });
  // Q = ∫ v_n dS avec q = -i·ω·ρ·v_n (cf. galerkinNodalQ) ; le signe est celui
  // de la normale SORTANTE du domaine, donc Q > 0 = air expulsé vers l'extérieur.
  const groups = new Map();
  for (const j of radiating.elemIdx) {
    const el = model.elements[j];
    const key = label(el);
    const g = groups.get(key) || { re: 0, im: 0 };
    const w = el.area / 3;
    for (let li = 0; li < 3; li++) {
      const q = api.galerkinNodalQ(model, radiating, j, li, sol.qIndex, sol.qArr, omega);
      g.re += w * (-q.im) / (omega * RHO);
      g.im += w * (q.re) / (omega * RHO);
    }
    groups.set(key, g);
  }
  let tRe = 0, tIm = 0;
  const parts = [];
  for (const [key, g] of groups) {
    const re = g.re * model.mirrorCount, im = g.im * model.mirrorCount;
    tRe += re; tIm += im;
    parts.push(`${key}=${Math.hypot(re, im).toExponential(2)}@${(Math.atan2(im, re) * 180 / Math.PI).toFixed(0)}°`);
  }
  const p = api.galerkinFieldPressure([0, 0, 1], model, nodesArr, radiating, k, omega,
    sol.pIndex, sol.qIndex, sol.pArr, sol.qArr, mirrors);
  console.log(`${String(f).padStart(6)} Hz  Qtot=${Math.hypot(tRe, tIm).toExponential(2)}@${(Math.atan2(tIm, tRe) * 180 / Math.PI).toFixed(0)}°  ` +
    `p(0,0,1m)=${Math.hypot(p.re, p.im).toFixed(3)} Pa   ${parts.join('  ')}`);
}
