// =======================================================
// FICHIER :  scripts/bem_port_velocity.mjs
// RÔLE    :  Bout-en-bout de la carte de VITESSE D'AIR : rejoue un .TBBS dans
//            le worker avec `withVelocity`, puis rapporte la vitesse de crête
//            sur chaque nappe, ramenée en m/s réels par le couplage T&S — le
//            chiffre qui décide si un event souffle.
//
//  Usage : node scripts/bem_port_velocity.mjs [study.TBBS] [f1,f2,…] [volts]
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
const study = JSON.parse(readFileSync(studyPath, 'utf8'));
const freqs = (process.argv[3] || '30,45,60').split(',').map(Number);
const volts = Number(process.argv[4] || study.driveVrms || 2.83);

const { buildFieldGeometry } = new Function(
  `${readFileSync(join(root, 'src/js/panels/bemsolver/fieldGeometry.js'), 'utf8').replace(/^export function/gm, 'function')}
   return { buildFieldGeometry };`
)();

const { config, driverParams, driverName } = buildConfigFromStudy(study, study.mesh);

const fieldNodes = (study.tree || []).filter(it => it.kind === 'Field');
if (!fieldNodes.length) throw new Error('Ce .TBBS ne contient aucun field — ajoutez un plan dans le panneau.');
const fields = fieldNodes.map(item => {
  const geom = buildFieldGeometry(item);
  return {
    id: item.id, name: item.name, type: item.fieldType,
    withVelocity: true, points_mm: geom.points, geom,
  };
});
console.log(`${fields.length} nappe(s) : ${fields.map(f => `${f.name} (${f.points_mm.length} pts)`).join(', ')}`);

// ---- Worker hors Electron ----
let done = null, errorMessage = null;
const selfStub = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'done') done = msg.result;
    if (msg.type === 'error') errorMessage = msg.message;
  },
};
const ctx = vm.createContext({ console, performance, self: selfStub });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js', 'src/js/bem/bemGalerkin.js', 'src/js/bem/bemDomainWorker.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}
selfStub.onmessage({ data: {
  type: 'computeDomain', id: 'v', mshContent: study.mesh, config,
  opts: { freqs, distance_m: 1, angleStep: 30, angleMax: 90, fields },
} });
if (errorMessage) { console.error('worker error:', errorMessage); process.exit(1); }

// ---- Couplage moteur : le BEM tourne à vitesse de membrane unité ----
function coneVelocityRms(params, f, vRms, load) {
  const Bl = params.BL, Re = params.Re, Mms = params.Mms_kg, w = 2 * Math.PI * f;
  const w0 = 2 * Math.PI * params.fs;
  const Cms = params.Cms_mPerN || 1 / (w0 * w0 * Mms);
  const Rms = params.Rms_Nsm || (w0 * Mms) / (params.Qms > 0 ? params.Qms : 5);
  const Le = params.Le_H || 0;
  const zmRe = Rms + (load ? load.re : 0);
  const zmIm = -w * Mms + 1 / (w * Cms) + (load ? load.im : 0);
  const dRe = zmRe * Re - zmIm * (-w * Le) + Bl * Bl;
  const dIm = zmRe * (-w * Le) + zmIm * Re;
  return Bl * vRms / Math.hypot(dRe, dIm);
}

/** Demi-grand axe de l'ellipse décrite par v(t) = Re(v̂)·cos + Im(v̂)·sin. */
function peakSpeed(vRe, vIm, i, s) {
  const ax = vRe[3*i]*s, ay = vRe[3*i+1]*s, az = vRe[3*i+2]*s;
  const bx = vIm[3*i]*s, by = vIm[3*i+1]*s, bz = vIm[3*i+2]*s;
  const a2 = ax*ax+ay*ay+az*az, b2 = bx*bx+by*by+bz*bz, ab = ax*bx+ay*by+az*bz;
  return Math.sqrt(Math.max(0, (a2+b2)/2 + Math.hypot((a2-b2)/2, ab)));
}

const watts = driverParams?.Re > 0 ? (volts * volts) / driverParams.Re : 0;
console.log(`\ndriver ${driverName} · ${volts} V rms (${watts.toFixed(1)} W) · limite de souffle usuelle 17 m/s\n`);
console.log('  nappe                f(Hz)   v_cône(mm/s)   v_air crête(m/s)   v_air rms   Mach   masqués   état');
for (const res of done.fieldResults) {
  const i = done.freqs.indexOf(res.f);
  const vCone = coneVelocityRms(driverParams, res.f, volts, (done.drivenLoad || [])[i] || null);
  const scale = vCone * Math.SQRT2;                     // amplitude crête
  let peak = 0, masked = 0;
  for (let p = 0; p < res.mag.length; p++) {
    const s = peakSpeed(res.vRe, res.vIm, p, scale);
    if (Number.isFinite(s)) peak = Math.max(peak, s);
    else masked++;                                       // point collé à une paroi
  }
  const state = peak > 17 ? 'SOUFFLE' : peak > 12 ? 'limite' : 'propre';
  console.log(`  ${res.name.padEnd(18)} ${res.f.toFixed(1).padStart(7)} ${(vCone*1000).toFixed(1).padStart(13)} `
    + `${peak.toFixed(2).padStart(17)} ${(peak/Math.SQRT2).toFixed(2).padStart(11)} ${(peak/344).toFixed(3).padStart(7)} `
    + `${String(masked).padStart(9)}   ${state}`);
}
