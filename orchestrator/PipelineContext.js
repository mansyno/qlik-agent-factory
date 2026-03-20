const fs = require('fs');
const path = require('path');
const logger = require('../.agent/utils/logger.js');
const { openSession, openSessionForApp, closeSession } = require('../qlik_tools');
const { ensureRunFolder, writeRunConfig } = require('../path_manager');

class PipelineContext {
    constructor(config) {
        this.projectName = config.projectName;
        this.dataDir = config.dataDir;
        this.appName = config.appName;
        this.pipeline = config.pipeline || ['architect', 'enhancer'];
        this.io = config.io;
        this.broadcastFn = config.broadcastAgentState || ((agent, msg, type) => logger.log(type?.toUpperCase() || 'INFO', msg, null, agent));
        this.agentControl = config.agentControl || null;

        // Pipeline state
        this.runFolder = null;
        this.currentScript = '';
        this.success = false;

        // Connection state
        this.session = null;
        this.qlikGlobal = null;
        this.workApp = null;
        this.persistentApp = null;
    }

    async initialize() {
        this.runFolder = ensureRunFolder(this.projectName, this.dataDir, this.appName);
        writeRunConfig(this.runFolder, this.projectName, this.dataDir, this.appName);

        logger.setRunFolder(this.runFolder);
        logger.initialize();
        logger.info('System', 'Job Started', { projectName: this.projectName, dataDir: this.dataDir, targetAppName: this.appName, runFolder: this.runFolder });
        this.emit('System', `Job Started — Project: ${this.projectName} | Data: ${this.dataDir} | App: ${this.appName}`, 'info');

        if (!fs.existsSync(this.dataDir)) {
            this.emit('System', `Directory ${this.dataDir} does not exist.`, 'error');
            throw new Error(`Directory ${this.dataDir} does not exist.`);
        }
    }

    emit(agent, msg, type) {
        this.broadcastFn(agent, msg, type);
    }

    logError(agent, msg, error) {
        logger.error(agent, msg, error);
        this.emit(agent, `${msg}: ${error.message || error}`, 'error');
    }

    async checkControl() {
        const ctrl = this.agentControl;
        if (!ctrl) return true;
        if (ctrl.paused && !ctrl.stopRequested) {
            this.emit('System', '⏸ Job paused — press Resume to continue.', 'warning');
            await new Promise(resolve => { ctrl.resumeCallback = resolve; });
            if (!ctrl.stopRequested) this.emit('System', '▶ Job resumed.', 'success');
        }
        if (ctrl.stopRequested) {
            this.emit('System', '⏹ Job stopped by user.', 'warning');
            return false;
        }
        return true;
    }

    async fetchLiveBaseScript() {
        let readSession = null;
        try {
            this.emit('System', `Enhancer-only mode: reading live script from '${this.appName}'...`, 'info');
            const readConn = await openSessionForApp(this.appName);
            readSession = readConn.session;
            const fullScript = await readConn.appHandle.getScript();
            const ENHANCER_MARKER = '// *** ENHANCER AGENT OUTPUT (Hybrid Model) ***';
            const parts = fullScript.split(ENHANCER_MARKER);
            const baseScript = parts[0].trim();
            if (!baseScript) throw new Error('Base script portion is empty.');
            this.emit('System', `Base script read from live app (${baseScript.split('\\n').length} lines).`, 'success');
            return baseScript;
        } catch (err) {
            const msg = err.message || JSON.stringify(err);
            this.emit('System', `Could not read live app: ${msg}`, 'error');
            return null;
        } finally {
            if (readSession) { try { await closeSession(readSession); } catch (_) { } }
        }
    }

    async connectEngine() {
        this.emit('System', 'Connecting to Qlik Engine...', 'info');
        const connection = await openSession();
        this.session = connection.session;
        this.qlikGlobal = connection.global;
        this.emit('System', 'Connected to Qlik Engine.', 'success');
        logger.info('System', 'Connected to Qlik Engine');
    }

    async createSessionApp() {
        this.emit('System', 'Creating session app for architecture...', 'info');
        this.workApp = await this.qlikGlobal.createSessionApp();
        try {
            await this.workApp.createConnection({
                qName: 'SourceData',
                qConnectionString: path.resolve(this.dataDir),
                qType: 'folder'
            });
        } catch (e) {
            if (!e.message?.includes('already exists')) throw e;
        }
    }

    async openPersistentAppForWork() {
        this.emit('System', `Opening persistent app '${this.appName}' for enrichment...`, 'info');
        try {
            this.workApp = await this.qlikGlobal.openDoc(this.appName);
        } catch (e) {
            // FALLBACK: Name resolution bridge
            const appConn = await openSessionForApp(this.appName);
            // CRITICAL: Close and replace the old session to avoid a "dangling" main session
            if (this.session) { try { await this.session.close(); } catch (_) { } }
            this.session = appConn.session;
            this.qlikGlobal = appConn.global;
            this.workApp = appConn.appHandle;
        }
    }

    async transitionToPersistentAppSession() {
        // IMPORTANT: Qlik Desktop only allows ONE active document per session.
        // The session app from Phase 1 is still open. We MUST close this session
        // and open a fresh one before we can create/open a persistent app.
        await this.cleanup();
        
        const promoConn = await openSession();
        this.session = promoConn.session;
        this.qlikGlobal = promoConn.global;
    }

    async fallbackToOpenSessionForApp() {
        const connFallback = await openSessionForApp(this.appName);
        await this.cleanup();
        this.session = connFallback.session;
        this.qlikGlobal = connFallback.global;
        this.persistentApp = connFallback.appHandle;
    }

    async cleanup() {
        if (this.session) {
            try { await closeSession(this.session); } catch (_) { /* ignore */ }
            this.session = null;
            this.qlikGlobal = null;
            this.workApp = null;
        }
    }
}

module.exports = PipelineContext;