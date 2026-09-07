// =======================================================
// FICHIER :  src/ipc/foamVentRun.js
// RÔLE    :  Orchestration d'un calcul CFD d'event: construction du cas,
//            exécution OpenFOAM, échantillonnage aux points du Field.
//
// Node pur (pas d'import Electron) pour rester validable en banc d'essai.
// =======================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const foam = require('./foamRunner');
const foamCase = require('./foamCase');
const foamResults = require('./foamResults');

/** Empreinte des seuls paramètres qui changent la géométrie du maillage. */
function meshFingerprint(spec, info) {
    const h = crypto.createHash('sha1');
    h.update(spec.mshContent || '');
    h.update(JSON.stringify(spec.groups || {}));
    h.update(String(spec.mirrorAxis));
    h.update(String(info.baseCell_mm));
    h.update(String(info.quality));
    h.update(String(spec.wallLevel || 0));
    return h.digest('hex').slice(0, 16);
}

function writeCaseFiles(caseDir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(caseDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf8');
    }
}

/** Lit le fichier de sondes le plus récent et le ramène au format du Field. */
function readProbeResults(caseDir, frequency_Hz) {
    const ppDir = path.join(caseDir, 'postProcessing', 'fieldProbes');
    if (!fs.existsSync(ppDir)) return { ok: false, reason: 'aucune sonde écrite' };
    const stamps = fs.readdirSync(ppDir)
        .filter(s => fs.existsSync(path.join(ppDir, s, 'U')))
        .sort((a, b) => Number(a) - Number(b));
    if (!stamps.length) return { ok: false, reason: 'aucune sonde écrite' };

    const probes = foamResults.parseProbes(
        fs.readFileSync(path.join(ppDir, stamps[stamps.length - 1], 'U'), 'utf8'));
    if (probes.times.length < 8) {
        return { ok: false, reason: `série trop courte (${probes.times.length} échantillons)` };
    }
    const decomposed = foamResults.harmonicDecompose(probes, frequency_Hz, 1);
    const field = foamResults.toFieldVelocity(decomposed);
    return {
        ok: true,
        vRe: field.vRe,
        vIm: field.vIm,
        vMean: field.vMean,
        turbulence: field.turbulence,
        peak: field.peak,
        valid: field.valid,
        positions: probes.positions,
        samples: probes.times.length,
        lastTime_s: probes.times[probes.times.length - 1],
    };
}

/**
 * Résout Navier-Stokes dans l'event et rend le champ de vitesse aux sondes.
 *
 * @param {object} spec - voir foamCase.buildCase, plus `cores`, `endTimeOverride`
 * @param {{workDir: string, env?: object, onProgress?: Function, signal?: AbortSignal}} options
 */
async function runVentCase(spec, options) {
    const { workDir, onProgress, signal } = options;
    const send = (phase, detail) => { if (onProgress) onProgress({ phase, detail }); };

    const env = options.env?.available ? options.env : await foam.checkAvailability();
    if (!env.available) {
        return { ok: false, reason: env.reason || 'OpenFOAM introuvable dans WSL' };
    }

    send('build', 'préparation du cas');
    const built = foamCase.buildCase(spec);
    const info = built.info;
    // pimpleFoam est incompressible: au-delà de Mach 0,3 le modèle est faux.
    const mach = info.inletVelocity_ms / 344;
    if (mach > 0.3) {
        return {
            ok: false,
            reason: `vitesse d'entrée de ${info.inletVelocity_ms.toFixed(0)} m/s (Mach ${mach.toFixed(2)}) : `
                + `hors du domaine de validité d'un solveur incompressible — vérifiez la tension de commande`,
        };
    }
    const caseDir = path.join(workDir, `vent-${meshFingerprint(spec, info)}`);

    // Le maillage domine le temps de calcul: on le garde tant que la géométrie
    // ne bouge pas, seul le solveur est relancé.
    const meshed = fs.existsSync(path.join(caseDir, 'constant', 'polyMesh', 'owner'));
    writeCaseFiles(caseDir, built.files);
    fs.rmSync(path.join(caseDir, 'postProcessing'), { recursive: true, force: true });

    const stage = meshed ? 'solve' : 'all';
    const t0 = Date.now();
    let solveStart = 0;
    let endTime = info.endTime_s || 0;
    const res = await foam.runFoamScriptStream(env.distro, 'run_case.sh',
        [foam.toScriptPath(caseDir), stage, String(spec.cores || 8), spec.endTimeOverride || ''],
        {
            timeout: options.timeout || 6 * 60 * 60 * 1000,
            signal,
            onLine: line => {
                if (line.startsWith('FOAM_STAGE=')) {
                    const name = line.slice(11);
                    if (name === 'pimpleFoam') solveStart = Date.now();
                    send('stage', name);
                } else if (line.startsWith('FOAM_RESULT=endTimeUsed=')) {
                    endTime = parseFloat(line.slice(24)) || endTime;
                } else if (line.startsWith('FOAM_PROGRESS=')) {
                    // Le solveur avance à vitesse constante : le temps simulé
                    // écoulé suffit à extrapoler ce qu'il reste.
                    const t = parseFloat(line.slice(14));
                    if (t > 0 && endTime > 0) {
                        const frac = Math.min(1, t / endTime);
                        const spent = (Date.now() - solveStart) / 1000;
                        const eta = frac > 0.01 ? spent * (1 - frac) / frac : null;
                        send('solving', `${Math.round(frac * 100)} %`
                            + (eta ? ` · ${eta < 90 ? `${Math.round(eta)} s` : `${Math.round(eta / 60)} min`} left` : ''));
                    }
                } else if (line.startsWith('FOAM_WARN=')) send('warn', line.slice(10));
                else if (line.startsWith('FOAM_ERROR=')) send('error', line.slice(11));
            },
        });

    const results = foam.parseKeyValues(
        res.stdout.split(/\r?\n/).filter(l => l.startsWith('FOAM_RESULT='))
            .map(l => l.slice(12)).join('\n'));
    if (results.status !== 'ok') {
        return {
            ok: false,
            reason: results.error || 'le calcul OpenFOAM a échoué',
            log: res.stdout.split(/\r?\n/).slice(-40).join('\n'),
            caseDir,
        };
    }

    send('sample', 'lecture des sondes');
    const sampled = readProbeResults(caseDir, info.frequency_Hz);
    if (!sampled.ok) return { ...sampled, caseDir };

    // L'étape 'solve' ne remaille pas et ne compte donc pas les cellules :
    // on garde le compte du premier passage à côté du maillage, et à défaut on
    // le relit dans l'en-tête de polyMesh/owner, que OpenFOAM y inscrit.
    const cellsFile = path.join(caseDir, 'cells.txt');
    let cells = results.cells ? parseInt(results.cells, 10) : null;
    if (cells) fs.writeFileSync(cellsFile, String(cells), 'utf8');
    else if (fs.existsSync(cellsFile)) cells = parseInt(fs.readFileSync(cellsFile, 'utf8').trim(), 10) || null;
    else cells = readMeshCellCount(caseDir);

    return {
        ...sampled,
        info,
        caseDir,
        reusedMesh: meshed,
        cells,
        elapsed_s: (Date.now() - t0) / 1000,
    };
}

/** Nombre de cellules lu dans la ligne `note` de l'en-tête de polyMesh/owner. */
function readMeshCellCount(caseDir) {
    const owner = path.join(caseDir, 'constant', 'polyMesh', 'owner');
    if (!fs.existsSync(owner)) return null;
    const fd = fs.openSync(owner, 'r');
    try {
        const buf = Buffer.alloc(2048);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const match = buf.slice(0, read).toString('latin1').match(/nCells\s*:\s*(\d+)/);
        return match ? parseInt(match[1], 10) : null;
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { meshFingerprint, writeCaseFiles, readProbeResults, runVentCase };
