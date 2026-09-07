// =======================================================
// scripts/lib/env_paths.mjs
//
// RÔLE : résoudre les chemins dont dépendent les harnais (binaire gmsh,
//        jeux de données .TBBS) sans coder en dur l'arborescence d'une seule
//        machine de développement.
//
// Les harnais tournaient auparavant avec des littéraux du type
// `C:\Program Files\gmsh-4.15.0-Windows64\gmsh.exe` et `DEV-BEM/8br40.TBBS`,
// ce qui les rendait inutilisables ailleurs — et, en cas d'absence, produisait
// une trace ENOENT brute au lieu d'expliquer ce qui manque.
// =======================================================
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Racine du dépôt (scripts/lib -> scripts -> racine). */
export const repoRoot = join(here, '..', '..');

/**
 * Cherche un exécutable dans le PATH et renvoie son chemin absolu.
 *
 * Plusieurs harnais testent `existsSync(GMSH)` avant de lancer le binaire : un
 * simple nom de commande échouerait ce contrôle même quand gmsh est
 * parfaitement installé. On résout donc jusqu'au chemin complet.
 *
 * @param {string} name nom de la commande, sans extension
 * @returns {string|null}
 */
function findOnPath(name) {
    const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    // PATHEXT décide des extensions exécutables sous Windows.
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
        : [''];
    for (const dir of dirs) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = join(dir, name + ext);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Chemin du binaire gmsh.
 *
 * Ordre de priorité :
 *   1. argument explicite (option `--gmsh` ou argv du harnais)
 *   2. variable d'environnement `GMSH`
 *   3. `gmsh` localisé dans le PATH (chemin absolu)
 *
 * En dernier recours on renvoie `'gmsh'` : `execFile` peut encore aboutir même
 * si le balayage du PATH n'a rien trouvé (alias shell, PATH modifié depuis).
 *
 * @param {string} [explicit] chemin fourni par l'utilisateur
 * @returns {string}
 */
export function resolveGmsh(explicit) {
    const candidate = explicit || process.env.GMSH;
    if (candidate && candidate.trim() !== '') return candidate;
    return findOnPath('gmsh') || 'gmsh';
}

/**
 * Résout un jeu de données de test et échoue avec un message actionnable.
 *
 * Les fichiers .TBBS de référence ne sont pas versionnés (voir `DEV-BEM/` et
 * `AKABAK CURVES/` dans .gitignore). Plutôt qu'un ENOENT opaque, on indique
 * quel fichier est attendu et comment le pointer ailleurs.
 *
 * @param {string} relative chemin par défaut, relatif à la racine du dépôt
 * @param {object} [options]
 * @param {string} [options.explicit] chemin explicite (argv) qui court-circuite tout
 * @param {string} [options.envVar='TBBS_DATA_DIR'] variable pointant un dossier de remplacement
 * @returns {string} chemin absolu existant
 */
export function resolveDataFile(relative, { explicit, envVar = 'TBBS_DATA_DIR' } = {}) {
    const tried = [];

    if (explicit) {
        const p = isAbsolute(explicit) ? explicit : join(repoRoot, explicit);
        if (existsSync(p)) return p;
        tried.push(p);
    }

    const overrideDir = process.env[envVar];
    if (overrideDir) {
        // On accepte que la variable pointe la racine contenant le même
        // sous-dossier, ou directement le dossier des fichiers.
        const base = relative.split(/[\\/]/).pop();
        for (const p of [join(overrideDir, relative), join(overrideDir, base)]) {
            if (existsSync(p)) return p;
            tried.push(p);
        }
    }

    const fallback = join(repoRoot, relative);
    if (existsSync(fallback)) return fallback;
    tried.push(fallback);

    throw new Error(
        `Jeu de données introuvable : ${relative}\n` +
        `  Cherché dans :\n${tried.map(p => `    - ${p}`).join('\n')}\n` +
        `  Ces fichiers .TBBS de référence ne sont pas versionnés.\n` +
        `  Passez le chemin en argument, ou définissez ${envVar}=/chemin/vers/les/donnees`
    );
}
