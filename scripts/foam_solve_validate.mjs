// =======================================================
// FICHIER :  scripts/foam_solve_validate.mjs
// RÔLE    :  Chaîne CFD complète sur l'event: maillage, pimpleFoam, sondes et
//            décomposition harmonique exploitable par le Field BEM.
// USAGE   :  node scripts/foam_solve_validate.mjs [draft|normal] [cores] [endTime_s]
//            'draft' maille grossièrement pour boucler en quelques minutes.
// =======================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveDataFile } from './lib/env_paths.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const foamCase = require(path.join(repo, 'src', 'ipc', 'foamCase.js'));
const foamResults = require(path.join(repo, 'src', 'ipc', 'foamResults.js'));
const foam = require(path.join(repo, 'src', 'ipc', 'foamRunner.js'));

const quality = process.argv[2] || 'draft';
const cores = process.argv[3] ? parseInt(process.argv[3], 10) : 16;
const endOverride = process.argv[4] || '';
const caseDir = path.join(repo, '.foam-work', `vent-${quality}`);
const FREQ = 40;
const U_IN = 10;

let failures = 0;
function check(label, condition, detail = '') {
    if (!condition) failures++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
}

// Sondes le long de l'axe du conduit puis au-delà de la bouche: c'est là que le
// jet se détache et que la CFD doit diverger de l'acoustique linéaire.
const axisZ = [];
for (let z = -155; z <= 20; z += 5) axisZ.push(z);
const probePoints_mm = axisZ.map(z => [0, -185, z]);
for (let z = -155; z <= 20; z += 25) probePoints_mm.push([0, -178, z]);

console.log(`=== Génération du cas (${quality}) ===`);
const project = JSON.parse(fs.readFileSync(resolveDataFile('DEV-BEM/8br40.TBBS', { explicit: process.argv[2] }), 'utf8'));
const built = foamCase.buildCase({
    mshContent: project.mesh,
    groups: { wall: ['p:3'], inlet: ['p:1'], outlet: ['p:5'] },
    mirrorAxis: project.symmetry === 'v' ? 0 : null,
    frequency_Hz: FREQ,
    inletVelocity_ms: U_IN,
    probePoints_mm,
    periods: 2,
    quality,
    cores,
});
const info = built.info;
console.log(`  maille de fond : ${info.baseCell_mm} mm → `
    + `${info.blockCounts.reduce((a, b) => a * b, 1).toLocaleString('fr-FR')} cellules de fond`);
console.log(`  D_h ${info.hydraulicDiameter_mm.toFixed(1)} mm, période ${(info.period_s * 1000).toFixed(2)} ms, `
    + `fin à ${(info.endTime_s * 1000).toFixed(0)} ms`);

const meshed = fs.existsSync(path.join(caseDir, 'constant', 'polyMesh', 'owner'));
for (const [rel, content] of Object.entries(built.files)) {
    const dest = path.join(caseDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
}
fs.rmSync(path.join(caseDir, 'postProcessing'), { recursive: true, force: true });
check('cas écrit sur disque', fs.existsSync(path.join(caseDir, 'system', 'controlDict')), caseDir);
check('sondes déclarées', info.probeCount === probePoints_mm.length, `${probePoints_mm.length} points`);

const stage = meshed ? 'solve' : 'all';
console.log(`\n=== OpenFOAM — étape « ${stage} » sur ${cores} cœurs ===`);
const env = await foam.checkAvailability();
check('OpenFOAM disponible', env.available, env.reason || `${env.distro} ${env.version}`);

if (env.available) {
    const t0 = Date.now();
    const res = await foam.runFoamScriptStream(env.distro, 'run_case.sh',
        [foam.toWslPath(caseDir), stage, String(cores), endOverride],
        {
            timeout: 3 * 60 * 60 * 1000,
            onLine: line => {
                if (line.startsWith('FOAM_STAGE=')) console.log(`  … ${line.slice(11)}`);
                if (line.startsWith('FOAM_WARN=')) console.log(`  WARN ${line.slice(10)}`);
                if (line.startsWith('FOAM_ERROR=')) console.log(`  ERREUR ${line.slice(11)}`);
            },
        });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const results = foam.parseKeyValues(
        res.stdout.split(/\r?\n/).filter(l => l.startsWith('FOAM_RESULT='))
            .map(l => l.slice(12)).join('\n'));

    check('la chaîne aboutit', results.status === 'ok', `${secs} s`);
    if (results.cells) {
        check('maillage exploitable', parseInt(results.cells, 10) > 5000,
            `${parseInt(results.cells, 10).toLocaleString('fr-FR')} cellules, meshOk=${results.meshOk}`);
    }
    if (results.status !== 'ok') {
        console.log('\n--- sortie brute ---\n' + res.stdout.split(/\r?\n/).slice(-40).join('\n'));
        console.log(`\n${failures} check(s) failed.`);
        process.exit(1);
    }
    console.log(`  temps simulé ${results.lastTime} s en ${results.clockTime} s de calcul`);

    console.log('\n=== Sondes et décomposition harmonique ===');
    const ppDir = path.join(caseDir, 'postProcessing', 'fieldProbes');
    const stamps = fs.existsSync(ppDir) ? fs.readdirSync(ppDir) : [];
    check('sondes écrites', stamps.length > 0, stamps.join(', '));
    if (!stamps.length) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }

    const probes = foamResults.parseProbes(
        fs.readFileSync(path.join(ppDir, stamps[0], 'U'), 'utf8'));
    check('toutes les sondes sont dans le maillage',
        probes.valid.every(Boolean),
        `${probes.valid.filter(Boolean).length} / ${probePoints_mm.length} dans le fluide`);
    check('série temporelle suffisante pour un cycle', probes.times.length >= 24,
        `${probes.times.length} échantillons jusqu'à ${probes.times[probes.times.length - 1]} s`);
    const flat = probes.values.flat(2).filter(v => Math.abs(v) < 1e30);
    check('vitesses finies', flat.every(Number.isFinite));
    const vmax = Math.max(...flat.map(Math.abs));
    check('vitesses plausibles', vmax > 0.01 && vmax < 200, `|U|max = ${vmax.toFixed(2)} m/s`);

    const field = foamResults.toFieldVelocity(foamResults.harmonicDecompose(probes, FREQ, 1));
    check('champ harmonique au format Field', field.vRe.length === probes.positions.length * 3);

    // Le conduit se resserre par rapport a la bouche: par conservation du debit
    // la vitesse cretes sur l'axe doit approcher ou depasser la valeur imposee.
    const n = axisZ.length;
    const peaks = Array.from(field.peak.slice(0, n));
    check('accélération dans le conduit', Math.max(...peaks) > U_IN * 0.5,
        `crête ${Math.max(...peaks).toFixed(2)} m/s pour ${U_IN} m/s imposés`);

    const turb = Array.from(field.turbulence.slice(0, n));
    const iTurb = turb.indexOf(Math.max(...turb));
    const meanMax = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(field.vMean[i * 3 + 2])));
    console.log(`  turbulence max ${Math.max(...turb).toFixed(3)} m/s à z = ${axisZ[iTurb]} mm `
        + `(bouche à z = +25 mm)`);
    console.log(`  écoulement moyen max sur l'axe ${meanMax.toFixed(3)} m/s`);
    check('la turbulence est non nulle et bornée',
        Math.max(...turb) > 0 && Math.max(...turb) < 100);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
