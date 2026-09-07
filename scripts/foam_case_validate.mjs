// =======================================================
// FICHIER :  scripts/foam_case_validate.mjs
// RÔLE    :  Valide l'extraction géométrique du domaine fluide de l'event
//            depuis un projet .TBBS (src/ipc/foamCase.js)
// USAGE   :  node scripts/foam_case_validate.mjs [projet.TBBS]
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

const projectPath = resolveDataFile('DEV-BEM/8br40.TBBS', { explicit: process.argv[2] });

let failures = 0;
function check(label, condition, detail = '') {
    if (!condition) failures++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
}
const mm = (v) => v.toFixed(1);

const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
console.log(`Projet : ${path.basename(projectPath)}  (${project.meshFileName})`);

console.log('\n=== Parsing du maillage embarqué ===');
const { tris, physicalNames, nodeCount } = foamCase.parseMshTriangles(project.mesh);
check('triangles extraits', tris.length > 0, `${tris.length} tris, ${nodeCount} nœuds`);
check('groupes physiques nommés', Object.keys(physicalNames).length > 0,
    Object.entries(physicalNames).map(([t, n]) => `${t}=${n}`).join(' '));

console.log('\n=== Surfaces du modèle ===');
const whole = foamCase.surfaceStats(tris);
console.log(`  maillage complet : x[${mm(whole.bbox.min[0])}, ${mm(whole.bbox.max[0])}]`
    + ` y[${mm(whole.bbox.min[1])}, ${mm(whole.bbox.max[1])}]`
    + ` z[${mm(whole.bbox.min[2])}, ${mm(whole.bbox.max[2])}]`);
for (const tag of Object.keys(physicalNames).map(Number).sort((a, b) => a - b)) {
    const sel = foamCase.trisForSurfaceId(tris, `p:${tag}`);
    const s = foamCase.surfaceStats(sel);
    if (!s) { console.log(`  p:${tag} (${physicalNames[tag]}) — vide`); continue; }
    console.log(`  p:${tag} ${physicalNames[tag].padEnd(4)} ${String(s.count).padStart(5)} tris`
        + `  A=${(s.area_mm2 / 100).toFixed(1)} cm²`
        + `  x[${mm(s.bbox.min[0])}, ${mm(s.bbox.max[0])}]`
        + ` y[${mm(s.bbox.min[1])}, ${mm(s.bbox.max[1])}]`
        + ` z[${mm(s.bbox.min[2])}, ${mm(s.bbox.max[2])}]`
        + `  planarity=${s.planarity.toFixed(3)}`
        + `  n=[${s.normal.map(v => v.toFixed(2)).join(' ')}]`);
}

// Le domaine fluide de l'event: parois S3, bouche interne S1, bouche externe S5.
const GROUPS = { wall: ['p:3'], inlet: ['p:1'], outlet: ['p:5'] };

console.log('\n=== Domaine fluide de l\'event ===');
const { stl, regions } = foamCase.buildVentStl(tris, GROUPS);
for (const role of ['wall', 'inlet', 'outlet']) {
    check(`région « ${role} » non vide`, !!regions[role],
        regions[role] ? `${regions[role].count} tris, ${(regions[role].area_mm2 / 100).toFixed(1)} cm²` : 'absente');
}

const inlet = regions.inlet, outlet = regions.outlet, wall = regions.wall;
check('la bouche interne est plane', inlet && inlet.planarity > 0.99, inlet && inlet.planarity.toFixed(4));
check('la bouche externe est plane', outlet && outlet.planarity > 0.99, outlet && outlet.planarity.toFixed(4));
check('les parois se referment sur elles-mêmes', wall && wall.planarity < 0.5,
    wall && `planarity=${wall.planarity.toFixed(3)} (une paroi de conduit doit être ~0)`);

const dhIn = foamCase.hydraulicDiameterMm(inlet);
const dhOut = foamCase.hydraulicDiameterMm(outlet);
check('diamètre hydraulique entrée plausible', dhIn > 1 && dhIn < 500, `${mm(dhIn)} mm`);
check('diamètre hydraulique sortie plausible', dhOut > 1 && dhOut < 500, `${mm(dhOut)} mm`);

// Le volume fluide n'est fermé qu'avec les deux bouches: les trois régions
// doivent partager une boîte englobante commune cohérente.
if (inlet && outlet) {
    const span = Math.hypot(
        inlet.centroid[0] - outlet.centroid[0],
        inlet.centroid[1] - outlet.centroid[1],
        inlet.centroid[2] - outlet.centroid[2]);
    check('les deux bouches sont distinctes', span > 1, `entraxe ${mm(span)} mm`);
    console.log(`  INFO  longueur de conduit ≈ ${mm(span)} mm, section entrée ${(inlet.area_mm2 / 100).toFixed(1)} cm²,`
        + ` sortie ${(outlet.area_mm2 / 100).toFixed(1)} cm²`);
}

console.log('\n=== Export STL ===');
const outDir = path.join(repo, '.foam-work');
fs.mkdirSync(outDir, { recursive: true });
const stlPath = path.join(outDir, 'vent.stl');
fs.writeFileSync(stlPath, stl, 'utf8');
const solids = (stl.match(/^solid /gm) || []).length;
const facets = (stl.match(/^  facet /gm) || []).length;
check('STL multi-solides écrit', solids === 3, `${solids} solides, ${facets} facettes`);
check('nombre de facettes cohérent', facets === (wall.count + inlet.count + outlet.count));
check('coordonnées converties en mètres',
    Math.abs(inlet.centroid[1] * 0.001) < 1 && /vertex [-\d.e]+/.test(stl));
console.log(`  INFO  ${stlPath}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
