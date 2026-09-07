// =======================================================
// FICHIER :  scripts/foam_coupling_validate.mjs
// RÔLE    :  Couplage bout-en-bout BEM → CFD : le BEM fixe le débit de l'event,
//            OpenFOAM résout Navier-Stokes dedans, et le résultat est
//            échantillonné sur les points réels du Field.
// USAGE   :  node scripts/foam_coupling_validate.mjs [draft|normal] [cores] [freq] [volts]
// =======================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildConfigFromStudy } from './lib/tbbs_config.mjs';
import { resolveDataFile } from './lib/env_paths.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const ventRun = require(path.join(repo, 'src', 'ipc', 'foamVentRun.js'));

const quality = process.argv[2] || 'draft';
const cores = process.argv[3] ? parseInt(process.argv[3], 10) : 8;
const FREQ = Number(process.argv[4] || 40);
const VOLTS = Number(process.argv[5] || 2.83);

let failures = 0;
function check(label, condition, detail = '') {
    if (!condition) failures++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
}

const study = JSON.parse(fs.readFileSync(resolveDataFile('DEV-BEM/8br40.TBBS', { explicit: process.argv[2] }), 'utf8'));
const volts = VOLTS;

const { buildFieldGeometry } = new Function(
    `${fs.readFileSync(path.join(repo, 'src/js/panels/bemsolver/fieldGeometry.js'), 'utf8')
        .replace(/^export function/gm, 'function')}
     return { buildFieldGeometry };`
)();

// ---------- 1. BEM : quel débit l'acoustique impose-t-elle à l'event ? ----------
console.log(`=== BEM — débit d'event à ${FREQ} Hz sous ${volts} V rms ===`);
const { config, driverParams, driverName } = buildConfigFromStudy(study, study.mesh);

let done = null, errorMessage = null;
const selfStub = {
    onmessage: null,
    postMessage(msg) {
        if (msg.type === 'done') done = msg.result;
        if (msg.type === 'error') errorMessage = msg.message;
    },
};
const ctx = vm.createContext({ console, performance, self: selfStub });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js',
    'src/js/bem/bemGalerkin.js', 'src/js/bem/bemDomainWorker.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, f), 'utf8'), ctx, { filename: f });
}
selfStub.onmessage({
    data: {
        type: 'computeDomain', id: 'c', mshContent: study.mesh, config,
        opts: { freqs: [FREQ], distance_m: 1, angleStep: 30, angleMax: 90, fields: [], flowSurfaces: ['p:1'] },
    },
});
if (errorMessage) { console.error('worker error:', errorMessage); process.exit(1); }

function coneVelocityRms(p, f, vRms, load) {
    const w = 2 * Math.PI * f, w0 = 2 * Math.PI * p.fs;
    const Cms = p.Cms_mPerN || 1 / (w0 * w0 * p.Mms_kg);
    const Rms = p.Rms_Nsm || (w0 * p.Mms_kg) / (p.Qms > 0 ? p.Qms : 5);
    const Le = p.Le_H || 0;
    const zmRe = Rms + (load ? load.re : 0);
    const zmIm = -w * p.Mms_kg + 1 / (w * Cms) + (load ? load.im : 0);
    const dRe = zmRe * p.Re - zmIm * (-w * Le) + p.BL * p.BL;
    const dIm = zmRe * (-w * Le) + zmIm * p.Re;
    return p.BL * vRms / Math.hypot(dRe, dIm);
}

const flow = done.surfaceFlow[0];
const vCone = coneVelocityRms(driverParams, FREQ, volts, done.drivenLoad[0]);
const uv = Math.hypot(flow.re, flow.im);
// Le BEM tourne à vitesse de membrane unité: on remet l'échelle, puis on passe
// en amplitude crête, qui est ce qu'attend la condition d'entrée sinusoïdale.
const U0 = Math.SQRT2 * vCone * uv / flow.area;
console.log(`  ${driverName} · v_cône ${(vCone * 1000).toFixed(1)} mm/s · |Uv| ${uv.toExponential(3)} · `
    + `section ${(flow.area * 1e4).toFixed(1)} cm²`);
check('vitesse d\'event exploitable', U0 > 0.01 && U0 < 100, `U0 = ${U0.toFixed(2)} m/s crête`);
// pimpleFoam est incompressible: au-delà de Mach 0,3 le modèle lui-même est faux,
// et le pas de temps imposé par le Courant s'effondre.
check('régime compatible avec un solveur incompressible', U0 / 344 < 0.3,
    `Mach ${(U0 / 344).toFixed(3)}`);

// ---------- 2. Les points du Field deviennent les sondes CFD ----------
const fieldItem = (study.tree || []).find(it => it.kind === 'Field');
check('le projet contient un Field', !!fieldItem, fieldItem?.name);
const geom = buildFieldGeometry(fieldItem);
const probePoints_mm = geom.points;
console.log(`\n=== Field « ${fieldItem.name} » — ${probePoints_mm.length} points sondés ===`);

// ---------- 3. CFD ----------
console.log(`\n=== OpenFOAM (${quality}, ${cores} cœurs) ===`);
const t0 = Date.now();
const res = await ventRun.runVentCase({
    mshContent: study.mesh,
    groups: { wall: ['p:3'], inlet: ['p:1'], outlet: ['p:5'] },
    mirrorAxis: study.symmetry === 'v' ? 0 : null,
    frequency_Hz: FREQ,
    inletVelocity_ms: U0,
    probePoints_mm,
    periods: 2,
    quality,
    cores,
}, {
    workDir: path.join(repo, '.foam-work', 'coupling'),
    onProgress: ({ phase, detail }) => console.log(`  … ${phase}: ${detail}`),
});

check('le couplage aboutit', res.ok, res.reason || `${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!res.ok) {
    if (res.log) console.log('\n--- sortie brute ---\n' + res.log);
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log(`  maillage ${res.reusedMesh ? 'réutilisé' : 'reconstruit'} · `
    + `${res.cells?.toLocaleString('fr-FR') ?? '?'} cellules · ${res.elapsed_s.toFixed(1)} s`);

// ---------- 4. Le résultat a-t-il un sens ? ----------
console.log('\n=== Champ rendu au Field ===');
const nValid = res.valid.filter(Boolean).length;
check('l\'indexation des sondes est préservée', res.positions.length === probePoints_mm.length,
    `${res.positions.length} / ${probePoints_mm.length}`);
check('une partie du plan tombe dans le conduit', nValid > 20 && nValid < probePoints_mm.length,
    `${nValid} points dans le fluide sur ${probePoints_mm.length}`);

let peakMax = 0, turbMax = 0, meanMax = 0;
for (let i = 0; i < res.valid.length; i++) {
    if (!res.valid[i]) continue;
    peakMax = Math.max(peakMax, res.peak[i]);
    turbMax = Math.max(turbMax, res.turbulence[i]);
    meanMax = Math.max(meanMax, Math.hypot(res.vMean[3 * i], res.vMean[3 * i + 1], res.vMean[3 * i + 2]));
}
check('les points hors conduit sont bien masqués',
    res.valid.some(v => !v) && [...res.peak].every(Number.isFinite));
// L'écoulement accélère dans la section rétrécie: la crête dépasse l'entrée
// sans exploser, sinon c'est que le solveur a divergé.
check('crête cohérente avec l\'entrée', peakMax > U0 * 0.5 && peakMax < U0 * 5,
    `crête ${peakMax.toFixed(2)} m/s pour ${U0.toFixed(2)} m/s imposés`);
check('turbulence bornée', turbMax >= 0 && turbMax < peakMax,
    `${turbMax.toFixed(3)} m/s`);
console.log(`  écoulement moyen max ${meanMax.toFixed(3)} m/s`
    + `  ·  souffle ${peakMax > 17 ? 'PROBABLE' : 'improbable'} (seuil 17 m/s)`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
