// Inspection ponctuelle d'un .msh : groupes, tailles, étendue en z.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: node scripts/msh_inspect.mjs <mesh.msh>');
    process.exit(2);
}
const txt = readFileSync(path, 'utf8');
const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

let i = lines.indexOf('$PhysicalNames');
const names = new Map();
if (i !== -1) {
  const n = parseInt(lines[i + 1], 10);
  for (let k = 0; k < n; k++) {
    const m = lines[i + 2 + k].match(/(\d+)\s+(\d+)\s+"([^"]+)"/);
    if (m) names.set(`${m[1]}:${m[2]}`, m[3]);
  }
}
console.log('PhysicalNames:', names.size ? [...names.entries()] : '(none)');

i = lines.indexOf('$Nodes');
const nNodes = parseInt(lines[i + 1], 10);
const nodes = new Map();
for (let k = 0; k < nNodes; k++) {
  const p = lines[i + 2 + k].split(/\s+/);
  nodes.set(+p[0], [+p[1], +p[2], +p[3]]);
}

i = lines.indexOf('$Elements');
const nEl = parseInt(lines[i + 1], 10);
const groups = new Map();
for (let k = 0; k < nEl; k++) {
  const p = lines[i + 2 + k].split(/\s+/).map(Number);
  if (p[1] !== 2) continue;
  const nt = p[2], phys = p[3], elem = p[4], off = 3 + nt;
  const key = `phys=${phys} elem=${elem}`;
  const v = [nodes.get(p[off]), nodes.get(p[off + 1]), nodes.get(p[off + 2])];
  if (!v[0] || !v[1] || !v[2]) continue;
  const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
  const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const len = Math.hypot(nx, ny, nz);
  const area = len / 2;
  const g = groups.get(key) || { count: 0, area: 0, zMin: Infinity, zMax: -Infinity, sumNz: 0, maxEdge: 0 };
  g.count++; g.area += area;
  g.sumNz += (nz / len) * area;
  for (const p3 of v) { g.zMin = Math.min(g.zMin, p3[2]); g.zMax = Math.max(g.zMax, p3[2]); }
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  g.maxEdge = Math.max(g.maxEdge, d(v[0], v[1]), d(v[1], v[2]), d(v[2], v[0]));
  groups.set(key, g);
}

console.log(`\n${groups.size} groups, ${[...groups.values()].reduce((s, g) => s + g.count, 0)} triangles\n`);
for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].area - a[1].area)) {
  console.log(`${k.padEnd(22)} tris=${String(g.count).padStart(5)} area=${(g.area / 100).toFixed(1).padStart(9)} cm2  z=[${g.zMin.toFixed(1)}, ${g.zMax.toFixed(1)}]  mean nz=${(g.sumNz / g.area).toFixed(3).padStart(7)}  maxEdge=${g.maxEdge.toFixed(1)}mm`);
}
