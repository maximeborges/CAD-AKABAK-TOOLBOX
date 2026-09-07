// =======================================================
// scripts/dosc_geo_bisect.mjs
//
// Bisection du .geo DOSC : on tronque le fichier après chaque étape majeure et
// on lance `gmsh -0` (géométrie seule) avec un budget court. La première
// troncature qui expire désigne l'opération fautive.
//
// Usage : node scripts/dosc_geo_bisect.mjs [--geo <fichier>] [--budget 15]
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
const budgetMs = 1000 * Number(opt('--budget', 15));
const OUT = path.join(__dirname, 'out', 'dosc_bisect');
fs.mkdirSync(OUT, { recursive: true });

const src = fs.readFileSync(GEO, 'utf8').split(/\r?\n/);

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
                errors: (err.match(/^Error\s*:.*/gm) || []).slice(0, 2),
            });
        });
    });
}

// Repères d'étape présents dans le .geo généré.
const MARKERS = [
    ['points + contours seuls', /^\/\/ =+ Carter/],
    ['+ ThruSections carter', /^_hbnd\(\) =/],
    ['+ retrait capots carter', /^\/\/ =+ Corps interne/],
    ['+ ThruSections corps', /^_bbnd\(\) =/],
    ['+ retrait capots corps', /^\/\/ --- Body nose flat/],
    ['+ méplats du corps', /^\/\/ --- Throat cap/],
    ['+ capot de gorge', /^\/\/ --- Interface wall/],
    ['fichier complet', null],
];

console.log(`\nSource : ${path.relative(process.cwd(), GEO)}`);
console.log(`Budget : ${budgetMs / 1000} s par troncature (gmsh -0, géométrie seule)\n`);

for (const [label, re] of MARKERS) {
    let cut = src.length;
    if (re) {
        const idx = src.findIndex(l => re.test(l));
        if (idx < 0) { console.log(`  ${label.padEnd(30)} (repère absent, ignoré)`); continue; }
        cut = idx;
    }
    // On retire le bloc Physical/Mesh de fin, inutile en -0 et qui référencerait
    // des entités absentes dans une troncature.
    const body = src.slice(0, cut).filter(l => !/^Physical Surface|^Mesh\./.test(l));
    const f = path.join(OUT, label.replace(/[^\w]+/g, '_') + '.geo');
    fs.writeFileSync(f, body.join('\n') + '\n');
    const r = await run(f, ['-0', '-o', f.replace('.geo', '.brep')]);
    const verdict = r.timeout ? 'TIMEOUT' : (r.errors.length ? 'ERROR' : 'ok');
    console.log(`  ${label.padEnd(30)} ${verdict.padEnd(8)} ${r.s.toFixed(1).padStart(5)}s` +
        (r.errors.length ? '  ' + r.errors[0].slice(0, 80) : ''));
}
console.log('');
