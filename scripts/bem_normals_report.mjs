// =======================================================
// scripts/bem_normals_report.mjs
//
// Pour un .TBBS : compare les normales TELLES QUE DESSINÉES dans le maillage à
// l'orientation que le solveur retient, surface par surface et domaine par
// domaine. C'est l'outil pour vérifier qu'un modèle respecte la convention
// Akabak (normale rentrant dans le domaine, interface pointant vers le From).
//
// Usage : node scripts/bem_normals_report.mjs <study.TBBS> [auto|akabak]
// =======================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildConfigFromStudy } from './lib/tbbs_config.mjs';
import { resolveDataFile } from './lib/env_paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const studyPath = resolveDataFile('AKABAK CURVES/ESW1018.TBBS', { explicit: process.argv[2] });
const convention = process.argv[3] || null;
const study = JSON.parse(readFileSync(studyPath, 'utf8'));
const { config } = buildConfigFromStudy(study, study.mesh);
if (convention) config.normalConvention = convention;

const ctx = vm.createContext({ console, performance });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}
const api = vm.runInContext('({ buildMultiDomainModel })', ctx);

const model = api.buildMultiDomainModel(study.mesh, config);
console.log(`convention = ${config.normalConvention || 'auto'}`);
console.log(`${model.elementCount} éléments, ${model.nUnknowns} inconnues, sym=${model.symmetry}\n`);

const label = (el) => el.diaphragmId ? `d:${el.diaphragmId}`
  : (el.physicalTag != null ? `p:${el.physicalTag}` : `e:${el.elementaryTag}`);

for (const d of model.domains.values()) {
  // Volume signé avec les normales BRUTES du maillage : négatif ⇔ les normales
  // rentrent dans le domaine (convention Akabak), positif ⇔ elles en sortent.
  let rawVol = 0;
  for (const j of d.elemIdx) {
    const el = model.elements[j];
    rawVol += (el.centroid[0] * el.normal[0] + el.centroid[1] * el.normal[1] + el.centroid[2] * el.normal[2]) * el.area;
  }
  rawVol /= 3;
  console.log(`${d.name} [${d.type}${d.baffle ? `, baffle ${d.baffleAxisIdx}@${(d.baffleZ * 1000).toFixed(0)}mm` : ''}] ` +
    `closed=${d.closed} residual=${(d.closureResidual * 100).toFixed(2)}% components=${d.components.length} ` +
    `V_signé=${(d.signedVolume * 1000).toFixed(2)}L V_brut=${(rawVol * 1000).toFixed(2)}L`);
  const groups = new Map();
  for (const j of d.elemIdx) {
    const key = `${label(model.elements[j])}/${d.role.get(j)}`;
    const g = groups.get(key) || { plus: 0, minus: 0, area: 0 };
    (d.sign.get(j) > 0 ? g.plus++ : g.minus++);
    g.area += model.elements[j].area;
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    console.log(`    ${key.padEnd(28)} ${String(g.plus + g.minus).padStart(4)} tris ` +
      `${(g.area * 1e4).toFixed(1).padStart(8)} cm²  sign +1:${g.plus} -1:${g.minus}`);
  }
}
