// =======================================================
// FICHIER :  scripts/bem_vent_flow_validate.mjs
// RÔLE    :  Valide le débit volumique acoustique remonté par le solveur BEM
//            sur les deux bouches de l'event, et en déduit la vitesse à
//            imposer à l'entrée du calcul CFD.
// USAGE   :  node scripts/bem_vent_flow_validate.mjs [study.TBBS] [f1,f2,...] [volts]
// =======================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildConfigFromStudy } from './lib/tbbs_config.mjs';
import { resolveDataFile } from './lib/env_paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const studyPath = resolveDataFile('DEV-BEM/8br40.TBBS', { explicit: process.argv[2] });
const study = JSON.parse(readFileSync(studyPath, 'utf8'));
const freqs = (process.argv[3] || '30,40,50').split(',').map(Number);
const volts = Number(process.argv[4] || study.driveVrms || 2.83);

let failures = 0;
function check(label, condition, detail = '') {
    if (!condition) failures++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
}

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
    vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}

console.log(`=== Résolution BEM (${freqs.join(', ')} Hz) ===`);
selfStub.onmessage({
    data: {
        type: 'computeDomain', id: 'flow', mshContent: study.mesh, config,
        opts: {
            freqs, distance_m: 1, angleStep: 30, angleMax: 90, fields: [],
            // p:1 = bouche intérieure de l'event, p:5 = bouche extérieure.
            flowSurfaces: ['p:1', 'p:5'],
        },
    },
});
if (errorMessage) { console.error('worker error:', errorMessage); process.exit(1); }

check('le worker renvoie le débit surfacique', Array.isArray(done.surfaceFlow),
    `${done.surfaceFlow?.length ?? 0} entrées`);
check('une entrée par surface et par fréquence',
    done.surfaceFlow.length === freqs.length * 2);

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

const at = (sid, f) => done.surfaceFlow.find(e => e.surfaceId === sid && e.f === f);

console.log(`\n=== Aires intégrées ===`);
const a1 = at('p:1', freqs[0]).area * 1e4;
const a5 = at('p:5', freqs[0]).area * 1e4;
// Le modèle est un demi-modèle déplié par symétrie: 25.7 et 35.7 cm² par moitié.
check('aire de la bouche intérieure', Math.abs(a1 - 51.4) < 3, `${a1.toFixed(1)} cm² (attendu ~51.4)`);
check('aire de la bouche extérieure', Math.abs(a5 - 71.4) < 4, `${a5.toFixed(1)} cm² (attendu ~71.4)`);

console.log(`\n=== Débit et vitesse d'event — ${driverName} sous ${volts} V rms ===`);
console.log('  f(Hz)   |Uv| entrée   |Uv| sortie   écart    v_cône    U0 crête entrée');
let conserved = true;
for (const f of freqs) {
    const i = done.freqs.indexOf(f);
    const e1 = at('p:1', f), e5 = at('p:5', f);
    const m1 = Math.hypot(e1.re, e1.im), m5 = Math.hypot(e5.re, e5.im);
    const rel = Math.abs(m1 - m5) / Math.max(m1, m5, 1e-30);
    if (rel > 0.05) conserved = false;

    const vCone = coneVelocityRms(driverParams, f, volts, (done.drivenLoad || [])[i] || null);
    // Le BEM tourne à vitesse de membrane unité: on remet l'échelle réelle,
    // puis on passe en amplitude crête pour la condition d'entrée CFD.
    const u0 = Math.SQRT2 * vCone * m1 / e1.area;
    console.log(`  ${f.toFixed(0).padStart(5)}  ${m1.toExponential(3).padStart(12)}  `
        + `${m5.toExponential(3).padStart(12)}  ${(rel * 100).toFixed(2).padStart(6)}%  `
        + `${(vCone * 1000).toFixed(1).padStart(7)}mm/s  ${u0.toFixed(2).padStart(10)} m/s`);
}

// Le conduit fait 189 mm pour 8,6 m de longueur d'onde à 40 Hz: l'air y est
// incompressible, donc le débit entrant doit ressortir intégralement.
check('débit conservé entre les deux bouches', conserved, 'écart < 5 %');
check('débit non nul', Math.hypot(at('p:1', freqs[0]).re, at('p:1', freqs[0]).im) > 0);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
