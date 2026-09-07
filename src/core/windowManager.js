// =======================================================
// FICHIER :  src/core/windowManager.js
// RÔLE    :  Création et gestion des fenêtres de l'application
// =======================================================
const { BrowserWindow } = require('electron');
const path = require('path');
const { getSettings } = require('./settings');

// Variable pour garder une référence à la fenêtre principale
let mainWindow = null;

/**
 * Icône de fenêtre adaptée à la plateforme.
 *
 * Chromium ne sait décoder le format .ico que sous Windows : ailleurs
 * `nativeImage` renvoie une image vide (0x0) et la fenêtre retombe sur l'icône
 * Electron par défaut. On sert donc un PNG sous Linux et macOS.
 *
 * Note : le PNG doit vivre dans `src/`, car seul `src/**` est empaqueté
 * (voir le champ `build.files` du package.json) — `build/icon.png` n'existe
 * pas dans l'application installée.
 */
const WINDOW_ICON = path.join(
    __dirname, '..', 'assets', 'icon',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

/**
 * Crée la fenêtre principale de l'application.
 * @returns {BrowserWindow} L'instance de la fenêtre principale.
 */
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        backgroundColor: '#000000',
        frame: false,
        resizable: true,
        transparent: false,
        hasShadow: true,
        show: false,
        icon: WINDOW_ICON,
        webPreferences: {
            // Le chemin du preload est maintenant relatif à la racine (src)
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    const preloadPath = path.join(__dirname, '..', 'preload.js');
    console.log('[WindowManager] Preload path:', preloadPath);
    console.log('[WindowManager] __dirname:', __dirname);

    // mainWindow.webContents.openDevTools(); //CETTE LIGNE DOIT RESTER COMMENTÉE EN PRODUCTION ET NE DOIT PAS ETRE SUPPRIMÉE

    // [DÉSACTIVÉ] Pour enlever complètement la barre de menu (File, Edit, View, etc.)
     mainWindow.setMenuBarVisibility(true);
     mainWindow.setMenu(null);
    // Le chemin de l'index.html est aussi relatif à la racine (src)
    mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    
    return mainWindow;
}

/**
 * Crée la fenêtre de démarrage (splash screen).
 * @returns {BrowserWindow} L'instance de la fenêtre splash.
 */
function createSplashWindow() {
    const splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        backgroundColor: '#000000',
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        icon: WINDOW_ICON
    });
    splashWindow.loadFile(path.join(__dirname, '..', 'splash.html'));
    return splashWindow;
}

/**
 * Crée une fenêtre secondaire pour un outil spécifique.
 * @param {object} options - Les options pour la fenêtre.
 * @param {string} options.toolName - Le nom de l'outil à charger.
 * @param {string} options.title - Le titre de la fenêtre.
 * @returns {BrowserWindow} L'instance de la fenêtre outil.
 */
function createToolWindow({ toolName, title }) {
    const appSettings = getSettings();
    
    // Tailles spéciales pour certains popups
    let width = 800;
    let height = 600;
    
    if (toolName === 'mesh-mini') {
        width = 320;
        height = 300;
    } else if (toolName === 'mesh-preview') {
        width = 1280;
        height = 860;
    } else if (toolName === 'drivers-database') {
        width = 360;
        height = 480;
    } else if (toolName === 'notes-mini') {
        width = 400;
        height = 400;
    }
    
    const toolWindow = new BrowserWindow({
        width: width,
        height: height,
        backgroundColor: '#000000',
        title: title,
        frame: false, // Contrôles personnalisés pour tous les popups
        alwaysOnTop: appSettings.popupsAlwaysOnTop,
        resizable: true,
        icon: WINDOW_ICON,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            // Argument pour dire au renderer quel outil charger
            additionalArguments: [`--tool=${toolName}`]
        }
    });
    toolWindow.loadFile(path.join(__dirname, '..', 'popup.html'));
    return toolWindow;
}

/**
 * Récupère l'instance de la fenêtre principale.
 * @returns {BrowserWindow | null} L'instance de la fenêtre ou null si elle est fermée.
 */
function getMainWindow() {
    return mainWindow;
}

// --- EXPORTATIONS ---
module.exports = { 
    createMainWindow, 
    createSplashWindow, 
    createToolWindow, 
    getMainWindow 
};