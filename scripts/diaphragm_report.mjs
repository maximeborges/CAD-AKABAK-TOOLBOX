// Inspecte le maillage de diaphragme généré pour une étude .TBBS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataFile, repoRoot } from './lib/env_paths.mjs';

// Résolu depuis la racine du dépôt et non depuis le cwd : le harnais reste
// exécutable depuis n'importe quel dossier.
const { buildDiaphragmMesh } = new Function(
  `${readFileSync(join(repoRoot, 'src/js/panels/bemsolver/diaphragmMesh.js'), 'utf8').replace(/^export function/gm, 'function')}
   return { buildDiaphragmMesh };`
)();

const study = JSON.parse(readFileSync(resolveDataFile('AKABAK CURVES/horn.TBBS', { explicit: process.argv[2] }), 'utf8'));
const hv = [];
for (const l of study.mesh.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1)) {
  const f = l.trim().split(/\s+/).map(Number);
  hv.push(f[1], f[2], f[3]);
}
const cmp = study.tree.flatMap(t => t.components || []).find(c => c.type === 'diaphragm');
console.log('params', JSON.stringify(cmp, null, 1));

const mesh = buildDiaphragmMesh(cmp, { hostVertices: hv, hostEdge_mm: 12, symmetry: study.symmetry });
console.log('stats', JSON.stringify(mesh.stats));

const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
let area = 0, vol = 0;
for (const p of mesh.nodes) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
for (const t of mesh.tris) {
  const a = mesh.nodes[t[0]], b = mesh.nodes[t[1]], c = mesh.nodes[t[2]];
  const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
  area += Math.hypot(n[0], n[1], n[2]) / 2;
  // Volume signé entre la surface et le plan z = offsetZ.
  const zc = (a[2] + b[2] + c[2]) / 3 - (Number(cmp.offsetZ) || 0);
  vol += zc * n[2] / 2;
}
console.log(`bbox ${lo.map(v => v.toFixed(1)).join(' ')} -> ${hi.map(v => v.toFixed(1)).join(' ')}`);
console.log(`aire quart = ${(area / 100).toFixed(1)} cm²  → complète ${(area / 25).toFixed(1)} cm²`);
console.log(`creux sous le plan z=${cmp.offsetZ} : quart ${(Math.abs(vol) / 1000).toFixed(1)} cm³ → complet ${(Math.abs(vol) / 250).toFixed(1)} cm³`);
