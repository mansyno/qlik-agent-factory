/**
 * path_manager.js
 * 
 * Single source of truth for all workspace path construction.
 * 
 * Folder structure:
 *   projects/
 *     └── [ProjectName]/
 *           └── [dataFolderName]_[appName]/
 *                 ├── run_config.json   (manifest — full dataDir, appName, timestamps)
 *                 ├── final_script.qvs
 *                 ├── audit_log.json
 *                 └── ... (all phase outputs)
 */

const fs   = require('fs');
const path = require('path');

const PROJECTS_ROOT = path.join(__dirname, 'projects');

// ─── Core Path Construction ───────────────────────────────────────────────────

/**
 * Returns the absolute path to a run folder.
 * Does NOT create it — use ensureRunFolder() for that.
 */
function getRunFolder(projectName, dataDir, appName) {
    const dataFolderName = path.basename(path.resolve(dataDir));
    const runFolderName  = `${dataFolderName}_${appName}`;
    return path.join(PROJECTS_ROOT, projectName, runFolderName);
}

/**
 * Creates the run folder (and all parents) if they don't exist.
 * Idempotent — safe to call on every run.
 * Returns the absolute run folder path.
 */
function ensureRunFolder(projectName, dataDir, appName) {
    const runPath = getRunFolder(projectName, dataDir, appName);
    fs.mkdirSync(runPath, { recursive: true });
    return runPath;
}

// ─── Run Config Manifest ──────────────────────────────────────────────────────

/**
 * Writes a run_config.json manifest into the run folder.
 * Records the full absolute dataDir path so it can be recovered when the
 * user selects an existing run in the UI (the folder name only stores the basename).
 * 
 * Overwrites on every run — consistent with the no-versioning policy.
 */
function writeRunConfig(runFolder, projectName, dataDir, appName) {
    const config = {
        projectName,
        dataDir: path.resolve(dataDir),   // always store absolute path
        appName,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(
        path.join(runFolder, 'run_config.json'),
        JSON.stringify(config, null, 2)
    );
}

/**
 * Reads run_config.json from a run folder.
 * Returns the parsed config object, or null if the file doesn't exist or is malformed.
 */
function readRunConfig(runFolder) {
    const cfgPath = path.join(runFolder, 'run_config.json');
    if (!fs.existsSync(cfgPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

// ─── Directory Listings ───────────────────────────────────────────────────────

/**
 * Returns a list of project names (top-level directories under projects/).
 */
function listProjects() {
    if (!fs.existsSync(PROJECTS_ROOT)) return [];
    return fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
}

/**
 * Returns a list of run folder names under a given project.
 */
function listRuns(projectName) {
    const projectPath = path.join(PROJECTS_ROOT, projectName);
    if (!fs.existsSync(projectPath)) return [];
    return fs.readdirSync(projectPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
}

module.exports = {
    PROJECTS_ROOT,
    getRunFolder,
    ensureRunFolder,
    writeRunConfig,
    readRunConfig,
    listProjects,
    listRuns
};
