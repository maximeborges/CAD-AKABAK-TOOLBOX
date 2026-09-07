// Validates the waveguide STEP/MSH .geo pipeline:
//  - a non-planar interface contour (arced/radial horn) can be closed and meshed
//  - symmetry splits are applied as an OCC boolean on the FULL model, so the
//    interface wall/face survive the cut
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateGeoForSTEPLoft } from '../src/js/panels/waveguidestudio/exporters.js';
import { resolveGmsh } from './lib/env_paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out', 'arced_interface');
const gmshPath = resolveGmsh(process.argv[2]);

const ring = (radius, z, bend = 0, split = null, n = 24) => {
    const pts = [];
    for (let index = 0; index < n; index++) {
        const angle = index * 2 * Math.PI / n;
        const x = radius * Math.cos(angle);
        const y = radius * Math.sin(angle);
        if (split?.horizontal && y < -1e-9) continue;
        if (split?.vertical && x < -1e-9) continue;
        pts.push({ x, y, z: z + bend * (1 - (y / radius) ** 2) });
    }
    if (split) {
        pts.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        const m = pts.length;
        if (split.horizontal && split.vertical) { pts[0].y = 0; pts[m - 1].x = 0; }
        else if (split.horizontal) { pts[0].y = 0; pts[m - 1].y = 0; }
        else { pts[0].x = 0; pts[m - 1].x = 0; }
    }
    return { points3D: pts, origZ: z };
};

const straightHorn = [ring(15, -100), ring(35, -50), ring(60, 0)];
const bentHorn = [ring(15, -100), ring(35, -50, 2), ring(60, 0, 6)];
const bentWall = [ring(60, 0, 6), ring(60, 10, 6), ring(60, 20, 0)];
// Bent + symmetry uses the pre-split path: rings are clipped by the caller and
// the interface plane is flattened (as buildGeoCandidates does).
const clip = s => [ring(15, -100, 0, s), ring(35, -50, 2, s), ring(60, 0, 6, s)];
const clipWall = s => [ring(60, 0, 6, s), ring(60, 10, 6, s), ring(60, 20, 0, s)];

// Production-like sampling: many sections, 100 points per ring.
const DENSE_SECTIONS = Number(process.env.DENSE_SECTIONS || 100);
const denseHorn = (s) => {
    const out = [];
    for (let i = 0; i <= DENSE_SECTIONS; i++) {
        const t = i / DENSE_SECTIONS;
        out.push(ring(15 + 45 * t * t, -100 + 100 * t, 6 * t, s, 100));
    }
    return out;
};
const denseWall = (s) => [ring(60, 0, 6, s, 100), ring(60, 10, 6, s, 100), ring(60, 20, 0, s, 100)];

// Strongly arced horn: the mouth ring Z spans a large fraction of the mouth
// size, like a big Arced Horn angle. The interface wall must stay a forward
// translation of that bent ring — flattening its far ring folds it inwards.
const ARC = 40;
const arcHorn = (s) => {
    const out = [];
    for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        out.push(ring(15 + 45 * t * t, -100 + 100 * t, ARC * t, s, 100));
    }
    return out;
};
const arcWall = (s) => [ring(60, 0, ARC, s, 100), ring(60, 5, ARC, s, 100), ring(60, 10, ARC, s, 100)];
// Interface face as the renderer builds it: concentric rings from the edge
// inwards, the bend fading out so the centre lands on the interface plane.
const arcFace = (s) => [1, 0.6, 0.3, 0.08].map(k => ring(60 * k, 10, ARC * k, s, 100));

const meshConfig = { clmax: 8, curvature: 0 };

fs.mkdirSync(outDir, { recursive: true });

const H = { horizontal: true, vertical: false };
const V = { horizontal: false, vertical: true };
const HV = { horizontal: true, vertical: true };
const NONE = { horizontal: false, vertical: false };

const cases = [
    { name: 'full_straight', split: NONE, horn: straightHorn, wall: null },
    { name: 'full_bent', split: NONE, horn: bentHorn, wall: bentWall },
    { name: 'split_h_straight', split: H, horn: straightHorn, wall: null },
    { name: 'split_v_straight', split: V, horn: straightHorn, wall: null },
    { name: 'split_hv_straight', split: HV, horn: straightHorn, wall: null },
    { name: 'split_h_bent', split: H, horn: clip(H), wall: clipWall(H), preSplit: true },
    { name: 'split_v_bent', split: V, horn: clip(V), wall: clipWall(V), preSplit: true },
    { name: 'split_hv_bent', split: HV, horn: clip(HV), wall: clipWall(HV), preSplit: true },
    // Production-like: many sections, and the fallback candidate that extrudes
    // the interface instead of lofting it.
    { name: 'split_hv_bent_dense', split: HV, horn: denseHorn(HV), wall: denseWall(HV), preSplit: true },
    { name: 'split_hv_bent_extrude', split: HV, horn: denseHorn(HV), wall: null, preSplit: true },
    { name: 'split_h_bent_extrude', split: H, horn: denseHorn(H), wall: null, preSplit: true },
    { name: 'full_bent_dense', split: NONE, horn: denseHorn(null), wall: denseWall(null) },
    { name: 'split_hv_arced', split: HV, horn: arcHorn(HV), wall: arcWall(HV), preSplit: true, arc: ARC },
    { name: 'full_arced', split: NONE, horn: arcHorn(null), wall: arcWall(null), arc: ARC },
    { name: 'split_hv_arced_face', split: HV, horn: arcHorn(HV), wall: arcWall(HV), face: arcFace(HV), preSplit: true, arc: ARC },
    { name: 'full_arced_face', split: NONE, horn: arcHorn(null), wall: arcWall(null), face: arcFace(null), arc: ARC },
];

let failures = 0;
for (const c of cases) {
    const expected = ['horn_surface', 'throat_cap', 'interface_wall', 'interface_face'];

    const geo = generateGeoForSTEPLoft(c.horn, true, 20, meshConfig, c.split, c.wall, !!c.preSplit, c.face || null);
    const geoPath = path.join(outDir, `${c.name}.geo`);
    const mshPath = path.join(outDir, `${c.name}.msh`);
    fs.writeFileSync(geoPath, geo);
    fs.rmSync(mshPath, { force: true });

    let output = '';
    try {
        output = execFileSync(gmshPath, [geoPath, '-2', '-format', 'msh2', '-o', mshPath], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
        });
    } catch (e) {
        output = `${e.stdout || ''}${e.stderr || ''}`;
    }

    if (/^Error\s*:/m.test(output) || !fs.existsSync(mshPath)) {
        console.error(`FAIL ${c.name}: gmsh could not mesh\n${output}`);
        failures++;
        continue;
    }
    const msh = fs.readFileSync(mshPath, 'utf8');
    const missing = expected.filter(n => !msh.includes(`"${n}"`));
    if (missing.length) {
        console.error(`FAIL ${c.name}: missing physical groups ${missing.join(', ')}`);
        failures++;
        continue;
    }

    // Map physical tag -> name, then count elementary entities per group.
    const names = new Map();
    for (const line of msh.split('$PhysicalNames')[1].split('$EndPhysicalNames')[0].trim().split('\n').slice(1)) {
        const m = line.trim().match(/^\d+\s+(\d+)\s+"(.+)"$/);
        if (m) names.set(Number(m[1]), m[2]);
    }
    const perGroup = new Map();
    const nodesOf = new Map();
    for (const line of msh.split('$Elements')[1].split('$EndElements')[0].trim().split('\n').slice(1)) {
        const f = line.trim().split(/\s+/).map(Number);
        if (f[1] !== 2) continue; // triangles only
        const name = names.get(f[3]);
        if (!name) continue;
        if (!perGroup.has(name)) { perGroup.set(name, new Set()); nodesOf.set(name, new Set()); }
        perGroup.get(name).add(f[4]);
        for (const id of f.slice(5, 8)) nodesOf.get(name).add(id);
    }
    const detail = expected.map(n => `${n}:${perGroup.get(n)?.size ?? 0}`).join(' ');

    // The symmetry cut must actually have removed the discarded half/quarter.
    const nodeBlock = msh.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1);
    const coords = new Map();
    let minX = Infinity, minY = Infinity, maxR = 0, maxZ = -Infinity;
    for (const line of nodeBlock) {
        const [id, x, y, z] = line.trim().split(/\s+/).map(Number);
        coords.set(id, [x, y, z]);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z > maxZ) maxZ = z;
        maxR = Math.max(maxR, Math.hypot(x, y));
    }
    const TOL = 1e-3;
    // The mouth radius is 60: an OCC filling that balloons past it means the
    // interface face is not a proper cap.
    if (maxR > 60.5) {
        console.error(`FAIL ${c.name}: cap balloons to r=${maxR.toFixed(1)} (max 60)`);
        failures++;
        continue;
    }
    // The interface must be a forward translation of the bent mouth ring; if it
    // is flattened it folds back inwards and maxZ collapses.
    if (c.arc) {
        const wantZ = c.wall[c.wall.length - 1].points3D.reduce((a, p) => Math.max(a, p.z), -Infinity);
        if (maxZ < wantZ - 0.5) {
            console.error(`FAIL ${c.name}: interface folds inwards (maxZ=${maxZ.toFixed(1)}, expected ${wantZ.toFixed(1)})`);
            failures++;
            continue;
        }
    }
    // The interface face must follow the renderer's concentric rings; an OCC
    // filling instead caves in towards the axis, i.e. its nodes near the axis
    // sit well behind the interface plane.
    if (c.face) {
        const ref = c.face;
        const planeZ = Math.min(...ref[ref.length - 1].points3D.map(p => p.z));
        let axisZ = Infinity;
        for (const id of nodesOf.get('interface_face') || []) {
            const [x, y, z] = coords.get(id);
            if (Math.hypot(x, y) < 8) axisZ = Math.min(axisZ, z);
        }
        if (axisZ < planeZ - 1) {
            console.error(`FAIL ${c.name}: face caves in (z=${axisZ.toFixed(1)} on axis, plane at ${planeZ.toFixed(1)})`);
            failures++;
            continue;
        }
    }
    if (c.split.vertical && minX < -TOL) {
        console.error(`FAIL ${c.name}: vertical split kept x=${minX}`);
        failures++;
        continue;
    }
    if (c.split.horizontal && minY < -TOL) {
        console.error(`FAIL ${c.name}: horizontal split kept y=${minY}`);
        failures++;
        continue;
    }
    console.log(`PASS ${c.name} [entities per group] ${detail}`);
}

if (failures) process.exit(1);

// STEP export path (meshConfig = null): the cutting box must not survive in
// the model, otherwise it lands in the .step file.
for (const c of cases.filter(x => x.split.horizontal || x.split.vertical)) {
    const geo = generateGeoForSTEPLoft(c.horn, true, 20, null, c.split, c.wall, !!c.preSplit);
    const geoPath = path.join(outDir, `${c.name}_step.geo`);
    const mshPath = path.join(outDir, `${c.name}_step.msh`);
    fs.writeFileSync(geoPath, geo);
    fs.rmSync(mshPath, { force: true });
    try {
        execFileSync(gmshPath, [geoPath, '-2', '-format', 'msh2', '-clmax', '20', '-o', mshPath], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
        });
    } catch (e) { /* checked below */ }
    if (!fs.existsSync(mshPath)) {
        console.error(`FAIL ${c.name}_step: gmsh produced nothing`);
        failures++;
        continue;
    }
    const nodes = fs.readFileSync(mshPath, 'utf8').split('$Nodes')[1].split('$EndNodes')[0]
        .trim().split('\n').slice(1);
    let maxAbs = 0;
    for (const line of nodes) {
        const [, x, y, z] = line.trim().split(/\s+/).map(Number);
        maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
    }
    if (maxAbs > 200) {
        console.error(`FAIL ${c.name}_step: cutting box left in the model (max |coord| = ${maxAbs})`);
        failures++;
        continue;
    }
    console.log(`PASS ${c.name}_step (no leftover box, max |coord| = ${maxAbs.toFixed(1)})`);
}

if (failures) process.exit(1);

// Adaptive sizing resolves the throat curve at .geo runtime (its tag is not
// known after the boolean cut).
for (const c of [cases[0], cases[4], cases[7]]) {
    const geo = generateGeoForSTEPLoft(c.horn, true, 20, { ...meshConfig, adaptive: true }, c.split, c.wall, !!c.preSplit);
    const geoPath = path.join(outDir, `${c.name}_adaptive.geo`);
    const mshPath = path.join(outDir, `${c.name}_adaptive.msh`);
    fs.writeFileSync(geoPath, geo);
    fs.rmSync(mshPath, { force: true });
    let output = '';
    try {
        output = execFileSync(gmshPath, [geoPath, '-2', '-format', 'msh2', '-o', mshPath], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
        });
    } catch (e) { output = `${e.stdout || ''}${e.stderr || ''}`; }
    if (/^Error\s*:/m.test(output) || !fs.existsSync(mshPath)) {
        console.error(`FAIL ${c.name}_adaptive: ${output}`);
        failures++;
        continue;
    }
    console.log(`PASS ${c.name}_adaptive`);
}

if (failures) process.exit(1);
console.log('All waveguide .geo cases meshed with their BEM groups.');