// ====================================================================================================
// FICHIER :  scripts/dosc_brep_harness.mjs
// RÔLE :     Valide la chaîne B-Rep du DOSC : doscBrep → .geo → GMSH → STEP / MSH.
//
//            Contrairement au loft, on vérifie ici que GMSH construit bien des
//            SOLIDES (le STEP doit contenir des faces coniques/planes exactes)
//            et que le maillage sort sans « invalid element ».
//
// USAGE :
//   node scripts/dosc_brep_harness.mjs
//   node scripts/dosc_brep_harness.mjs --gmsh /chemin/vers/gmsh   (sinon: $GMSH, puis "gmsh" dans le PATH)
//   node scripts/dosc_brep_harness.mjs --geo-only
// ====================================================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { deriveDoscParams, maxDoscFilletRadius, generateDosc, computeIsophaseReport } from '../src/js/panels/waveguidestudio/dosc/doscGenerator.js';
import { generateGeoForDoscBRep } from '../src/js/panels/waveguidestudio/dosc/doscBrep.js';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out', 'dosc_brep');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const opt = (flag, dflt) => {
    const k = argv.indexOf(flag);
    return k >= 0 && argv[k + 1] ? argv[k + 1] : dflt;
};
const GEO_ONLY = argv.includes('--geo-only');
const GMSH = resolveGmsh(opt('--gmsh'));

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `   [${detail}]` : ''}`);
};

// Cotes par défaut de l'UI (profileGenerator.js).
const BASE = { throatDiameter: 35, mouthWidth: 30, mouthHeight: 220, depth: 244 };
const params = deriveDoscParams(BASE);
if (!params.ok) {
    console.error('deriveDoscParams a échoué :', params.error);
    process.exit(1);
}
const rho = Math.min(3, maxDoscFilletRadius(params));

console.log('=== 1. Génération du .geo ===');
console.log(`  α = ${params.alphaDeg.toFixed(2)}°, congé ρ = ${rho.toFixed(2)} mm (max ${maxDoscFilletRadius(params).toFixed(2)})`);

const CASES = [
    { name: 'plein_interface', split: { horizontal: false, vertical: false }, iface: true },
    { name: 'plein_sans_iface', split: { horizontal: false, vertical: false }, iface: false },
    { name: 'split_H', split: { horizontal: true, vertical: false }, iface: true },
    { name: 'split_HV', split: { horizontal: true, vertical: true }, iface: true },
    // Prisme aminci : le losange s'affine, son pli recule, le centre devance.
    { name: 'mince', split: { horizontal: false, vertical: false }, iface: true, w: -60 },
    { name: 'mince_splitHV', split: { horizontal: true, vertical: true }, iface: true, w: -60 },
    // Les deux réglages ensemble : haut ET mince.
    { name: 'haut100_mince60', split: { horizontal: false, vertical: false }, iface: true, h: 100, w: -60 },
];

const built = [];
for (const c of CASES) {
    const cp = deriveDoscParams({ ...BASE, prismHeightPct: c.h || 0, prismWidthPct: c.w || 0 });
    for (const mode of ['step', 'mesh']) {
        const geo = generateGeoForDoscBRep({
            params: cp,
            filletRadius: Math.min(3, maxDoscFilletRadius(cp)),
            edgeThickness: 1.5,
            noseRadius: 0.25,
            buildInterface: c.iface,
            tipOffset: c.iface ? 30 : 0,
            meshConfig: mode === 'mesh' ? { clmax: 6, curvature: 20 } : null,
            split: c.split,
        });
        check(`${c.name}/${mode} : .geo produit`, typeof geo === 'string' && geo.length > 0);
        if (!geo) continue;
        const f = path.join(OUT, `${c.name}_${mode}.geo`);
        fs.writeFileSync(f, geo, 'utf-8');
        built.push({ ...c, mode, file: f });
    }
}

// Contrôles structurels sur le cas de référence.
const ref = fs.readFileSync(path.join(OUT, 'plein_interface_step.geo'), 'utf-8');
check('utilise le noyau OpenCASCADE', ref.includes('SetFactory("OpenCASCADE")'));
check('cône du carter présent', /Cone\(1\) = /.test(ref));
check('cône du corps présent', /Cone\(900\) = /.test(ref));
check('congé posé', ref.includes('Fillet{'));
check('modèle surfacique : les volumes sont supprimés', /Delete\{ Volume\{HV\}; \}/.test(ref) && /Delete\{ Volume\{BV\}; \}/.test(ref));
check('aucun booléen de différence (pas de solide plein)', !ref.includes('BooleanDifference'));
check('aucun loft / ThruSections', !ref.includes('ThruSections'));
check('aucune B-spline échantillonnée', !ref.includes('BSpline') && !ref.includes('Spline('));
check('pas de Physical Surface (export CAO pur)', !ref.includes('Physical Surface'));

const noIf = fs.readFileSync(path.join(OUT, 'plein_sans_iface_step.geo'), 'utf-8');
check('sans interface : gorge et bouche explicitement ouvertes',
    /Delete\{ Surface\{_ht\}; \}/.test(noIf) && /Delete\{ Surface\{_hm\}; \}/.test(noIf));
check('avec interface : la face de bouche est extrudée puis retirée',
    /Extrude \{0, 0, 30/.test(ref) && /Delete\{ Surface\{_hm\}; \}/.test(ref));

const refMesh = fs.readFileSync(path.join(OUT, 'plein_interface_mesh.geo'), 'utf-8');
check('paramètres de maillage en mode mesh', refMesh.includes('Mesh.CharacteristicLengthMax'));
check('raffinement par courbure actif', refMesh.includes('Mesh.MeshSizeFromCurvature'));

console.log(`\n=== 2. Largeur du prisme -> d\u00e9phasage r\u00e9sultant ===`);
{
    const p0 = deriveDoscParams({ ...BASE });
    const isoHalfH = (BASE.mouthHeight - BASE.throatDiameter) / 2;
    console.log(`  plage atteignable : ${p0.centreAdvanceMinMm.toFixed(1)} \u2026 ${p0.centreAdvanceMaxMm.toFixed(1)} mm`
        + `  (soit jusqu'\u00e0 ${p0.curvatureMaxDeg.toFixed(1)}\u00b0 de front)`);
    // La fen\u00eatre vis\u00e9e par l'utilisateur doit rester atteignable.
    check('la fen\u00eatre 8\u201312 mm est atteignable', p0.centreAdvanceMaxMm >= 12,
        `max ${p0.centreAdvanceMaxMm.toFixed(1)}mm`);

    let prevDelta = -Infinity;
    for (const w of [100, 50, 0, -50, -100]) {
        const built = generateDosc({ ...BASE, prismWidthPct: w, filletRadius: rho, numLines: 64, axialPoints: 60 });
        if (!built.ok) { check(`largeur=${w}% : g\u00e9n\u00e9ration`, false, built.error); continue; }
        const r = computeIsophaseReport(built, { azimuthSamples: 9, fMaxHz: 16000, steps: 1500 });
        const bp = built.params;
        console.log(`  largeur=${String(w).padStart(4)}% \u2192 \u0394 mesur\u00e9 ${r.measuredPathDelta.toFixed(2).padStart(6)}mm`
            + ` (${r.measuredCurvatureDeg.toFixed(1).padStart(4)}\u00b0)`
            + ` | \u03b1_x ${bp.alphaBodyBevelDeg.toFixed(2).padStart(5)}\u00b0`
            + ` | \u00bdlargeur ${bp.prismMaxHalfWidth.toFixed(1).padStart(5)}mm`
            + ` | pli ${bp.foldOnsetBody.toFixed(0).padStart(3)}mm`
            + ` | corps \u00bdh ${bp.bodyMouthHalfHeight.toFixed(1)}mm`);
        // Amincir le losange doit TOUJOURS faire avancer davantage le centre.
        check(`largeur=${w}% : \u0394 croissant quand on amincit`, r.measuredPathDelta > prevDelta - 0.05,
            `${r.measuredPathDelta.toFixed(2)} vs ${prevDelta.toFixed(2)}mm`);
        prevDelta = r.measuredPathDelta;
        // Le CARTER doit rester isophasique : c'est le corps seul qui sculpte.
        check(`largeur=${w}% : le carter reste isophasique`, r.housing.spread < 0.6, `spread = ${r.housing.spread.toFixed(3)}mm`);
        // La largeur ne touche PAS au profil vertical : c'est \u00e7a, l'ind\u00e9pendance.
        check(`largeur=${w}% : profil vertical inchang\u00e9`,
            Math.abs(bp.bodyMouthHalfHeight - isoHalfH) < 1e-9, `${bp.bodyMouthHalfHeight.toFixed(2)}mm`);
        check(`largeur=${w}% : jeu vertical constant`,
            Math.abs(bp.gapConicalMouth - bp.gapConicalThroat) < 1e-9, `${bp.gapConicalMouth.toFixed(2)}mm`);
        if (w < 0) {
            check(`largeur=${w}% : le losange s'affine`, bp.alphaBodyBevelDeg < bp.alphaDeg - 1e-9,
                `\u03b1_x ${bp.alphaBodyBevelDeg.toFixed(2)}\u00b0 < \u03b1 ${bp.alphaDeg.toFixed(2)}\u00b0`);
        }
        if (w === 0) {
            check('largeur=0% : front plat (\u0394 \u2248 0)', Math.abs(r.measuredPathDelta) < 0.5,
                `${r.measuredPathDelta.toFixed(3)}mm`);
        }
    }

    // 0 %/0 % doit redonner EXACTEMENT la g\u00e9om\u00e9trie du brevet.
    check('0%/0% redonne la cote du brevet R_b(D) = (L-O)/2',
        Math.abs(p0.bodyMouthHalfHeight - isoHalfH) < 1e-9, `${p0.bodyMouthHalfHeight.toFixed(4)}mm`);
    // Rev. 33 donne D/2 pour une ar\u00eate d'\u00e9paisseur nulle ; l'ar\u00eate r\u00e9elle de `t`
    // d\u00e9cale le pli de t/(4\u00b7tan\u03b1). C'est la valeur exacte de la pi\u00e8ce usinable.
    const foldIdeal = BASE.depth / 2 + 1.5 / (4 * p0.tanAlpha);
    check('0%/0% : pli du corps \u00e0 D/2 + t/(4tan\u03b1) (rev. 33 \u00e0 t pr\u00e8s)',
        Math.abs(p0.foldOnsetBody - foldIdeal) < 1e-6, `${p0.foldOnsetBody.toFixed(4)} vs ${foldIdeal.toFixed(4)}mm`);
}

console.log(`\n=== 3. Hauteur du prisme, et ind\u00e9pendance des deux r\u00e9glages ===`);
{
    const isoHalfH = (BASE.mouthHeight - BASE.throatDiameter) / 2;

    let prevHalfH = -Infinity;
    for (const h of [-100, -50, 0, 50, 100]) {
        const b = generateDosc({ ...BASE, prismHeightPct: h, filletRadius: rho, numLines: 64, axialPoints: 60 });
        if (!b.ok) { check(`hauteur=${h}% : g\u00e9n\u00e9ration`, false, b.error); continue; }
        const r = computeIsophaseReport(b, { azimuthSamples: 9, fMaxHz: 16000, steps: 1500 });
        const bp = b.params;
        console.log(`  hauteur=${String(h).padStart(4)}% | c\u00f4ne \u03b1_b ${bp.alphaBodyDeg.toFixed(2).padStart(5)}\u00b0`
            + ` | corps \u00bdh ${bp.bodyMouthHalfHeight.toFixed(1).padStart(5)}mm`
            + ` | jeu vert. ${bp.gapConicalThroat.toFixed(1)}\u2192${bp.gapConicalMouth.toFixed(1)}mm`
            + ` | pli ${bp.foldOnsetBody.toFixed(1)}mm`
            + ` | \u0394 mesur\u00e9 ${r.measuredPathDelta.toFixed(2).padStart(6)}mm`);
        check(`hauteur=${h}% : le prisme grandit avec le %`, bp.bodyMouthHalfHeight > prevHalfH,
            `${bp.bodyMouthHalfHeight.toFixed(1)} > ${prevHalfH.toFixed(1)}mm`);
        prevHalfH = bp.bodyMouthHalfHeight;
        // La hauteur ne touche PAS \u00e0 la pente du biseau.
        check(`hauteur=${h}% : pente du biseau inchang\u00e9e`,
            Math.abs(bp.alphaBodyBevelDeg - bp.alphaDeg) < 1e-9, `\u03b1_x ${bp.alphaBodyBevelDeg.toFixed(4)}\u00b0`);
        // \u00c0 largeur 0 %, toute hauteur \u2260 0 % D\u00c9COUPLE les deux pentes, donc
        // courbe le front. L'ancien r\u00e9glage coupl\u00e9 rendait 0 ici : c'est le but.
        if (h !== 0) {
            check(`hauteur=${h}% seule : le front se courbe`, Math.abs(r.measuredPathDelta) > 0.5,
                `\u0394 = ${r.measuredPathDelta.toFixed(2)}mm`);
        }
        if (h > 0) {
            check(`hauteur=${h}% : le jeu vertical se resserre`, bp.gapConicalMouth < bp.gapConicalThroat,
                `${bp.gapConicalMouth.toFixed(1)} < ${bp.gapConicalThroat.toFixed(1)}mm`);
        }
    }

    check('hauteur \u2212100 % : prisme plus court que le brevet',
        deriveDoscParams({ ...BASE, prismHeightPct: -100 }).bodyMouthHalfHeight < isoHalfH);

    // Chaque pente doit \u00eatre pilot\u00e9e par SON seul r\u00e9glage.
    const hOnly = deriveDoscParams({ ...BASE, prismHeightPct: 70, prismWidthPct: 0 });
    const both = deriveDoscParams({ ...BASE, prismHeightPct: 70, prismWidthPct: -60 });
    const wOnly = deriveDoscParams({ ...BASE, prismHeightPct: 0, prismWidthPct: -60 });
    check('la largeur n\u2019affecte pas la pente du c\u00f4ne',
        Math.abs(hOnly.alphaBodyDeg - both.alphaBodyDeg) < 1e-12,
        `${hOnly.alphaBodyDeg.toFixed(6)} vs ${both.alphaBodyDeg.toFixed(6)}\u00b0`);
    check('la hauteur n\u2019affecte pas la pente du biseau',
        Math.abs(wOnly.alphaBodyBevelDeg - both.alphaBodyBevelDeg) < 1e-12,
        `${wOnly.alphaBodyBevelDeg.toFixed(6)} vs ${both.alphaBodyBevelDeg.toFixed(6)}\u00b0`);
}

if (GEO_ONLY || !fs.existsSync(GMSH)) {
    if (!GEO_ONLY) console.log(`\n  SKIP  gmsh introuvable (${GMSH}) — passer --gmsh <chemin>`);
    console.log(`\n=== RÉSULTAT : ${failures === 0 ? 'OK (gmsh non exécuté)' : failures + ' ÉCHEC(S)'} ===\n`);
    process.exit(failures ? 1 : 0);
}

const run = (file, args, budgetMs) => {
    const t0 = Date.now();
    try {
        const out = execFileSync(GMSH, [file, ...args], {
            encoding: 'utf-8', timeout: budgetMs, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true, out, dt: (Date.now() - t0) / 1000 };
    } catch (e) {
        return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message), dt: (Date.now() - t0) / 1000 };
    }
};
const errorsOf = (txt) => (txt.match(/^Error\s*:.*$/gim) || []);

console.log('\n=== 4. GMSH → STEP ===');
const faceCount = {};
for (const b of built.filter(x => x.mode === 'step')) {
    const step = b.file.replace('.geo', '.step');
    const r = run(b.file, ['-0', '-o', step], 120000);
    const errs = errorsOf(r.out);
    check(`${b.name} : gmsh -0 sans erreur`, r.ok && errs.length === 0,
        errs.slice(0, 2).join(' | ') || `${r.dt.toFixed(1)} s`);
    if (fs.existsSync(step)) {
        const txt = fs.readFileSync(step, 'utf-8');
        faceCount[b.name] = (txt.match(/ADVANCED_FACE/g) || []).length;
        check(`${b.name} : surfaces coniques exactes`, /CONICAL_SURFACE/.test(txt));
        check(`${b.name} : PAS de solide (surfacique)`,
            !/MANIFOLD_SOLID_BREP/.test(txt) && !/CLOSED_SHELL/.test(txt));
        check(`${b.name} : contient des faces`, faceCount[b.name] > 0, `${faceCount[b.name]} faces`);
    }
}
if (faceCount['plein_interface'] && faceCount['plein_sans_iface']) {
    // Interface = +1 fermeture de gorge, +paroi extrudée, +face plane avant.
    check('l\'interface ajoute bien des faces (gorge + paroi + face)',
        faceCount['plein_interface'] > faceCount['plein_sans_iface'],
        `${faceCount['plein_sans_iface']} → ${faceCount['plein_interface']}`);
}

/**
 * Analyse un .msh2 : étendue axiale et nombre d'arêtes de bord (arêtes portées
 * par un seul triangle). C'est LE test « surfacique » : une coque fermée n'a
 * aucune arête de bord, une coque ouverte en a.
 */
function analyseMsh(file) {
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    let i = lines.indexOf('$Nodes');
    const nNodes = Number(lines[i + 1]);
    let zmin = Infinity, zmax = -Infinity;
    for (let k = 0; k < nNodes; k++) {
        const f = lines[i + 2 + k].split(/\s+/);
        const z = Number(f[3]);
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
    }
    i = lines.indexOf('$Elements');
    const nEl = Number(lines[i + 1]);
    const edge = new Map();
    let nTri = 0;
    for (let k = 0; k < nEl; k++) {
        const f = lines[i + 2 + k].trim().split(/\s+/).map(Number);
        if (f[1] !== 2) continue;
        const v = f.slice(3 + f[2]);
        nTri++;
        for (let e = 0; e < 3; e++) {
            const a = v[e], b = v[(e + 1) % 3];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            edge.set(key, (edge.get(key) || 0) + 1);
        }
    }
    let boundary = 0;
    for (const c of edge.values()) if (c === 1) boundary++;
    return { zmin, zmax, nTri, boundary };
}

console.log('\n=== 5. GMSH → MSH ===');
for (const b of built.filter(x => x.mode === 'mesh')) {
    const msh = b.file.replace('.geo', '.msh');
    const r = run(b.file, ['-2', '-format', 'msh2', '-o', msh], 180000);
    const errs = errorsOf(r.out);
    check(`${b.name} : gmsh -2 sans erreur`, r.ok && errs.length === 0,
        errs.slice(0, 2).join(' | ') || `${r.dt.toFixed(1)} s`);
    check(`${b.name} : aucun élément invalide`, !/remain invalid/i.test(r.out));
    if (!fs.existsSync(msh)) continue;

    const a = analyseMsh(msh);
    check(`${b.name} : maillage non vide`, a.nTri > 100, `${a.nTri} triangles`);
    // Gorge en z = -depth, bouche en z = 0, interface jusqu'à +tipOffset.
    check(`${b.name} : gorge à z = -${params.depth}`, Math.abs(a.zmin + params.depth) < 0.5, a.zmin.toFixed(2));
    const expectedZmax = b.iface ? 30 : 0;
    check(`${b.name} : bouche à z = ${expectedZmax}`, Math.abs(a.zmax - expectedZmax) < 0.5, a.zmax.toFixed(2));
    // Sans interface la coque DOIT être ouverte (gorge + bouche béantes).
    // Avec interface ET sans coupe, gorge fermée + face avant ⇒ coque close.
    const cut = b.split.horizontal || b.split.vertical;
    if (b.iface && !cut) {
        check(`${b.name} : coque fermée (interface ⇒ gorge + face avant)`, a.boundary === 0, `${a.boundary} arêtes de bord`);
    } else if (!b.iface) {
        check(`${b.name} : coque OUVERTE (ni gorge ni bouche fermées)`, a.boundary > 0, `${a.boundary} arêtes de bord`);
    } else {
        check(`${b.name} : ouverte le long du plan de coupe`, a.boundary > 0, `${a.boundary} arêtes de bord`);
    }
}

console.log(`\n=== RÉSULTAT : ${failures === 0 ? 'TOUT OK' : failures + ' ÉCHEC(S)'} ===\n`);
process.exit(failures ? 1 : 0);
