// Inventaire des surfaces d'un .msh : nombre de triangles, aire, boîte englobante.
import { readFileSync } from 'node:fs';
import { resolveDataFile } from './lib/env_paths.mjs';

const study = JSON.parse(readFileSync(resolveDataFile('AKABAK CURVES/horn.TBBS', { explicit: process.argv[2] }), 'utf8'));
const msh = study.mesh || readFileSync(process.argv[2], 'utf8');

const names = new Map();
for (const line of msh.split('$PhysicalNames')[1].split('$EndPhysicalNames')[0].trim().split('\n').slice(1)) {
  const m = line.trim().match(/^\d+\s+(\d+)\s+"(.+)"$/);
  if (m) names.set(Number(m[1]), m[2]);
}
const nodes = new Map();
for (const line of msh.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1)) {
  const f = line.trim().split(/\s+/).map(Number);
  nodes.set(f[0], [f[1], f[2], f[3]]);
}
const per = new Map();
for (const line of msh.split('$Elements')[1].split('$EndElements')[0].trim().split('\n').slice(1)) {
  const f = line.trim().split(/\s+/).map(Number);
  if (f[1] !== 2) continue;
  const off = 3 + f[2];
  const v = [nodes.get(f[off]), nodes.get(f[off + 1]), nodes.get(f[off + 2])];
  const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
  const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const area = Math.hypot(n[0], n[1], n[2]) / 2;
  let r = per.get(f[3]);
  if (!r) { r = { n: 0, area: 0, lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] }; per.set(f[3], r); }
  r.n++; r.area += area;
  for (const p of v) for (let k = 0; k < 3; k++) { if (p[k] < r.lo[k]) r.lo[k] = p[k]; if (p[k] > r.hi[k]) r.hi[k] = p[k]; }
}
for (const [tag, r] of [...per.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`${(names.get(tag) || tag).padEnd(20)} ${String(r.n).padStart(4)} tri  ${(r.area / 100).toFixed(1).padStart(8)} cm²  ` +
    `x[${r.lo[0].toFixed(1)},${r.hi[0].toFixed(1)}] y[${r.lo[1].toFixed(1)},${r.hi[1].toFixed(1)}] z[${r.lo[2].toFixed(1)},${r.hi[2].toFixed(1)}]`);
}
