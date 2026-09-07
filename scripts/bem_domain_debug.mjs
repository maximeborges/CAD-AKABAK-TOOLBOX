// Diagnostic du modèle utilisateur sur un .msh réel, hors Electron.
// Usage: node scripts/bem_domain_debug.mjs <mesh.msh>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const context = vm.createContext({ console, performance });
for (const f of ['src/js/bem/bemShared.js', 'src/js/bem/bemDomainCore.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), context, { filename: f });
}
const api = vm.runInContext(`({
  buildMultiDomainModel, prepareMultiDomain, solveMultiDomain,
  computeMultiDomainPolar, multiDomainPowerBalance, pickRadiatingDomain, C_AIR,
})`, context);

if (!process.argv[2]) {
    console.error('Usage: node scripts/bem_domain_debug.mjs <mesh.msh>');
    process.exit(2);
}
const mesh = readFileSync(process.argv[2], 'utf8');

// Configuration reproduisant l'arbre Akabak de l'utilisateur.
const config = {
  symmetry: 'hv',
  subdomains: [
    { id: 'EXT', name: 'EXT', type: 'exterior', baffle: true, surfaces: [] },
    {
      id: 'INT', name: 'INT', type: 'interior', baffle: false,
      surfaces: [
        { surfaceId: 'e:1', role: 'boundary' },              // HORN
        { surfaceId: 'e:2', role: 'driven', velocity: 1 },   // DRIVER
      ],
    },
  ],
  interfaces: [{
    id: 'ITF', name: 'ITF', fromId: 'EXT', toId: 'INT',
    surfaces: [{ surfaceId: 'e:3' }, { surfaceId: 'e:4' }],  // COLLERETTE + FRONT
  }],
};

const model = api.buildMultiDomainModel(mesh, config);
console.log(`elements=${model.elementCount} unknowns=${model.nUnknowns} interfaceDofs=${model.nq} mirrors=${model.mirrorCount}`);
console.log(`maxEdge=${model.maxElementSize_mm.toFixed(1)} mm  => f_max(lambda/6)=${(api.C_AIR / (6 * model.maxElementSize_m)).toFixed(0)} Hz`);
for (const d of model.domains.values()) {
  console.log(`  domain ${d.name}: type=${d.type} baffle=${d.baffle} baffleZ=${d.baffleZ != null ? d.baffleZ.toFixed(4) : '-'} ` +
    `elements=${d.elemIdx.length} closed=${d.closed} residual=${(d.closureResidual * 100).toFixed(1)}% ` +
    `components=${d.components.length} flipped=${d.flipped} vol=${d.signedVolume.toExponential(2)}` +
    (d.baffleOffPlaneFraction != null ? ` offPlane=${(d.baffleOffPlaneFraction * 100).toFixed(1)}%` : ''));
}
if (model.unassigned.length) {
  console.log('  UNASSIGNED:', model.unassigned.map(u => `${u.surfaceId} ${(u.area * 1e4).toFixed(1)}cm2`).join(', '));
}

const prep = api.prepareMultiDomain(model, null);
for (const d of prep.diagnostics) {
  console.log(`  prep ${d.domain}: closed=${d.closed} rowSumErr=${d.worstRowSumError.toExponential(2)}`);
}

const dom = api.pickRadiatingDomain(model);
console.log(`radiating domain: ${dom.name}\n`);
console.log('freq      driven W      radiated W    mismatch   cond');
for (const f of [200, 500, 1000, 1500, 2000, 3000, 5000]) {
  const sol = api.solveMultiDomain(f, model, prep, {});
  const bal = api.multiDomainPowerBalance(model, sol);
  const perDomain = bal.perDomain.map(p => `${p.domain}=${p.wOut.toExponential(2)}`).join(' ');
  console.log(`${String(f).padStart(5)}  ${bal.driven.toExponential(3).padStart(12)}  ${bal.radiated.toExponential(3).padStart(12)}  ` +
    `${(bal.mismatch * 100).toFixed(1).padStart(7)}%  ${sol.condIndicator.toExponential(1)}   ${perDomain}`);
}
