// =======================================================
// scripts/dosc_mesh_diag.mjs
//
// La géométrie DOSC se construit en 0,6 s (gmsh -0) : le blocage est dans le
// MAILLEUR. On balaye les réglages de maillage sur la géométrie inchangée pour
// trouver ceux qui aboutissent.
//
// Usage : node scripts/dosc_mesh_diag.mjs [--geo <fichier>] [--budget 20]
// =======================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GMSH = resolveGmsh();
const argv = process.argv.slice(2);
const opt = (n, d) => { const k = argv.indexOf(n); return k >= 0 ? argv[k + 1] : d; };
const GEO = opt('--geo', path.join(__dirname, 'out', 'dosc_diag', 'numLines_48.geo'));
const budgetMs = 1000 * Number(opt('--budget', 20));
const OUT = path.join(__dirname, 'out', 'dosc_meshdiag');
fs.mkdirSync(OUT, { recursive: true });

// On repart du .geo tel quel, en retirant seulement son bloc de réglages de
// maillage pour le remplacer par celui de la variante testée.
const base = fs.readFileSync(GEO, 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^Mesh\./.test(l))
    .join('\n');

function run(file, args) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const p = spawn(GMSH, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stdout.on('data', () => {});
        p.stderr.on('data', (d) => { err += d.toString(); });
        const timer = setTimeout(() => p.kill('SIGKILL'), budgetMs);
        p.on('close', (_c, signal) => {
            clearTimeout(timer);
            resolve({
                s: (Date.now() - t0) / 1000,
                timeout: signal === 'SIGKILL' || Date.now() - t0 >= budgetMs - 300,
                invalid: (err.match(/elements remain invalid/g) || []).length,
                errors: (err.match(/^Error\s*:.*/gm) || []).slice(0, 1),
            });
        });
    });
}

async function trial(label, meshLines) {
    const f = path.join(OUT, label.replace(/[^\w]+/g, '_') + '.geo');
    fs.writeFileSync(f, base + '\n' + meshLines.join('\n') + '\n');
    const msh = f.replace('.geo', '.msh');
    const r = await run(f, ['-2', '-format', 'msh2', '-o', msh, '-v', '1']);
    let tris = 0;
    if (!r.timeout && fs.existsSync(msh)) {
        const t = fs.readFileSync(msh, 'utf8');
        tris = (t.match(/^\d+ 2 /gm) || []).length;
    }
    const verdict = r.timeout ? 'TIMEOUT' : (r.errors.length ? 'ERROR' : 'ok');
    console.log(`  ${label.padEnd(44)} ${verdict.padEnd(8)} ${r.s.toFixed(1).padStart(5)}s` +
        `  tris=${String(tris).padStart(7)}  invalid=${String(r.invalid).padStart(3)}` +
        (r.errors.length ? '  ' + r.errors[0].slice(0, 60) : ''));
    return r;
}

console.log(`\nSource : ${path.relative(process.cwd(), GEO)}   budget ${budgetMs / 1000} s\n`);

console.log('=== Algorithme 2D (clmax=10, curvature=5) ===');
// 1=MeshAdapt, 2=Auto, 5=Delaunay, 6=Frontal-Delaunay, 7=BAMG, 8=Frontal-Quad, 9=Packing
for (const [n, name] of [[1, 'MeshAdapt'], [5, 'Delaunay'], [6, 'Frontal-Delaunay (actuel)'], [2, 'Auto']]) {
    await trial(`Algorithm=${n} ${name}`, [
        'Mesh.CharacteristicLengthMax = 10;',
        'Mesh.MeshSizeFromCurvature = 5;',
        `Mesh.Algorithm = ${n};`,
    ]);
}

console.log('\n=== Optimisation désactivée (Frontal-Delaunay) ===');
await trial('Optimize=0, OptimizeNetgen=0', [
    'Mesh.CharacteristicLengthMax = 10;',
    'Mesh.MeshSizeFromCurvature = 5;',
    'Mesh.Algorithm = 6;',
    'Mesh.Optimize = 0;',
    'Mesh.OptimizeNetgen = 0;',
]);

console.log('\n=== Borne inférieure de taille d\'élément ===');
for (const mn of [0.5, 1, 2]) {
    await trial(`MeshSizeMin=${mn}`, [
        'Mesh.CharacteristicLengthMax = 10;',
        `Mesh.MeshSizeMin = ${mn};`,
        'Mesh.MeshSizeFromCurvature = 5;',
        'Mesh.Algorithm = 6;',
    ]);
}

console.log('\n=== Sans extension de taille depuis les points / bords ===');
await trial('SizeFromPoints=0, SizeExtendFromBoundary=0', [
    'Mesh.CharacteristicLengthMax = 10;',
    'Mesh.MeshSizeFromCurvature = 5;',
    'Mesh.MeshSizeFromPoints = 0;',
    'Mesh.MeshSizeExtendFromBoundary = 0;',
    'Mesh.Algorithm = 6;',
]);

console.log('');
