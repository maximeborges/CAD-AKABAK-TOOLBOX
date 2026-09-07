// =======================================================
// scripts/akabak_compare.mjs
//
// Rejoue une étude .TBBS dans le pipeline worker (hors Electron) et compare la
// courbe SPL obtenue à l'export Akabak de référence (AKABAK CURVES/SPL.txt).
//
// Usage : node scripts/akabak_compare.mjs [study.TBBS] [ref.txt]
// =======================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { resolveDataFile } from './lib/env_paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const studyPath = resolveDataFile('AKABAK CURVES/horn.TBBS', { explicit: process.argv[2] });
const refPath = resolveDataFile('AKABAK CURVES/SPL.txt', { explicit: process.argv[3] });

const study = JSON.parse(readFileSync(studyPath, 'utf8'));

/**
 * Raffine un .msh en coupant chaque triangle en 4 (milieux d'arêtes), tags
 * physiques et élémentaires conservés. Sert au test de convergence : si la
 * réponse bouge, c'est la discrétisation qui parle, pas le modèle.
 */
function refineMsh(text, passes) {
  let src = text;
  for (let p = 0; p < passes; p++) {
    const nodesBlock = src.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1);
    const coords = new Map();
    let maxId = 0;
    for (const line of nodesBlock) {
      const f = line.trim().split(/\s+/).map(Number);
      coords.set(f[0], [f[1], f[2], f[3]]);
      if (f[0] > maxId) maxId = f[0];
    }
    const midCache = new Map();
    const midOf = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let id = midCache.get(key);
      if (id) return id;
      const va = coords.get(a), vb = coords.get(b);
      id = ++maxId;
      coords.set(id, [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
      midCache.set(key, id);
      return id;
    };
    const outElems = [];
    for (const line of src.split('$Elements')[1].split('$EndElements')[0].trim().split('\n').slice(1)) {
      const f = line.trim().split(/\s+/).map(Number);
      const nTags = f[2];
      const tags = f.slice(3, 3 + nTags).join(' ');
      if (f[1] !== 2) { outElems.push({ type: f[1], tags, nodes: f.slice(3 + nTags) }); continue; }
      const [a, b, c] = f.slice(3 + nTags);
      const ab = midOf(a, b), bc = midOf(b, c), ca = midOf(c, a);
      for (const t of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) {
        outElems.push({ type: 2, tags, nodes: t });
      }
    }
    const head = src.split('$Nodes')[0];
    const lines = [head.trimEnd(), '$Nodes', String(coords.size)];
    for (const [id, v] of [...coords.entries()].sort((x, y) => x[0] - y[0])) lines.push(`${id} ${v[0]} ${v[1]} ${v[2]}`);
    lines.push('$EndNodes', '$Elements', String(outElems.length));
    outElems.forEach((e, i) => lines.push(`${i + 1} ${e.type} ${e.tags.split(/\s+/).length} ${e.tags} ${e.nodes.join(' ')}`));
    lines.push('$EndElements');
    src = lines.join('\n');
  }
  return src;
}

const REFINE = Number(process.env.REFINE || 0);
const mshContent = REFINE ? refineMsh(study.mesh, REFINE) : study.mesh;

// ---- Mailleur de diaphragme (module ESM du panneau, évalué à la main) ----
const { buildDiaphragmMesh } = new Function(
  `${readFileSync(join(root, 'src/js/panels/bemsolver/diaphragmMesh.js'), 'utf8').replace(/^export function/gm, 'function')}
   return { buildDiaphragmMesh };`
)();

/** Sommets du maillage hôte, à plat, comme les rend le viewer 3D. */
function hostVerticesFromMsh(text) {
  const block = text.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1);
  const out = [];
  for (const line of block) {
    const p = line.trim().split(/\s+/).map(Number);
    out.push(p[1], p[2], p[3]);
  }
  return out;
}

function medianEdgeFromMsh(text) {
  const nodes = new Map();
  for (const line of text.split('$Nodes')[1].split('$EndNodes')[0].trim().split('\n').slice(1)) {
    const p = line.trim().split(/\s+/).map(Number);
    nodes.set(p[0], [p[1], p[2], p[3]]);
  }
  const lens = [];
  for (const line of text.split('$Elements')[1].split('$EndElements')[0].trim().split('\n').slice(1)) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f[1] !== 2) continue;
    const off = 3 + f[2];
    const v = [nodes.get(f[off]), nodes.get(f[off + 1]), nodes.get(f[off + 2])];
    if (!v[0] || !v[1] || !v[2]) continue;
    for (let i = 0; i < 3; i++) {
      const a = v[i], b = v[(i + 1) % 3];
      lens.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  lens.sort((a, b) => a - b);
  return lens.length ? lens[lens.length >> 1] : 0;
}

// ---- Config solveur, reproduction de buildBemSolverConfig() ----
const tree = study.tree;
const symmetry = study.symmetry || 'none';
const hostVertices = hostVerticesFromMsh(mshContent);
const hostEdge_mm = medianEdgeFromMsh(mshContent);

const diaphragms = [];
let driverParams = null, driverName = '';
const subdomains = tree.filter(it => it.kind === 'Subdomain').map(it => {
  const components = it.components || [];
  const baffle = components.find(c => c.type === 'baffle') || null;
  const surfaces = it.surfaces.filter(s => s.meshSurfaceId).map(s => ({
    surfaceId: s.meshSurfaceId,
    role: s.role === 'driven' ? 'driven' : 'boundary',
    velocity: s.velocity != null ? s.velocity : 1,
  }));
  for (const component of components) {
    if (component.type !== 'diaphragm') continue;
    const mesh = buildDiaphragmMesh(component, { hostVertices, hostEdge_mm, symmetry });
    if (!mesh?.tris?.length) throw new Error(`diaphragm mesh empty: ${mesh?.stats?.error}`);
    diaphragms.push({ id: component.id, nodes: mesh.nodes, tris: mesh.coneTris || mesh.tris });
    const raw = String(component.axis || '+z').toLowerCase();
    const sgn = raw.startsWith('-') ? -1 : 1;
    const axis = { x: [sgn, 0, 0], y: [0, sgn, 0], z: [0, 0, sgn] }[raw.slice(-1)] || [0, 0, 1];
    surfaces.push({
      surfaceId: `d:${component.id}`,
      role: 'driven',
      velocity: 1,
      pistonAxis: process.env.UNIFORM ? null : axis,
    });
    if (mesh.capTris?.length) {
      diaphragms.push({ id: `${component.id}:cap`, nodes: mesh.nodes, tris: mesh.capTris });
      surfaces.push({ surfaceId: `d:${component.id}:cap`, role: 'boundary' });
    }
    if (!driverParams && component.driverParams) { driverParams = component.driverParams; driverName = component.driverName; }
  }
  return {
    id: it.id, name: it.name,
    type: it.domainType === 'interior' ? 'interior' : 'exterior',
    baffle: process.env.NOBAFFLE ? false : !!baffle,
    baffleAxis: baffle ? (baffle.axis || '+z') : null,
    baffleOffset_mm: baffle ? (Number(baffle.offset_mm) || 0) : 0,
    surfaces,
  };
});
const interfaces = tree.filter(it => it.kind === 'Interface').map(it => ({
  id: it.id, name: it.name, fromId: it.fromId, toId: it.toId,
  surfaces: it.surfaces.filter(s => s.meshSurfaceId).map(s => ({ surfaceId: s.meshSurfaceId })),
}));

const config = { symmetry, subdomains, interfaces, diaphragms };

// MERGE="node-3,node-4" fusionne deux sous-domaines et supprime l'interface qui
// les reliait. La physique ne doit pas bouger : c'est le test du découpage
// multi-domaine lui-même.
if (process.env.MERGE) {
  const [keepId, dropId] = process.env.MERGE.split(',');
  const keep = config.subdomains.find(s => s.id === keepId);
  const drop = config.subdomains.find(s => s.id === dropId);
  keep.surfaces.push(...drop.surfaces);
  config.subdomains = config.subdomains.filter(s => s !== drop);
  config.interfaces = config.interfaces.filter(itf =>
    !((itf.fromId === keepId && itf.toId === dropId) || (itf.fromId === dropId && itf.toId === keepId)));
  for (const itf of config.interfaces) {
    if (itf.fromId === dropId) itf.fromId = keepId;
    if (itf.toId === dropId) itf.toId = keepId;
  }
  console.log(`MERGE : ${dropId} absorbé par ${keepId} — ${config.subdomains.length} sous-domaines, ${config.interfaces.length} interfaces\n`);
}

{
  const perTag = new Map();
  for (const line of mshContent.split('$Elements')[1].split('$EndElements')[0].trim().split('\n').slice(1)) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f[1] !== 2) continue;
    perTag.set(f[3], (perTag.get(f[3]) || 0) + 1);
  }
  const names = new Map();
  for (const line of mshContent.split('$PhysicalNames')[1].split('$EndPhysicalNames')[0].trim().split('\n').slice(1)) {
    const m = line.trim().match(/^\d+\s+(\d+)\s+"(.+)"$/);
    if (m) names.set(Number(m[1]), m[2]);
  }
  const total = [...perTag.values()].reduce((s, v) => s + v, 0);
  console.log(`.msh : ${total} triangles — ${[...perTag.entries()].map(([t, c]) => `${names.get(t) || t}=${c}`).join(' ')}`);
  console.log(`diaphragme généré : ${diaphragms.reduce((s, d) => s + d.tris.length, 0)} triangles\n`);
}

// ---- Fréquences (mêmes qu'Akabak : log pur, ppo points par octave) ----
const fMin = Number(study.frequency?.fMin || 100);
const fMax = Number(study.frequency?.fMax || 1000);
const ppo = Number(study.frequency?.ppo || 20);
const freqs = [];
if (process.env.FREQS) {
  freqs.push(...process.env.FREQS.split(',').map(Number));
} else {
  const logMin = Math.log2(fMin), logMax = Math.log2(fMax);
  const n = Number(process.env.NF) || Math.max(1, Math.round((logMax - logMin) * ppo));
  for (let i = 0; i <= n; i++) freqs.push(Math.pow(2, logMin + (i / n) * (logMax - logMin)));
}
const distance_m = Number(study.observation?.distance || 1);
const angleStep = Number(study.observation?.angleStep || 5);
const angleMax = Number(study.observation?.angleRange || 180) / 2;

// ---- Contexte worker ----
let doneResult = null, errorMessage = null;
const selfStub = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'done') doneResult = msg.result;
    if (msg.type === 'error') errorMessage = msg.message;
    if (msg.type === 'progress' && msg.ev.phase === 'meshReady') {
      const mi = msg.ev.meshInfo;
      console.log(`mesh: ${mi.elementCount} éléments, ${mi.unknowns} inconnues, sym=${mi.symmetry}`);
      console.log(`domaines: ${mi.domains.map(d => `${d.name}[${d.type}${d.baffle ? ',baffle' : ''}]=${d.elements} closed=${d.closed}`).join(' ')}`);
      if (mi.volumes) console.log(`volumes: ${mi.volumes.map(v => `${v.name}=${(v.litres).toFixed(3)}L`).join(' ')} total=${mi.volumes.reduce((s, v) => s + v.litres, 0).toFixed(3)}L`);
    }
    if (msg.type === 'progress' && msg.ev.phase === 'freqDone' && process.env.TRACE) {
      console.log(`  ${msg.ev.freq.toFixed(1)} Hz : ${msg.ev.elapsed_ms.toFixed(0)} ms`);
    }
  },
};
const ctx = vm.createContext({ console, performance, self: selfStub });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js', 'src/js/bem/bemGalerkin.js', 'src/js/bem/bemDomainWorker.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}

const t0 = Date.now();
selfStub.onmessage({ data: { type: 'computeDomain', id: 'cmp', mshContent, config, opts: { freqs, distance_m, angleStep, angleMax } } });
const elapsed = (Date.now() - t0) / 1000;
if (errorMessage) { console.error('worker error:', errorMessage); process.exit(1); }
console.log(`solve: ${elapsed.toFixed(2)} s pour ${doneResult.freqs.length} fréquences (${(elapsed / doneResult.freqs.length * 1000).toFixed(0)} ms/f)\n`);

// ---- Couplage driver ----
const P_REF = 2e-5;
function tsCoupledVelocity(params, f, vRMS, Za) {
  const Bl = params.BL, Re = params.Re, Mms = params.Mms_kg ?? params.Mms;
  const w = 2 * Math.PI * f, w0 = 2 * Math.PI * params.fs;
  const Cms = params.Cms_mPerN || 1 / (w0 * w0 * Mms);
  const Qms = params.Qms > 0 ? params.Qms : 5;
  const Rms = params.Rms_Nsm || (w0 * Mms) / Qms;
  const Le = params.Le_H || 0;
  const zmRe = Rms + (Za ? Za.re : 0);
  const zmIm = -w * Mms + 1 / (w * Cms) + (Za ? Za.im : 0);
  const zeRe = Re, zeIm = -w * Le;
  const dRe = zmRe * zeRe - zmIm * zeIm + Bl * Bl;
  const dIm = zmRe * zeIm + zmIm * zeRe;
  const den = dRe * dRe + dIm * dIm;
  // v = Bl*U / (Ze*Zm + Bl²)
  return { re: Bl * vRMS * dRe / den, im: -Bl * vRMS * dIm / den };
}

const vRMS = Number(study.driveVrms || 2.83);
const onAxis = doneResult.onAxis;
const load = doneResult.drivenLoad || [];
const Sd = driverParams.Sd_m2;

// ---- Référence Akabak ----
const ref = readFileSync(refPath, 'utf8').trim().split('\n')
  .map(l => l.trim().split(/\s+/).map(Number))
  .filter(a => a.length >= 2 && Number.isFinite(a[0]))
  .map(a => ({ f: a[0], db: a[1], phase: a[2] }));

function refAt(f) {
  if (f <= ref[0].f) return ref[0].db;
  if (f >= ref[ref.length - 1].f) return ref[ref.length - 1].db;
  for (let i = 0; i < ref.length - 1; i++) {
    if (ref[i].f <= f && f <= ref[i + 1].f) {
      const t = (Math.log(f) - Math.log(ref[i].f)) / (Math.log(ref[i + 1].f) - Math.log(ref[i].f));
      return ref[i].db * (1 - t) + ref[i + 1].db * t;
    }
  }
  return ref[0].db;
}

const rows = [];
const RATIO_MODE = process.env.RATIO || 'one';   // 'area' | 'one' | 'proj'
const projArea = Math.PI * Math.pow(0.181 / 2, 2);
console.log(`couplage : RATIO=${RATIO_MODE}  Sd=${(Sd * 1e4).toFixed(1)} cm²  U=${vRMS} V\n`);
console.log('   f(Hz)   Sgeom     Za.re      Za.im       v(m/s)      p1m     SPL     Akabak     Δ   mismatch');
for (let i = 0; i < onAxis.length; i++) {
  const f = onAxis[i].f;
  const ld = load[i] || null;
  const Sg = ld ? ld.area : 0;
  const r = RATIO_MODE === 'one' ? 1 : (RATIO_MODE === 'proj' ? Sd / projArea : (Sg > 0 ? Sd / Sg : 1));
  // Za rapporté à la membrane (transformateur de rapport r sur la vitesse).
  const Za = ld ? { re: r * r * ld.re, im: r * r * ld.im } : null;
  const v = tsCoupledVelocity(driverParams, f, vRMS, Za);
  const u = { re: r * v.re, im: r * v.im };          // vitesse imposée à la surface BEM
  const pMag = onAxis[i].p_ref * Math.hypot(u.re, u.im);
  const spl = 20 * Math.log10(Math.max(pMag, 1e-12) / P_REF);
  const aka = refAt(f);
  rows.push({ f, spl, aka });
  const p1m = onAxis[i].p_ref;
  console.log(`${f.toFixed(1).padStart(8)} ${(Sg * 1e4).toFixed(1).padStart(7)} ${(Za ? Za.re : 0).toFixed(2).padStart(10)} ${(Za ? Za.im : 0).toFixed(2).padStart(10)} ${Math.hypot(v.re, v.im).toExponential(2).padStart(10)} ${p1m.toFixed(3).padStart(9)} ${spl.toFixed(2).padStart(7)} ${aka.toFixed(2).padStart(8)} ${(spl - aka).toFixed(2).padStart(7)} ${((doneResult.power[i]?.mismatch ?? 0) * 100).toFixed(1).padStart(7)}%`);
}

const diffs = rows.map(r => r.spl - r.aka);const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
const rms = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
const rmsShape = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length);
console.log(`\noffset moyen = ${mean.toFixed(2)} dB · RMS = ${rms.toFixed(2)} dB · RMS de FORME (offset retiré) = ${rmsShape.toFixed(2)} dB · max|Δ| = ${Math.max(...diffs.map(Math.abs)).toFixed(2)} dB`);

writeFileSync(join(here, 'out', 'akabak_compare.txt'),
  rows.map(r => `${r.f.toFixed(4)}\t${r.spl.toFixed(4)}\t${r.aka.toFixed(4)}`).join('\n'));

// Même mise en forme que l'export .txt du panneau, pour charger la courbe de
// référence du harnais directement dans Akabak et la superposer.
const pad = (v) => String(v).padStart(16);
writeFileSync(join(here, 'out', 'harness_spl.txt'),
  onAxis.map((pt, i) => `${pad(pt.f.toPrecision(7))}${pad(rows[i].spl.toPrecision(7))}${pad((pt.phaseDeg ?? 0).toPrecision(7))}`).join('\r\n') + '\r\n');

// Compliance équivalente vue par la source : à très basse fréquence la cavité
// est compacte, donc Im(F) = -ρc²·S²/(ω·V). Le volume déduit doit tendre vers
// le volume géométrique du modèle — contrôle le plus direct que le solveur voit
// bien le bon volume d'air.
if (process.env.FREQS) {
  const RHO = 1.21, C = 344;
  console.log('\n   f(Hz)       Im(F)     S(cm²)   V_eff(L)');
  for (let i = 0; i < onAxis.length; i++) {
    const ld = load[i];
    if (!ld) continue;
    const w = 2 * Math.PI * onAxis[i].f;
    const V = RHO * C * C * ld.area * ld.area / (w * Math.abs(ld.im));
    console.log(`${onAxis[i].f.toFixed(2).padStart(8)} ${ld.im.toFixed(3).padStart(11)} ${(ld.area * 1e4).toFixed(1).padStart(10)} ${(V * 1000).toFixed(3).padStart(10)}`);
  }
}
