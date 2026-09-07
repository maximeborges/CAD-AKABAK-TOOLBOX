// =======================================================
// FICHIER :  scripts/foam_mesh_validate.mjs
// RÔLE    :  Génère un cas OpenFOAM depuis un projet .TBBS et vérifie que le
//            maillage volumique de l'event se construit réellement.
// USAGE   :  node scripts/foam_mesh_validate.mjs [projet.TBBS]
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
const foam = require(path.join(repo, 'src', 'ipc', 'foamRunner.js'));

const projectPath = resolveDataFile('DEV-BEM/8br40.TBBS', { explicit: process.argv[2] });

let failures = 0;
function check(label, condition, detail = '') {
    if (!condition) failures++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
}

const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

console.log('=== Génération du cas ===');
// Valeurs représentatives d'un accord d'event: le couplage réel les tirera du
// solveur BEM (fréquence sélectionnée + tension RMS via le modèle T&S).
const built = foamCase.buildCase({
    mshContent: project.mesh,
    groups: { wall: ['p:3'], inlet: ['p:1'], outlet: ['p:5'] },
    mirrorAxis: project.symmetry === 'v' ? 0 : null,
    frequency_Hz: 40,
    inletVelocity_ms: 10,
    periods: 2,
    baseCell_mm: 3,
    cores: 8,
});

const info = built.info;
console.log(`  domaine  : ${info.bbox_m.min.map(v => (v * 1000).toFixed(0)).join(' / ')} → `
    + `${info.bbox_m.max.map(v => (v * 1000).toFixed(0)).join(' / ')} mm`);
console.log(`  bloc     : ${info.blockCounts.join(' × ')} = `
    + `${info.blockCounts.reduce((a, b) => a * b, 1).toLocaleString('fr-FR')} cellules de fond (${info.baseCell_mm} mm)`);
console.log(`  D_h      : ${info.hydraulicDiameter_mm.toFixed(1)} mm`);
console.log(`  période  : ${(info.period_s * 1000).toFixed(2)} ms, fin à ${(info.endTime_s * 1000).toFixed(0)} ms`);
console.log(`  k0/omega0: ${info.k0.toExponential(2)} / ${info.omega0.toFixed(0)}`);
console.log(`  flowDir  : [${info.flowDir.map(v => v.toFixed(2)).join(' ')}]`);

check('géométrie dépliée par symétrie', info.triangleCount === 1560 * 2, `${info.triangleCount} tris`);
check('point témoin dans le fluide',
    info.locationInMesh_m.every(Number.isFinite), info.locationInMesh_m.map(v => (v * 1000).toFixed(1)).join(' / ') + ' mm');
check('sens d\'écoulement aligné sur l\'axe du conduit', Math.abs(info.flowDir[2]) > 0.99);

const required = ['constant/triSurface/vent.stl', 'system/blockMeshDict', 'system/snappyHexMeshDict',
    'system/controlDict', 'system/fvSchemes', 'system/fvSolution', 'constant/transportProperties',
    'constant/turbulenceProperties', '0/U', '0/p', '0/k', '0/omega', '0/nut'];
check('tous les fichiers du cas sont produits',
    required.every(f => built.files[f]), `${Object.keys(built.files).length} fichiers`);

console.log('\n=== Écriture sur disque ===');
const caseDir = path.join(repo, '.foam-work', 'vent-case');
fs.rmSync(caseDir, { recursive: true, force: true });
for (const [rel, content] of Object.entries(built.files)) {
    const dest = path.join(caseDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
}
check('arborescence du cas écrite', fs.existsSync(path.join(caseDir, 'system', 'controlDict')), caseDir);

console.log('\n=== Maillage OpenFOAM (blockMesh + snappyHexMesh + checkMesh) ===');
const env = await foam.checkAvailability();
check('OpenFOAM disponible', env.available, env.reason || `${env.distro} ${env.version}`);

if (env.available) {
    const t0 = Date.now();
    const res = await foam.runFoamScript(env.distro, 'run_case.sh',
        [foam.toWslPath(caseDir), 'mesh'], { timeout: 30 * 60 * 1000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    for (const line of res.stdout.split(/\r?\n/)) {
        if (line.startsWith('FOAM_STAGE=')) console.log(`  … ${line.slice(11)}`);
        if (line.startsWith('FOAM_WARN=')) console.log(`  WARN ${line.slice(10)}`);
        if (line.startsWith('FOAM_ERROR=')) console.log(`  ERREUR ${line.slice(11)}`);
    }
    const results = foam.parseKeyValues(
        res.stdout.split(/\r?\n/).filter(l => l.startsWith('FOAM_RESULT='))
            .map(l => l.slice(12)).join('\n'));

    check('le pipeline de maillage aboutit', results.status === 'ok', res.stderr.trim().slice(0, 300) || `${secs} s`);
    check('checkMesh valide le maillage', results.meshOk === '1');
    const cells = parseInt(results.cells, 10) || 0;
    check('nombre de cellules exploitable', cells > 10000, `${cells.toLocaleString('fr-FR')} cellules en ${secs} s`);

    if (!res.ok || results.status !== 'ok') {
        console.log('\n--- sortie brute ---\n' + res.stdout.split(/\r?\n/).slice(-40).join('\n'));
    }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
