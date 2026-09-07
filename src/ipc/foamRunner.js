// =======================================================
// FICHIER :  src/ipc/foamRunner.js
// RÔLE    :  Pont Node <-> WSL/OpenFOAM (logique pure, sans Electron)
//
// Ce module est volontairement dépourvu de toute dépendance Electron afin de
// pouvoir être validé par un harnais Node (scripts/foam_env_validate.mjs).
// Le wrapper IPC vit dans src/ipc/foamHandlers.js.
// =======================================================
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WSL_EXE = 'wsl.exe';

/**
 * WSL ne sert ici qu'à fournir un shell Linux : la charge utile réelle est
 * toujours `bash <script> <args>`, le préfixe `wsl.exe -d <distro> -u root --`
 * n'étant qu'un moyen d'y accéder depuis Windows. Sous Linux ce shell est déjà
 * là, donc on exécute les mêmes scripts directement.
 *
 * macOS reste sur le chemin WSL (donc indisponible) : il n'existe pas de build
 * natif OpenFOAM utilisable, l'usage courant passant par Docker.
 */
const IS_WINDOWS = process.platform === 'win32';
const IS_NATIVE_HOST = process.platform === 'linux';

// Distribution installée par le setup CFD. On la teste en premier, puis on
// balaye les autres distributions si elle a été renommée ou supprimée.
const PREFERRED_DISTRO = 'Ubuntu-24.04';

// `distro` identifiant l'hôte lui-même, quand les scripts tournent sans WSL.
const LOCAL_HOST = 'local';

/**
 * Dossier des scripts bash.
 *
 * Une fois l'application empaquetée, `src/` vit dans app.asar — une archive
 * que WSL ne sait pas parcourir : `/mnt/c/.../app.asar/scripts/foam/x.sh`
 * n'existe tout simplement pas pour bash. Les scripts sont donc copiés tels
 * quels dans `resources/foam` (voir `extraResources` du package.json).
 */
function resolveFoamScriptsDir() {
    const devDir = path.join(__dirname, '..', '..', 'scripts', 'foam');
    if (fs.existsSync(path.join(devDir, 'run_case.sh'))) return devDir;
    return path.join(process.resourcesPath || '', 'foam');
}

const FOAM_SCRIPTS_DIR = resolveFoamScriptsDir();

const DEFAULT_TIMEOUT_MS = 120000;

// Utilitaires OpenFOAM dont dépend le pipeline vent. `checkAvailability`
// signale explicitement ceux qui manquent plutôt que d'échouer plus tard.
const REQUIRED_TOOLS = [
    'blockMesh',
    'snappyHexMesh',
    'surfaceFeatureExtract',
    'pimpleFoam',
    'checkMesh',
    'postProcess',
    'decomposePar',
    'reconstructPar',
];

/**
 * wsl.exe écrit ses propres messages en UTF-16LE, alors que la sortie des
 * commandes Linux qu'il relaie est en UTF-8. On choisit le décodage d'après la
 * densité d'octets nuls, sinon la sortie ressort criblée de \0.
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeWslOutput(buf) {
    if (!buf || buf.length === 0) return '';
    const probe = Math.min(buf.length, 128);
    let nulls = 0;
    for (let i = 1; i < probe; i += 2) {
        if (buf[i] === 0) nulls++;
    }
    if (nulls > probe / 8) {
        return buf.toString('utf16le').replace(/\0/g, '');
    }
    return buf.toString('utf8');
}

/**
 * Convertit un chemin Windows absolu en chemin WSL (/mnt/<lettre>/...).
 *
 * On résout via `path.win32` et non `path.resolve` : la sémantique de ce
 * dernier dépend de la plateforme hôte, si bien qu'un chemin Windows valide
 * était rejeté dès que le code tournait ailleurs que sous Windows (les `\`
 * n'y sont pas des séparateurs). Sous Windows les deux sont identiques, donc
 * le comportement en production est inchangé — mais la fonction devient
 * vérifiable depuis Linux et macOS.
 *
 * @param {string} winPath
 * @returns {string}
 */
function toWslPath(winPath) {
    const abs = path.win32.resolve(winPath);
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
    if (!match) {
        throw new Error(`Chemin Windows absolu attendu, reçu: ${winPath}`);
    }
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
}

/**
 * Exécute un binaire avec des arguments passés en tableau (jamais via un
 * shell), ce qui évite toute injection de commande depuis des valeurs
 * utilisateur. Ne rejette pas: renvoie toujours un résultat décrivant l'échec.
 * @param {string} file - wsl.exe sous Windows, bash sur un hôte Linux
 * @param {string[]} args
 * @param {{timeout?: number, maxBuffer?: number}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string|null}>}
 */
function execCapture(file, args, options = {}) {
    const { timeout = DEFAULT_TIMEOUT_MS, maxBuffer = 64 * 1024 * 1024 } = options;
    return new Promise(resolve => {
        execFile(file, args, { timeout, maxBuffer, encoding: 'buffer', windowsHide: true },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    stdout: decodeWslOutput(stdout),
                    stderr: decodeWslOutput(stderr),
                    error: error ? (error.message || String(error)) : null,
                });
            });
    });
}

/**
 * Variante de execCapture diffusant la sortie ligne par ligne, indispensable
 * pour suivre un calcul CFD de plusieurs minutes sans attendre la fin du
 * processus. Le tampon brut est ré-décodé à chaque bloc: cela évite de couper un
 * caractère multi-octets et garde la détection d'encodage cohérente. La sortie
 * reste modeste (lignes CLÉ=VALEUR), les journaux OpenFOAM allant dans des
 * fichiers.
 * @param {string} file
 * @param {string[]} args
 * @param {{timeout?: number, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string|null}>}
 */
function execStream(file, args, options = {}) {
    const { timeout = DEFAULT_TIMEOUT_MS, onLine, signal } = options;
    return new Promise(resolve => {
        const child = spawn(file, args, { windowsHide: true });
        const chunks = [];
        const errChunks = [];
        let emitted = 0;
        let settled = false;

        const timer = timeout > 0 ? setTimeout(() => {
            child.kill();
            finish(`délai dépassé après ${Math.round(timeout / 1000)} s`);
        }, timeout) : null;

        const onAbort = () => { child.kill(); finish('calcul interrompu'); };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        function finish(error) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({
                ok: !error,
                stdout: decodeWslOutput(Buffer.concat(chunks)),
                stderr: decodeWslOutput(Buffer.concat(errChunks)),
                error: error || null,
            });
        }

        child.stdout.on('data', chunk => {
            chunks.push(chunk);
            if (!onLine) return;
            const text = decodeWslOutput(Buffer.concat(chunks));
            const lines = text.split(/\r?\n/);
            // La dernière entrée peut être une ligne incomplète: on la garde.
            for (let i = emitted; i < lines.length - 1; i++) onLine(lines[i]);
            emitted = Math.max(emitted, lines.length - 1);
        });
        child.stderr.on('data', chunk => errChunks.push(chunk));
        child.on('error', err => finish(err?.message || String(err)));
        child.on('close', code => finish(code === 0 ? null : `code de sortie ${code}`));
    });
}

/** Exécute wsl.exe. @see execCapture */
const runWsl = (args, options) => execCapture(WSL_EXE, args, options);

/** Exécute wsl.exe en diffusant la sortie. @see execStream */
const runWslStream = (args, options) => execStream(WSL_EXE, args, options);

/**
 * Liste les distributions WSL installées.
 *
 * Renvoie une liste vide hors Windows : il n'y a rien à énumérer, et invoquer
 * `wsl.exe` y produirait une erreur de spawn sans intérêt.
 * @returns {Promise<string[]>}
 */
async function listDistros() {
    if (!IS_WINDOWS) return [];
    const res = await runWsl(['--list', '--quiet'], { timeout: 20000 });
    if (!res.ok) return [];
    return res.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

/**
 * Parse les lignes KEY=VALUE émises par les scripts bash du dossier scripts/foam.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseKeyValues(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) out[match[1]] = match[2];
    }
    return out;
}

/**
 * Construit l'invocation d'un script du dossier scripts/foam.
 *
 * Sous Windows le script est lu par le bash d'une distribution WSL, donc le
 * chemin doit être traduit en /mnt/<lettre>/... Sur un hôte Linux le chemin est
 * déjà POSIX et bash est lancé directement : pas de distribution, pas de
 * traduction, et surtout pas de `-u root` — les fichiers du cas appartiennent à
 * l'utilisateur courant.
 * @param {string} distro
 * @param {string} scriptName - nom de fichier dans scripts/foam
 * @param {string[]} args
 * @returns {{file: string, argv: string[]}}
 */
function foamScriptCommand(distro, scriptName, args) {
    const localPath = path.join(FOAM_SCRIPTS_DIR, scriptName);
    if (!IS_WINDOWS) {
        return { file: 'bash', argv: [localPath, ...args] };
    }
    return {
        file: WSL_EXE,
        argv: ['-d', distro, '-u', 'root', '--', 'bash', toScriptPath(localPath), ...args],
    };
}

/**
 * Traduit un chemin de l'hôte vers la vue qu'en a le shell qui exécute les
 * scripts.
 *
 * Tout chemin passé EN ARGUMENT à un script doit passer par ici : le bash de
 * WSL ne voit les disques Windows que sous /mnt/<lettre>/, alors qu'un bash
 * natif attend le chemin tel quel. Oublier la conversion sous Windows, ou
 * l'appliquer sur un hôte Linux, produit dans les deux cas un chemin
 * inexistant.
 * @param {string} hostPath
 * @returns {string}
 */
function toScriptPath(hostPath) {
    return IS_WINDOWS ? toWslPath(hostPath) : hostPath;
}

/**
 * Exécute un script bash du dépôt, dans WSL sous Windows ou localement ailleurs.
 * @param {string} distro
 * @param {string} scriptName - nom de fichier dans scripts/foam
 * @param {string[]} [args]
 * @param {{timeout?: number}} [options]
 */
function runFoamScript(distro, scriptName, args = [], options = {}) {
    const { file, argv } = foamScriptCommand(distro, scriptName, args);
    return execCapture(file, argv, options);
}

/**
 * Comme runFoamScript, mais diffuse la sortie au fil de l'eau.
 * @param {string} distro
 * @param {string} scriptName
 * @param {string[]} [args]
 * @param {{timeout?: number, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 */
function runFoamScriptStream(distro, scriptName, args = [], options = {}) {
    const { file, argv } = foamScriptCommand(distro, scriptName, args);
    return execStream(file, argv, options);
}

/**
 * Interroge une distribution donnée pour savoir si OpenFOAM y est utilisable.
 * @param {string} distro
 */
async function probeDistro(distro) {
    const res = await runFoamScript(distro, 'check_env.sh', [], { timeout: 60000 });
    const info = parseKeyValues(res.stdout);
    if (info.FOAM_FOUND !== '1') {
        return {
            available: false,
            distro,
            reason: IS_WINDOWS
                ? 'OpenFOAM introuvable dans cette distribution.'
                : 'OpenFOAM introuvable sur cette machine.',
        };
    }
    const tools = {};
    for (const key of Object.keys(info)) {
        if (key.startsWith('TOOL_')) tools[key.slice(5)] = info[key] === 'OK';
    }
    const missing = REQUIRED_TOOLS.filter(tool => !tools[tool]);
    return {
        available: missing.length === 0,
        distro,
        version: info.FOAM_VERSION || null,
        bashrc: info.FOAM_BASHRC || null,
        cores: Number.parseInt(info.FOAM_NPROC, 10) || 1,
        tools,
        missing,
        reason: missing.length === 0 ? null : `Utilitaires OpenFOAM manquants: ${missing.join(', ')}`,
    };
}

/**
 * Détecte une distribution WSL disposant d'une installation OpenFOAM complète.
 *
 * Le champ `stage` dit CE QUI manque, pas seulement que ça manque : c'est lui
 * qui permet à l'interface de proposer le bon remède. `wsl --list` échoue de la
 * même façon quand wsl.exe est absent et quand aucune distribution n'est
 * installée, alors que les deux cas n'ont rien à voir — d'où la distinction sur
 * la nature de l'erreur.
 * @returns {Promise<object>}
 */
async function checkAvailability() {
    // Un paquet mal construit laisserait les scripts dans app.asar, où bash ne
    // peut pas les lire ; sans ce contrôle l'échec ressemblerait à une absence
    // d'OpenFOAM et enverrait l'utilisateur réinstaller ce qu'il a déjà.
    if (!fs.existsSync(path.join(FOAM_SCRIPTS_DIR, 'check_env.sh'))) {
        return {
            available: false,
            stage: 'no-scripts',
            distro: null,
            distros: [],
            reason: `Scripts CFD absents de l'installation (${FOAM_SCRIPTS_DIR}).`,
        };
    }

    // Hôte Linux : les scripts tournent directement, il n'y a ni WSL à trouver
    // ni distribution à choisir. Les seuls verdicts possibles sont donc « prêt »
    // ou « OpenFOAM absent / incomplet ».
    if (IS_NATIVE_HOST) {
        const local = await probeDistro(LOCAL_HOST);
        // `native` dit à l'interface qu'il n'y a ni distribution à nommer ni
        // installation à proposer depuis l'application.
        if (local.available) return { ...local, stage: 'ok', distros: [], native: true };
        return {
            ...local,
            available: false,
            stage: local.missing?.length ? 'missing-tools' : 'no-openfoam',
            distros: [],
            native: true,
        };
    }

    // macOS : pas de wsl.exe et pas d'OpenFOAM natif exploitable.
    if (!IS_WINDOWS) {
        return {
            available: false,
            stage: 'unsupported-platform',
            distro: null,
            distros: [],
            reason: `Le pipeline CFD n'est pas disponible sur ${process.platform}.`,
        };
    }

    const probe = await runWsl(['--list', '--quiet'], { timeout: 20000 });
    const noExe = /ENOENT|not recognized|est introuvable|not found/i
        .test(`${probe.error || ''} ${probe.stderr || ''}`);
    if (noExe) {
        return {
            available: false,
            stage: 'no-wsl',
            distro: null,
            distros: [],
            reason: "WSL n'est pas disponible sur cette machine.",
        };
    }

    const distros = probe.ok
        ? probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        : [];
    if (distros.length === 0) {
        return {
            available: false,
            stage: 'no-distro',
            distro: null,
            distros: [],
            reason: 'Aucune distribution WSL installée.',
        };
    }

    const ordered = distros.includes(PREFERRED_DISTRO)
        ? [PREFERRED_DISTRO, ...distros.filter(d => d !== PREFERRED_DISTRO)]
        : distros;

    let lastResult = null;
    for (const distro of ordered) {
        const result = await probeDistro(distro);
        if (result.available) return { ...result, stage: 'ok', distros };
        lastResult = lastResult || result;
    }

    return {
        ...lastResult,
        available: false,
        stage: lastResult?.missing?.length ? 'missing-tools' : 'no-openfoam',
        distros,
        // Cible par défaut de l'installation : la distribution préférée si elle
        // existe, sinon la première venue.
        distro: ordered[0],
    };
}

/**
 * Installe OpenFOAM dans une distribution WSL existante.
 *
 * N'exige AUCUN privilège Windows : tout se passe en root à l'intérieur de la
 * distribution. Installer WSL lui-même, en revanche, demande l'élévation et
 * reste à la charge de l'utilisateur.
 * @param {string} distro
 * @param {{version?: string, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 */
async function installOpenFoam(distro, options = {}) {
    const { version = '2512', onLine, signal } = options;

    // install_openfoam.sh ajoute le dépôt apt d'openfoam.com et installe en
    // root : correct dans la distribution Ubuntu que le setup CFD contrôle,
    // inacceptable sur la machine de l'utilisateur. On renvoie donc l'install
    // au gestionnaire de paquets de l'hôte.
    if (!IS_WINDOWS) {
        return {
            ok: false,
            reason: "Sur Linux, OpenFOAM s'installe via le gestionnaire de paquets de la "
                + 'distribution (paquet openfoam), puis « Re-check ». '
                + 'Définissez FOAM_BASHRC si le chemin est inhabituel.',
        };
    }

    if (!/^[A-Za-z0-9._-]+$/.test(distro)) {
        return { ok: false, reason: `nom de distribution invalide: ${distro}` };
    }
    const res = await runFoamScriptStream(distro, 'install_openfoam.sh', [String(version)], {
        // Le téléchargement pèse près d'un gigaoctet sur un lien quelconque.
        timeout: 45 * 60 * 1000,
        onLine,
        signal,
    });
    const info = parseKeyValues(res.stdout);
    if (info.FOAM_ERROR) return { ok: false, reason: info.FOAM_ERROR };
    if (!res.ok) return { ok: false, reason: res.error || 'installation interrompue' };
    if (info.FOAM_RESULT !== 'ok') return { ok: false, reason: "l'installation ne s'est pas terminée" };
    return { ok: true, version: info.FOAM_VERSION || null, bashrc: info.FOAM_BASHRC || null };
}

module.exports = {
    PREFERRED_DISTRO,
    LOCAL_HOST,
    IS_WINDOWS,
    IS_NATIVE_HOST,
    REQUIRED_TOOLS,
    FOAM_SCRIPTS_DIR,
    decodeWslOutput,
    toWslPath,
    toScriptPath,
    foamScriptCommand,
    runWsl,
    runWslStream,
    listDistros,
    parseKeyValues,
    runFoamScript,
    runFoamScriptStream,
    probeDistro,
    checkAvailability,
    installOpenFoam,
};
