// =======================================================
// scripts/dosc_geo_diag.mjs
//
// Bissection du problème « elements remain invalid in surface N » : gmsh boucle
// sur l'optimisation d'une surface lofée dégénérée. On teste une matrice de
// variantes, chacune avec un budget de temps court, pour isoler la cause.
//
// Usage : node scripts/dosc_geo_diag.mjs [--budget 30]
// =======================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateDosc, stackToSlices } from '../src/js/panels/waveguidestudio/dosc/doscGenerator.js';
import { generateGeoForDoscLoft } from '../src/js/panels/waveguidestudio/exporters.js';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out', 'dosc_diag');
fs.mkdirSync(OUT, { recursive: true });

const GMSH = resolveGmsh();
const argv = process.argv.slice(2);
const budgetMs = 1000 * (argv.includes('--budget') ? Number(argv[argv.indexOf('--budget') + 1]) : 30);

const BASE = { throatDiameter: 35, mouthWidth: 30, mouthHeight: 220, depth: 244, filletRadius: 3 };

function runGmsh(geoPath, args) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const p = spawn(GMSH, [geoPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stdout.on('data', () => {});
        p.stderr.on('data', (d) => { err += d.toString(); });
        const timer = setTimeout(() => { p.kill('SIGKILL'); }, budgetMs);
        p.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({
                seconds: (Date.now() - t0) / 1000,
                killed: signal === 'SIGKILL' || Date.now() - t0 >= budgetMs - 200,
                invalid: (err.match(/elements remain invalid/g) || []).length,
                errors: (err.match(/^Error\s*:.*/gm) || []).slice(0, 2),
            });
        });
    });
}

/** Écrit un .geo et le fait mailler ; renvoie une ligne de rapport. */
async function trial(label, geo) {
    const f = path.join(OUT, label.replace(/[^\w.-]+/g, '_') + '.geo');
    fs.writeFileSync(f, geo);
    const r = await runGmsh(f, ['-2', '-format', 'msh2', '-o', f.replace('.geo', '.msh'), '-v', '1']);
    const verdict = r.killed ? 'TIMEOUT' : (r.errors.length ? 'ERROR' : 'ok');
    console.log(
        `  ${label.padEnd(42)} ${verdict.padEnd(8)} ${r.seconds.toFixed(1).padStart(6)}s` +
        `  invalid-loops=${String(r.invalid).padStart(4)}` +
        (r.errors.length ? '  ' + r.errors[0].slice(0, 70) : '')
    );
    return { ...r, ok: !r.killed && !r.errors.length };
}

/** Ne garde que la nappe demandée, en neutralisant l'autre loft. */
function buildGeo({ axialPoints, numLines, onlyHousing = false, onlyBody = false, iface = true }) {
    const built = generateDosc({ ...BASE, numLines, axialPoints });
    const h = stackToSlices(built.housing, built.params.depth);
    const b = stackToSlices(built.body, built.params.depth);
    // Pour isoler une nappe, on remplace l'autre par deux sections quasi
    // confondues et minuscules loin du guide : elle maille instantanément et
    // n'interfère pas.
    const stub = [0, 1].map(i => ({
        points3D: Array.from({ length: numLines }, (_, j) => {
            const a = (2 * Math.PI * j) / numLines;
            return { x: 0.5 * Math.cos(a), y: 0.5 * Math.sin(a), z: -1000 - i };
        }),
    }));
    return generateGeoForDoscLoft(
        onlyBody ? stub : h,
        onlyHousing ? stub : b,
        iface, iface ? 30 : 0,
        { clmax: 10, curvature: 5 },
    );
}

console.log(`\nBudget par essai : ${budgetMs / 1000} s\n`);
console.log('=== 1. Effet du nombre de sections axiales (N angulaire = 48) ===');
for (const A of [8, 14, 28]) {
    await trial(`axialPoints=${A}`, buildGeo({ axialPoints: A, numLines: 48 }));
}

console.log('\n=== 2. Quelle nappe est en cause ? (axialPoints=14) ===');
await trial('carter seul', buildGeo({ axialPoints: 14, numLines: 48, onlyHousing: true }));
await trial('corps seul', buildGeo({ axialPoints: 14, numLines: 48, onlyBody: true }));

console.log('\n=== 3. Effet du nombre de points angulaires (axialPoints=14) ===');
for (const N of [16, 32, 48, 96]) {
    await trial(`numLines=${N}`, buildGeo({ axialPoints: 14, numLines: N }));
}

console.log('\n=== 4. Sans interface ===');
await trial('axialPoints=14, sans interface', buildGeo({ axialPoints: 14, numLines: 48, iface: false }));

console.log('');
