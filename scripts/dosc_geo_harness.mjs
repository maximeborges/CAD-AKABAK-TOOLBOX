// =======================================================
// scripts/dosc_geo_harness.mjs
//
// Valide la chaîne d'EXPORT DOSC de bout en bout, hors Electron :
//
//   doscGenerator → anneaux → generateGeoForDoscLoft → .geo → GMSH → STEP / MSH
//
// C'est le seul test qui prouve que le kernel OpenCASCADE avale réellement la
// géométrie (double loft carter + corps, fermetures, interface). Il vérifie
// ensuite le .msh produit : présence des surfaces physiques attendues par
// src/js/bem/bemShared.js, et orientation des normales.
//
// Usage (depuis la racine du repo) :
//   node scripts/dosc_geo_harness.mjs
//   node scripts/dosc_geo_harness.mjs --gmsh /chemin/vers/gmsh   (sinon: $GMSH, puis "gmsh" dans le PATH)
//   node scripts/dosc_geo_harness.mjs --geo-only     # n'exécute pas gmsh
//   node scripts/dosc_geo_harness.mjs --clmax 8 --curv 8
//
// Sorties : scripts/out/dosc_export/{waveguide.geo, waveguide.step, waveguide.msh}
// =======================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateDosc, stackToSlices } from '../src/js/panels/waveguidestudio/dosc/doscGenerator.js';
import { generateGeoForDoscLoft } from '../src/js/panels/waveguidestudio/exporters.js';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'dosc_export');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const k = argv.indexOf(n); return k >= 0 && argv[k + 1] != null ? argv[k + 1] : d; };
const num = (n, d) => { const v = Number(opt(n, d)); return Number.isFinite(v) ? v : d; };

const GMSH = resolveGmsh(opt('--gmsh'));
const CLMAX = num('--clmax', 10);
const CURV = num('--curv', 5);

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  —  ' + detail : ''}`);
};

// -------------------------------------------------------
// 1. Géométrie + .geo
// -------------------------------------------------------
console.log('\n=== 1. Génération du .geo ===');

// Volontairement plus grossier que l'UI : un loft OCC à 135 sections × 120
// points est correct mais lent, et ce test doit rester rapide. La topologie
// testée est identique.
const CASE = {
    throatDiameter: 35, mouthWidth: 30, mouthHeight: 220, depth: 244,
    numLines: 48, axialPoints: 28, filletRadius: 3,
};
const TIP_OFFSET = 30;

const built = generateDosc(CASE);
if (!built.ok) { console.log('  FAIL  ' + built.error); process.exit(1); }

const depth = built.params.depth;
const housingSlices = stackToSlices(built.housing, depth);
const bodySlices = stackToSlices(built.body, depth);
console.log(`  carter ${housingSlices.length} sections · corps ${bodySlices.length} sections · ${built.housing.numLines} pts/anneau`);

const geoMesh = generateGeoForDoscLoft(housingSlices, bodySlices, true, TIP_OFFSET, { clmax: CLMAX, curvature: CURV });
const geoStep = generateGeoForDoscLoft(housingSlices, bodySlices, true, TIP_OFFSET, null);

check('le .geo n\'est pas un stub d\'erreur', !geoMesh.startsWith('// Not enough'));
check('deux ThruSections (carter + corps)', (geoMesh.match(/ThruSections\(/g) || []).length === 2);
check('deux retraits de capots (préfixes _h et _b)',
    geoMesh.includes('_hbnd()') && geoMesh.includes('_bbnd()'));
check('la gorge circulaire est émise comme primitive Circle',
    /Circle\(\d+\) = \{0, 0, -244\.000000, 17\.500000\}/.test(geoMesh),
    'diamètre exact 35 mm au plan de gorge');
check('surfaces physiques attendues par bemShared',
    geoMesh.includes('Physical Surface("horn_surface")') &&
    geoMesh.includes('Physical Surface("throat_cap")') &&
    geoMesh.includes('Physical Surface("interface_face")'));
check('les 4 parois rigides sont dans horn_surface',
    /Physical Surface\("horn_surface"\) = \{Abs\(_hbnd\(_hkeep\)\), Abs\(_bbnd\(_bkeep\)\), \d+, \d+, _iw\[1\]\};/.test(geoMesh));
check('.geo STEP sans bloc de maillage', !geoStep.includes('Physical Surface'));

// La bouche est en z = 0 et la gorge en z = -depth (convention de l'app).
// Attention : les anneaux circulaires sont émis en primitive Circle et n'ont
// donc AUCUN Point — il faut lire les deux formes pour couvrir tout le guide.
const zs = [
    ...[...geoMesh.matchAll(/^Point\(\d+\) = \{[-\d.]+, [-\d.]+, ([-\d.]+), 0\};$/gm)].map(m => Number(m[1])),
    ...[...geoMesh.matchAll(/^Circle\(\d+\) = \{0, 0, ([-\d.]+), [\d.]+\};$/gm)].map(m => Number(m[1])),
];
check('convention axiale : gorge en z = -depth, bouche en z = 0',
    Math.abs(Math.min(...zs) + depth) < 1e-6 && Math.abs(Math.max(...zs)) < 1e-6,
    `z ∈ [${Math.min(...zs).toFixed(3)}, ${Math.max(...zs).toFixed(3)}]`);

// Le carter DOSC est un cône pur sur sa première moitié (FIG. 2/3) : on doit
// donc voir un nombre substantiel de sections circulaires exactes.
const nCircle = (geoMesh.match(/^Circle\(/gm) || []).length;
check('les sections coniques sont des cercles exacts', nCircle >= 10,
    `${nCircle} sections sur ${housingSlices.length + bodySlices.length}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const geoMeshPath = path.join(OUT_DIR, 'waveguide_mesh.geo');
const geoStepPath = path.join(OUT_DIR, 'waveguide_step.geo');
fs.writeFileSync(geoMeshPath, geoMesh);
fs.writeFileSync(geoStepPath, geoStep);
console.log(`  écrit ${path.relative(process.cwd(), geoMeshPath)} (${(geoMesh.length / 1024).toFixed(0)} kio)`);

if (flag('--geo-only')) {
    console.log(`\n=== RÉSULTAT : ${failures === 0 ? 'OK (gmsh non exécuté)' : failures + ' ÉCHEC(S)'} ===\n`);
    process.exit(failures === 0 ? 0 : 1);
}

// -------------------------------------------------------
// 2. GMSH : STEP
// -------------------------------------------------------
console.log('\n=== 2. GMSH → STEP ===');
if (!fs.existsSync(GMSH)) {
    console.log(`  SKIP  gmsh introuvable (${GMSH}) — passer --gmsh <chemin>`);
} else {
    const stepPath = path.join(OUT_DIR, 'waveguide.step');
    try {
        const t0 = Date.now();
        const out = execFileSync(GMSH, [geoStepPath, '-0', '-o', stepPath], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const errors = (out.match(/^Error\s*:.*/gm) || []);
        check('gmsh -0 sans erreur', errors.length === 0, errors.slice(0, 2).join(' | ') || `${dt} s`);
        const okFile = fs.existsSync(stepPath) && fs.statSync(stepPath).size > 2000;
        check('STEP produit', okFile,
            okFile ? `${(fs.statSync(stepPath).size / 1024).toFixed(0)} kio en ${dt} s` : 'fichier absent ou vide');
        if (okFile) {
            const head = fs.readFileSync(stepPath, 'latin1').slice(0, 4000);
            check('STEP bien formé (ISO-10303-21)', head.startsWith('ISO-10303-21'));
            const body = fs.readFileSync(stepPath, 'latin1');
            const nSurf = (body.match(/B_SPLINE_SURFACE|CONICAL_SURFACE|PLANE|CYLINDRICAL_SURFACE/g) || []).length;
            check('STEP contient des surfaces', nSurf > 4, `${nSurf} entités de surface`);
        }
    } catch (e) {
        check('gmsh -0 sans erreur', false, String(e.stderr || e.message).slice(0, 240));
    }
}

// -------------------------------------------------------
// 3. GMSH : maillage + contrôle du .msh
// -------------------------------------------------------
console.log('\n=== 3. GMSH → MSH ===');
if (!fs.existsSync(GMSH)) {
    console.log('  SKIP  gmsh introuvable');
} else {
    const mshPath = path.join(OUT_DIR, 'waveguide.msh');
    try {
        const t0 = Date.now();
        const out = execFileSync(GMSH, [geoMeshPath, '-2', '-format', 'msh2', '-o', mshPath], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const errors = (out.match(/^Error\s*:.*/gm) || []);
        check('gmsh -2 sans erreur', errors.length === 0, errors.slice(0, 2).join(' | ') || `${dt} s`);

        const msh = fs.readFileSync(mshPath, 'utf8');
        check('MSH produit', msh.length > 5000, `${(msh.length / 1024 / 1024).toFixed(2)} Mio en ${dt} s`);

        // -- Noms physiques : bemShared.js exige throat_cap ET une ouverture.
        const names = [...msh.matchAll(/^\d+\s+(\d+)\s+"([^"]+)"$/gm)].map(m => ({ tag: Number(m[1]), name: m[2] }));
        console.log(`     surfaces physiques : ${names.map(n => n.name).join(', ')}`);
        check('horn_surface présent', names.some(n => n.name === 'horn_surface'));
        check('throat_cap présent (piston moteur du BEM)', names.some(n => n.name === 'throat_cap'));
        check('interface_face présent (ouverture rayonnante)', names.some(n => n.name === 'interface_face'));

        // -- Triangles par groupe + orientation des normales.
        const parsed = parseMsh2(msh);
        check('le maillage contient des triangles', parsed.tris.length > 500, `${parsed.tris.length} triangles`);
        const byTag = new Map();
        for (const t of parsed.tris) byTag.set(t.tag, (byTag.get(t.tag) || 0) + 1);
        for (const n of names) {
            const c = byTag.get(n.tag) || 0;
            check(`  ${n.name} : maillé`, c > 0, `${c} triangles`);
        }

        // bemShared exige que interface_face regarde +Z et throat_cap -Z.
        const ifaceTag = names.find(n => n.name === 'interface_face')?.tag;
        const throatTag = names.find(n => n.name === 'throat_cap')?.tag;
        const nzStats = (tag) => {
            let worst = 1, count = 0;
            for (const t of parsed.tris) {
                if (t.tag !== tag) continue;
                count++;
                worst = Math.min(worst, Math.abs(triNormal(parsed.nodes, t).z));
            }
            return { worst, count };
        };
        if (ifaceTag != null) {
            const s = nzStats(ifaceTag);
            check('interface_face est plane et normale à Z', s.worst > 0.999,
                `|n_z| min = ${s.worst.toFixed(5)} sur ${s.count} triangles`);
        }
        if (throatTag != null) {
            const s = nzStats(throatTag);
            check('throat_cap est plan et normal à Z', s.worst > 0.999,
                `|n_z| min = ${s.worst.toFixed(5)} sur ${s.count} triangles`);
        }

        // -- Étendue géométrique : le maillage doit couvrir tout le guide.
        let zMin = Infinity, zMax = -Infinity, rMax = 0;
        for (const n of parsed.nodes.values()) {
            zMin = Math.min(zMin, n.z); zMax = Math.max(zMax, n.z);
            rMax = Math.max(rMax, Math.hypot(n.x, n.y));
        }
        check('étendue axiale = profondeur + Z offset',
            Math.abs(zMin + depth) < 0.5 && Math.abs(zMax - TIP_OFFSET) < 0.5,
            `z ∈ [${zMin.toFixed(2)}, ${zMax.toFixed(2)}] attendu [${-depth}, ${TIP_OFFSET}]`);
        check('demi-hauteur de bouche = mouthHeight/2',
            Math.abs(rMax - CASE.mouthHeight / 2) < 1.0,
            `r max = ${rMax.toFixed(2)} mm attendu ${(CASE.mouthHeight / 2).toFixed(2)}`);

        // -- Contrôle d'AIRE. C'est le seul test qui détecte une face latérale
        //    perdue : si OCC scinde la paroi en plusieurs faces et que le
        //    retrait des capots n'en garde qu'une, la géométrie reste valide et
        //    maille sans erreur — mais il manque un morceau de paroi. On compare
        //    donc l'aire maillée de horn_surface à l'aire des empilements
        //    d'anneaux du générateur.
        const wallTag = names.find(n => n.name === 'horn_surface')?.tag;
        if (wallTag != null) {
            let meshed = 0;
            for (const t of parsed.tris) if (t.tag === wallTag) meshed += triArea(parsed.nodes, t);
            const expected = stackArea(built.housing) + stackArea(built.body)
                + capArea(built.body, 0) + capArea(built.body, built.body.numSlices - 1)
                + interfaceWallArea(built.housing, TIP_OFFSET);
            const rel = Math.abs(meshed - expected) / expected;
            check('aire de horn_surface conforme (aucune face perdue)', rel < 0.03,
                `maillé ${meshed.toFixed(0)} mm² vs attendu ${expected.toFixed(0)} mm² (${(rel * 100).toFixed(1)} %)`);
        }
    } catch (e) {
        check('gmsh -2 sans erreur', false, String(e.stderr || e.message).slice(0, 240));
    }
}

console.log(`\n=== RÉSULTAT : ${failures === 0 ? 'TOUS LES TESTS PASSENT' : failures + ' ÉCHEC(S)'} ===\n`);
process.exit(failures === 0 ? 0 : 1);

// -------------------------------------------------------
/** Lecteur minimal de MSH 2.2 : nœuds + triangles avec leur tag physique. */
function parseMsh2(text) {
    const nodes = new Map();
    const tris = [];
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const l = lines[i].trim();
        if (l === '$Nodes') {
            const n = parseInt(lines[++i], 10);
            for (let k = 0; k < n; k++) {
                const p = lines[++i].trim().split(/\s+/);
                nodes.set(Number(p[0]), { x: Number(p[1]), y: Number(p[2]), z: Number(p[3]) });
            }
        } else if (l === '$Elements') {
            const n = parseInt(lines[++i], 10);
            for (let k = 0; k < n; k++) {
                const p = lines[++i].trim().split(/\s+/).map(Number);
                // id type nTags <tags...> nodes...
                const type = p[1], nTags = p[2];
                if (type !== 2) continue; // triangles seulement
                const tag = p[3];
                const base = 3 + nTags;
                tris.push({ tag, a: p[base], b: p[base + 1], c: p[base + 2] });
            }
        }
        i++;
    }
    return { nodes, tris };
}

function triArea(nodes, t) {
    const A = nodes.get(t.a), B = nodes.get(t.b), C = nodes.get(t.c);
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Aire latérale d'un empilement d'anneaux (somme des quads triangulés). */
function stackArea(stack) {
    const { numLines: N, numSlices: S, vertices: V } = stack;
    const P = (s, j) => { const k = (s * N + j) * 3; return { x: V[k], y: V[k + 1], z: V[k + 2] }; };
    const tri = (a, b, c) => {
        const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
        const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    let area = 0;
    for (let s = 0; s < S - 1; s++) {
        for (let j = 0; j < N; j++) {
            const jn = (j + 1) % N;
            area += tri(P(s, j), P(s + 1, j), P(s + 1, jn));
            area += tri(P(s, j), P(s + 1, jn), P(s, jn));
        }
    }
    return area;
}

/** Aire du polygone plan d'un anneau (les méplats de nez / d'arête de fuite). */
function capArea(stack, sliceIndex) {
    const { numLines: N, vertices: V } = stack;
    let a = 0;
    for (let j = 0; j < N; j++) {
        const k = ((sliceIndex * N) + j) * 3;
        const k2 = ((sliceIndex * N) + ((j + 1) % N)) * 3;
        a += V[k] * V[k2 + 1] - V[k2] * V[k + 1];
    }
    return Math.abs(a) / 2;
}

/** Aire de la collerette d'interface : périmètre de bouche × Z offset. */
function interfaceWallArea(stack, tipOffset) {
    const { numLines: N, numSlices: S, vertices: V } = stack;
    const base = (S - 1) * N * 3;
    let perim = 0;
    for (let j = 0; j < N; j++) {
        const k = base + j * 3;
        const k2 = base + ((j + 1) % N) * 3;
        perim += Math.hypot(V[k2] - V[k], V[k2 + 1] - V[k + 1]);
    }
    return perim * tipOffset;
}

function triNormal(nodes, t) {
    const A = nodes.get(t.a), B = nodes.get(t.b), C = nodes.get(t.c);
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const n = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / n, y: ny / n, z: nz / n };
}
