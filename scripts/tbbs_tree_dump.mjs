// Diagnostic ponctuel : affiche l'arbre du modèle d'un projet .TBBS sans le maillage.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/tbbs_tree_dump.mjs <projet.TBBS>');
    process.exit(2);
}
const project = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log('meshFileName :', project.meshFileName);
console.log('symmetry     :', project.symmetry, '| normals:', project.normalConvention);
console.log('driveVrms    :', project.driveVrms);
console.log('frequency    :', JSON.stringify(project.frequency));
console.log('mesh length  :', (project.mesh || '').length, 'chars');
console.log('');

for (const node of project.tree || []) {
    console.log(`[${node.kind}] ${node.name}  (id=${node.id})`);
    if (node.kind === 'Subdomain') {
        console.log(`    domainType = ${node.domainType}`);
    }
    for (const key of ['fieldType', 'quantity', 'axis', 'offsetX_mm', 'offsetY_mm', 'offsetZ_mm',
        'width_mm', 'height_mm', 'delta_mm', 'portDiameter_mm', 'flowOverlay', 'vMax_ms']) {
        if (node[key] !== undefined) console.log(`    ${key} = ${node[key]}`);
    }
    for (const s of node.surfaces || []) {
        console.log(`    surface ${s.meshSurfaceId}  role=${s.role}  velocity=${s.velocity}`
            + `  axis=${JSON.stringify(s.pistonAxis)}  name=${s.meshSurfaceName || s.name || ''}`);
    }
    for (const c of node.components || []) {
        console.log(`    component ${c.type}  name=${c.name}  driver=${c.driverName}`);
        if (c.driverParams) console.log(`        params = ${JSON.stringify(c.driverParams)}`);
        for (const key of ['axis', 'diameter_mm', 'offsetX_mm', 'offsetY_mm', 'offsetZ_mm', 'surfaceId']) {
            if (c[key] !== undefined) console.log(`        ${key} = ${c[key]}`);
        }
    }
}
