// =======================================================
// FICHIER :  scripts/foam_env_validate.mjs
// RÔLE    :  Valide le pont Node <-> WSL/OpenFOAM (src/ipc/foamRunner.js)
// USAGE   :  node scripts/foam_env_validate.mjs
// =======================================================
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const foam = require(path.join(here, '..', 'src', 'ipc', 'foamRunner.js'));

let failures = 0;
let skipped = 0;

function check(label, condition, detail = '') {
    const status = condition ? 'PASS' : 'FAIL';
    if (!condition) failures++;
    console.log(`  ${status}  ${label}${detail ? `  —  ${detail}` : ''}`);
}

function skip(label, detail = '') {
    skipped++;
    console.log(`  SKIP  ${label}${detail ? `  —  ${detail}` : ''}`);
}

console.log('=== Conversion de chemin Windows -> WSL ===');
// `toWslPath` est une fonction purement textuelle : ce littéral Windows
// synthétique se vérifie donc à l'identique sous Windows, Linux et macOS.
const SAMPLE_WIN_PATH = 'C:\\Users\\dev\\Projects\\ToolBox\\scripts';
check(
    'lettre de lecteur et séparateurs convertis',
    foam.toWslPath(SAMPLE_WIN_PATH) === '/mnt/c/Users/dev/Projects/ToolBox/scripts',
    foam.toWslPath(SAMPLE_WIN_PATH)
);
check(
    'un chemin relatif est refusé ou résolu en absolu',
    // Selon la plateforme, `path.resolve` produit soit un chemin avec lettre de
    // lecteur (Windows, converti), soit un chemin POSIX que `toWslPath` refuse
    // en levant. Les deux comportements satisfont l'invariant testé.
    (() => {
        try {
            return foam.toWslPath('scripts').startsWith('/mnt/');
        } catch {
            return true;
        }
    })(),
    process.platform === 'win32' ? 'converti' : 'refusé (hors Windows)'
);

console.log('\n=== Décodage de la sortie wsl.exe ===');
check(
    'UTF-8 conservé tel quel',
    foam.decodeWslOutput(Buffer.from('FOAM_VERSION=v2512\n', 'utf8')) === 'FOAM_VERSION=v2512\n'
);
check(
    'UTF-16LE décodé sans octets nuls résiduels',
    foam.decodeWslOutput(Buffer.from('Ubuntu-24.04\n', 'utf16le')) === 'Ubuntu-24.04\n'
);
check('buffer vide toléré', foam.decodeWslOutput(Buffer.alloc(0)) === '');

console.log('\n=== Parsing des lignes KEY=VALUE ===');
const parsed = foam.parseKeyValues('FOAM_FOUND=1\n  FOAM_VERSION=v2512  \nbruit ignoré\nTOOL_pimpleFoam=OK\n');
check('clés attendues extraites', parsed.FOAM_FOUND === '1' && parsed.TOOL_pimpleFoam === 'OK');
check('les lignes non conformes sont ignorées', Object.keys(parsed).length === 3, Object.keys(parsed).join(','));

// Tout ce qui suit interroge réellement WSL. Ces contrôles ne peuvent aboutir
// que sous Windows : ailleurs on les déclare ignorés plutôt qu'en échec, afin
// que le code de sortie ne signale que de vrais problèmes.
console.log('\n=== Distributions WSL ===');
const distros = await foam.listDistros();
const wslPresent = distros.length > 0;

if (!wslPresent) {
    skip('WSL indisponible sur cette plateforme', `plateforme=${process.platform}`);
    console.log('\n=== Disponibilité OpenFOAM ===');
    skip('contrôles OpenFOAM ignorés (nécessitent WSL)');
} else {
    check('au moins une distribution est installée', true, distros.join(', '));

    console.log('\n=== Disponibilité OpenFOAM ===');
    const env = await foam.checkAvailability();
    check('OpenFOAM est utilisable', env.available === true, env.reason || `${env.distro} ${env.version}`);
    check('version détectée', typeof env.version === 'string' && env.version.length > 0, String(env.version));
    check('chemin du bashrc détecté', typeof env.bashrc === 'string' && env.bashrc.includes('etc/bashrc'), String(env.bashrc));
    check('nombre de cœurs plausible', Number.isInteger(env.cores) && env.cores >= 1, String(env.cores));
    check('aucun utilitaire requis manquant', Array.isArray(env.missing) && env.missing.length === 0, (env.missing || []).join(', ') || 'aucun');
}

const summary = [
    failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`,
    skipped > 0 ? `${skipped} skipped.` : '',
].filter(Boolean).join(' ');
console.log(`\n${summary}`);
process.exit(failures === 0 ? 0 : 1);
