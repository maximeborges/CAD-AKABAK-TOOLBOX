// Replay a real exported waveguide_loft.geo through the current generator:
// parses the ring points back out of the .geo and regenerates + meshes it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateGeoForSTEPLoft } from '../src/js/panels/waveguidestudio/exporters.js';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoPath = process.argv[2];
const gmshPath = resolveGmsh(process.argv[3]);
if (!geoPath) { console.error('usage: node scripts/replay_waveguide_geo.mjs <debug_loft.geo> [gmsh.exe]'); process.exit(1); }

const src = fs.readFileSync(geoPath, 'utf8');

const points = new Map();
for (const m of src.matchAll(/^Point\((\d+)\)\s*=\s*\{([^}]+)\};/gm)) {
    const [x, y, z] = m[2].split(',').map(Number);
    points.set(Number(m[1]), { x, y, z });
}
const rings = [];
for (const m of src.matchAll(/^BSpline\((\d+)\)\s*=\s*\{([^}]+)\};/gm)) {
    const ids = m[2].split(',').map(s => Number(s.trim()));
    const pts = ids.map(id => points.get(id)).filter(Boolean);
    // A closed ring repeats its first point; a pre-split arc does not.
    const closed = ids.length > 1 && ids[0] === ids[ids.length - 1];
    rings.push({ points3D: closed ? pts.slice(0, -1) : pts, origZ: pts[0].z, closed });
}
if (rings.length < 2) { console.error('no rings found'); process.exit(1); }

const preSplit = !rings[0].closed;
const cornerCount = [...src.matchAll(/^Point\(\d+\)\s*=\s*\{0, 0, /gm)].length;
const quarter = preSplit && cornerCount >= rings.length;
const hasNegX = rings.some(r => r.points3D.some(p => p.x < -1e-6));
const hasNegY = rings.some(r => r.points3D.some(p => p.y < -1e-6));
const split = preSplit
    ? { horizontal: !hasNegY, vertical: quarter ? !hasNegX : hasNegX ? false : !hasNegX }
    : { horizontal: false, vertical: false };
const tipOffset = Number((src.match(/Extrude \{0, 0, ([\d.]+)\}/) || [])[1] || 0);

console.log(`rings=${rings.length} pts/ring=${rings[0].points3D.length} preSplit=${preSplit} split=H:${split.horizontal} V:${split.vertical} tipOffset=${tipOffset}`);

// Same section-count reduction the exporter applies.
const selectKey = (slices, n) => {
    if (slices.length <= n) return slices;
    const out = [slices[0]];
    for (let i = 1; i <= n - 2; i++) out.push(slices[Math.round(i / (n - 1) * (slices.length - 1))]);
    out.push(slices[slices.length - 1]);
    return [...new Set(out)];
};
const sections = Number(process.env.SECTIONS || 0);
const used = sections > 0 ? selectKey(rings, sections) : rings;
console.log(`sections used: ${used.length}`);

const outDir = path.join(__dirname, 'out', 'replay');
fs.mkdirSync(outDir, { recursive: true });

// The interface wall the renderer produces for a bent horn: the mouth ring
// translated forward, keeping its bend.
const mouth = used[used.length - 1];
const shift = dz => ({ ...mouth, points3D: mouth.points3D.map(p => ({ ...p, z: p.z + dz })) });
const wall = tipOffset > 0 ? [shift(0), shift(tipOffset / 2), shift(tipOffset)] : null;

const variants = [
    { label: 'loft (interface lofted)', wall },
    { label: 'loft (interface droite)', wall: null },
];

const meshCfg = {
    clmax: Number(process.env.CLMAX || 10),
    curvature: Number(process.env.CURV ?? 5),
};
console.log(`meshConfig: clmax=${meshCfg.clmax} curvature=${meshCfg.curvature}`);

const STEP_MODE = process.env.STEP === '1';
let anyPass = false;
for (const v of variants) {
    if (!v.wall && !tipOffset) continue;
    const geo = generateGeoForSTEPLoft(used, true, tipOffset, STEP_MODE ? null : meshCfg, split, v.wall, preSplit);
    const base = `replay_${v.wall ? 'lofted' : 'extruded'}`;
    const outGeo = path.join(outDir, `${base}.geo`);
    const outMsh = path.join(outDir, STEP_MODE ? `${base}.step` : `${base}.msh`);
    fs.writeFileSync(outGeo, geo);
    fs.rmSync(outMsh, { force: true });

    const args = STEP_MODE
        ? [outGeo, '-0', '-o', outMsh]
        : [outGeo, '-2', '-format', 'msh2', '-o', outMsh];
    let output = '';
    const t0 = Date.now();
    try {
        output = execFileSync(gmshPath, args, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
        });
    } catch (e) { output = `${e.stdout || ''}${e.stderr || ''}`; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const errs = output.split('\n').filter(l => /^Error/.test(l));
    if (errs.length || !fs.existsSync(outMsh)) {
        console.log(`${v.label}: FAIL in ${secs} s — ${errs[0] || 'no output'}`);
        continue;
    }
    if (STEP_MODE) {
        console.log(`${v.label}: PASS in ${secs} s  (STEP ${(fs.statSync(outMsh).size / 1024).toFixed(0)} KB)`);
        anyPass = true;
        continue;
    }
    const msh = fs.readFileSync(outMsh, 'utf8');
    const missing = ['horn_surface', 'throat_cap', 'interface_wall', 'interface_face']
        .filter(n => !msh.includes(`"${n}"`));
    const zs = msh.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1)
        .map(l => Number(l.trim().split(/\s+/)[3]));
    console.log(`${v.label}: PASS in ${secs} s  maxZ=${Math.max(...zs).toFixed(1)}${missing.length ? '  MISSING ' + missing.join(',') : ''}`);
    anyPass = true;
}
process.exit(anyPass ? 0 : 1);
