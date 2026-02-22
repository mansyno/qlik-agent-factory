/**
 * agent_runner.js
 * Decoupled agent orchestration — callable from the Express API or CLI.
 * Accepts an `io` instance and `broadcastAgentState` for real-time streaming.
 */

const fs = require('fs');
const path = require('path');
const { openSession, closeSession, profileData, validateScript } = require('./qlik_tools');
const { generateScript } = require('./brain');

const ENHANCER_MARKER = '// *** ENHANCER AGENT OUTPUT (Hybrid Model) ***';

// Pause/stop gate — call between operations. Returns true to continue, false to abort.
async function checkControl(ctrl, broadcast) {
    if (!ctrl) return true;
    if (ctrl.paused && !ctrl.stopRequested) {
        broadcast('System', '⏸ Job paused — press Resume to continue.', 'warning');
        await new Promise(resolve => { ctrl.resumeCallback = resolve; });
        if (!ctrl.stopRequested) broadcast('System', '▶ Job resumed.', 'success');
    }
    if (ctrl.stopRequested) {
        broadcast('System', '⏹ Job stopped by user.', 'warning');
        return false;
    }
    return true;
}

async function fetchLiveBaseScript(appName, global, broadcast) {
    try {
        broadcast('System', `Enhancer-only mode: reading live script from '${appName}'...`, 'info');
        const appHandle = await global.openDoc(appName);
        const fullScript = await appHandle.getScript();
        const parts = fullScript.split(ENHANCER_MARKER);
        const baseScript = parts[0].trim();
        if (!baseScript) throw new Error('Base script portion is empty.');
        broadcast('System', 'Base script extracted from live app. Running Enhancer only.', 'success');
        return { baseScript, appHandle };
    } catch (err) {
        broadcast('System', `Could not read live app — falling back to full run. (${err.message || JSON.stringify(err)})`, 'warning');
        return null;
    }
}

async function runAgent({ dataDir, appName, pipeline = ['architect', 'enhancer'], io, broadcastAgentState, agentControl }) {
    const ctrl = agentControl || null;
    const broadcast = broadcastAgentState || ((agent, msg, type) => console.log(`[${agent}] ${msg}`));

    const logger = require('./.agent/utils/logger.js');
    logger.initialize();
    logger.log('System', 'Job Started', { dataDir, targetAppName: appName });

    broadcast('System', `Job Started — Data: ${dataDir} | App: ${appName}`, 'info');

    if (!fs.existsSync(dataDir)) {
        broadcast('System', `Directory ${dataDir} does not exist.`, 'error');
        throw new Error(`Directory ${dataDir} does not exist.`);
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.txt'));
    if (files.length === 0) {
        broadcast('System', `No CSV/TXT files found in ${dataDir}.`, 'error');
        throw new Error(`No CSV/TXT files found in ${dataDir}.`);
    }

    let session, global;

    try {
        broadcast('System', 'Connecting to Qlik Engine...', 'info');
        const connection = await openSession();
        session = connection.session;
        global = connection.global;
        broadcast('System', 'Connected to Qlik Engine.', 'success');
        logger.log('System', 'Connected to Qlik Engine');

        const workApp = await global.createSessionApp();
        await workApp.createConnection({
            qName: 'SourceData',
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });

        const runArchitect = pipeline.includes('architect');
        const runEnhancer = pipeline.includes('enhancer');

        // ── Phase 1: Profiling (skipped for Enhancer-only) ───────────────
        const profiles = {};
        if (runArchitect) {
            broadcast('Architect', '── Phase 1: Profiling Data ──', 'phase');
            logger.log('Architect', 'Starting Data Profiling');
            for (const file of files) {
                broadcast('Architect', `Profiling ${file}...`, 'info');
                const profile = await profileData(global, path.resolve(dataDir, file), workApp);
                if (profile.error) {
                    broadcast('Architect', `Failed to profile ${file}: ${profile.error}`, 'error');
                    logger.error('Architect', `Profiling failed for ${file}`, profile.error);
                } else {
                    profiles[file] = profile;
                }
            }
            if (Object.keys(profiles).length === 0) throw new Error('No data could be profiled.');
            if (io) io.emit('model-artifact', profiles);
        }
        // ── Phase 1 complete — check before Architect ─────────────────────
        if (!(await checkControl(ctrl, broadcast))) return;

        // ── Phase 2: Architect ────────────────────────────────────────────
        let currentScript = '';
        let success = false;

        if (runArchitect) {
            broadcast('Architect', '── Phase 2: Architectural Reasoning ──', 'phase');
            const CACHE_FILE = '.cache_base_script.qvs';
            const maxAttempts = 3;
            let feedback = null;

            for (let attempt = 1; attempt <= maxAttempts && !success; attempt++) {
                broadcast('Architect', `Generating Script — Attempt ${attempt}/${maxAttempts}`, 'info');
                logger.log('Architect', `Generating Script Attempt ${attempt}`);

                const heartbeat = setInterval(async () => {
                    try { await global.engineVersion(); } catch (e) { /* ignore */ }
                }, 5000);

                try {
                    currentScript = await generateScript({ profiles, feedback, previousScript: currentScript });
                } catch (err) {
                    broadcast('Architect', `LLM error: ${err.message}`, 'error');
                    logger.error('Architect', 'AI Inference Error', err);
                    clearInterval(heartbeat);
                    continue;
                } finally {
                    clearInterval(heartbeat);
                }

                const validation = await validateScript(global, currentScript, workApp);
                if (validation.success && validation.synKeys === 0) {
                    broadcast('Architect', `✅ Script validated (attempt ${attempt})`, 'success');
                    logger.log('Architect', 'Script Verification Passed', { attempt });
                    success = true;
                    fs.writeFileSync(CACHE_FILE, currentScript);
                    if (io) io.emit('script-update', { phase: 'architect', script: currentScript });
                } else {
                    broadcast('Architect', `Validation failed — SynKeys: ${validation.synKeys}`, 'warning');
                    if (validation.errors && validation.errors.length > 0) {
                        validation.errors.forEach(e => broadcast('Architect', `↳ ${e}`, 'error'));
                    }
                    logger.log('Architect', 'Validation Failed', { synKeys: validation.synKeys, errors: validation.errors });
                    feedback = validation;
                }
                // check control between attempts
                if (success) break;
                if (!(await checkControl(ctrl, broadcast))) return;
            }
        } else if (runEnhancer) {
            // Enhancer-only: fetch base script from live app
            const live = await fetchLiveBaseScript(appName, global, broadcast);
            if (live) {
                currentScript = live.baseScript;
                success = true;
            } else {
                // Fallback: run full pipeline
                broadcast('System', 'Falling back to full pipeline run.', 'warning');
                pipeline.push('architect');
                throw new Error('Enhancer-only fallback requires restart with full pipeline.');
            }
        }
        // ── Phase 2 complete — check before Enhancer ──────────────────────
        if (!(await checkControl(ctrl, broadcast))) return;

        // ── Phase 3: Enhancer ─────────────────────────────────────────────
        if (success && runEnhancer) {
            broadcast('Enhancer', '── Phase 3: Enhancer Agent ──', 'phase');
            logger.log('Enhancer', 'Starting Enrichment Phase (Hybrid)');

            try {
                const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
                const metadata = await inspector.inspectMetadata(workApp);

                const { generateEnrichmentPlan } = require('./enhancer_brain');
                const plan = await generateEnrichmentPlan(metadata, currentScript);
                broadcast('Enhancer', plan.reasoningSummary, 'reasoning');

                const { composeEnrichment } = require('./enhancer_composer');
                const { enrichedScript, report } = await composeEnrichment(plan, currentScript, global, workApp);

                report.forEach(r => {
                    const icon = r.status.startsWith('Applied') ? '✅' : '❌';
                    broadcast('Enhancer', `${icon} [${r.tier.toUpperCase()}] ${r.tool}: ${r.status}`, r.status.startsWith('Applied') ? 'success' : 'warning');
                });
                logger.enhancement('Enhancement Report', report);

                const enhancedValidation = await validateScript(global, enrichedScript, workApp);
                if (enhancedValidation.success && enhancedValidation.synKeys === 0) {
                    broadcast('Enhancer', '✅ Enriched script validated.', 'success');
                    logger.enhancement('Validation Success', 'Hybrid script passed checks.');
                    currentScript = enrichedScript;
                    if (io) io.emit('script-update', { phase: 'enhancer', script: currentScript });
                } else {
                    broadcast('Enhancer', '⚠️ Enriched script invalid — reverting to base.', 'warning');
                }
            } catch (enhancerErr) {
                broadcast('Enhancer', `Critical error: ${enhancerErr.message}`, 'error');
                logger.error('Enhancer', 'Critical Runtime Error', enhancerErr);
            }
        } else if (success && !runEnhancer) {
            broadcast('System', 'Enhancer skipped (Architect-only mode).', 'info');
        }

        // ── Phase 4: Finalization ─────────────────────────────────────────
        broadcast('System', '── Phase 4: Finalization ──', 'phase');
        if (success) {
            fs.writeFileSync('final_script.qvs', currentScript);
            broadcast('System', 'Final script saved to final_script.qvs', 'success');
            logger.log('System', 'Final Script Saved', { path: 'final_script.qvs' });

            // Phase 5: Promote
            broadcast('System', '── Phase 5: Promoting to Persistent App ──', 'phase');
            if (session) { await closeSession(session); session = null; }

            const { openSession: openS, createPersistentApp } = require('./qlik_tools');
            const conn2 = await openS();
            session = conn2.session;
            const promoGlobal = conn2.global;

            const persistentApp = await createPersistentApp(promoGlobal, appName);
            try {
                await persistentApp.createConnection({ qName: 'SourceData', qConnectionString: path.resolve(dataDir), qType: 'folder' });
            } catch (e) {
                if (!e.message.includes('already exists')) throw e;
            }
            await persistentApp.setScript(currentScript);
            const reloadResult = await persistentApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });
            const reloadOk = reloadResult.qSuccess;
            const reloadMsg = reloadOk
                ? '✅ Success'
                : `❌ Failed — ${reloadResult.qErrorDesc || 'no detail'} (code ${reloadResult.qErrorCode})`;
            broadcast('System', `Reload: ${reloadMsg}`, reloadOk ? 'success' : 'error');
            logger.log('System', 'App Reload Finished', { success: reloadOk });

            await persistentApp.doSave();
            broadcast('System', `App '${appName}' saved successfully.`, 'success');
            logger.log('System', 'App Saved', { appName });
        } else {
            broadcast('Architect', '❌ Failed to generate valid script within attempt limit.', 'error');
            logger.error('Architect', 'Failed to generate script after max attempts');
        }

    } catch (err) {
        const errMsg = err.message || JSON.stringify(err);
        broadcast('System', `Fatal Error: ${errMsg}`, 'error');
        logger.error('System', 'Fatal Process Error', err);
    } finally {
        if (session) {
            try { await closeSession(session); } catch (e) { /* ignore */ }
        }
        logger.log('System', 'Process Terminated');
        logger.save();
        broadcast('System', 'Agent process complete. Audit log saved.', 'info');
    }
}

module.exports = { runAgent };
