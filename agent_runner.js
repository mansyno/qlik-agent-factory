/**
 * agent_runner.js
 * Decoupled agent orchestration — callable from the Express API or CLI.
 * Accepts an `io` instance and `broadcastAgentState` for real-time streaming.
 */

const fs = require('fs');
const path = require('path');
const { openSession, openSessionForApp, closeSession, profileData, validateScript } = require('./qlik_tools');
const { generateScript } = require('./brain');
const { generateLayoutPlan } = require('./layout_brain');
const { composeLayout } = require('./layout_composer');

const ENHANCER_MARKER = '// *** ENHANCER AGENT OUTPUT (Hybrid Model) ***';
const CACHE_FILE = '.cache_base_script.qvs';

// ── Pause/Stop Gate ───────────────────────────────────────────────────────────
// Returns true to continue, false to abort.
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

// ── Enhancer-Only: Read Live Script ──────────────────────────────────────────
// Opens a dedicated session for the named persistent app, reads getScript(),
// then closes it. Uses openSessionForApp which resolves name → GUID via
// getDocList() to avoid "Unknown error" when passing a display name to openDoc.
async function fetchLiveBaseScript(appName, broadcastFn) {
    let readSession = null;
    try {
        broadcastFn('System', `Enhancer-only mode: reading live script from '${appName}'...`, 'info');
        const readConn = await openSessionForApp(appName);
        readSession = readConn.session;
        const fullScript = await readConn.appHandle.getScript();
        const parts = fullScript.split(ENHANCER_MARKER);
        const baseScript = parts[0].trim();
        if (!baseScript) throw new Error('Base script portion is empty.');
        broadcastFn('System', `Base script read from live app (${baseScript.split('\n').length} lines).`, 'success');
        return baseScript;
    } catch (err) {
        const msg = err.message || JSON.stringify(err);
        broadcastFn('System', `Could not read live app: ${msg}`, 'error');
        return null;
    } finally {
        if (readSession) { try { await closeSession(readSession); } catch (_) { } }
    }
}

// ── Main Agent Runner ─────────────────────────────────────────────────────────
async function runAgent({ dataDir, appName, pipeline = ['architect', 'enhancer'], io, broadcastAgentState, agentControl }) {
    const broadcast = (typeof broadcastAgentState === 'function')
        ? broadcastAgentState
        : (agent, msg) => console.log(`[${agent}] ${msg}`);
    const ctrl = agentControl || null;

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

    let session = null;
    let qlikGlobal = null;

    // Determine pipeline flags early — needed before session opens
    const runArchitect = pipeline.includes('architect');
    const runEnhancer = pipeline.includes('enhancer');
    const runLayout = pipeline.includes('layout');

    // ── Enhancer/Layout-only: read base script BEFORE opening the working session ────
    // This avoids "App already open" — the read session is opened and closed
    // first, then the working session opens with no conflict.
    let preloadedBaseScript = null;
    if (!runArchitect && (runEnhancer || runLayout)) {
        preloadedBaseScript = await fetchLiveBaseScript(appName, broadcast);
        if (!preloadedBaseScript && runEnhancer) return; // fatal for enhancer, layout can ignore
    }

    try {
        broadcast('System', 'Connecting to Qlik Engine...', 'info');
        const connection = await openSession();
        session = connection.session;
        qlikGlobal = connection.global;
        broadcast('System', 'Connected to Qlik Engine.', 'success');
        logger.log('System', 'Connected to Qlik Engine');

        const workApp = await qlikGlobal.createSessionApp();
        try {
            await workApp.createConnection({
                qName: 'SourceData',
                qConnectionString: path.resolve(dataDir),
                qType: 'folder'
            });
        } catch (e) {
            if (!e.message?.includes('already exists')) throw e;
        }

        // ── Phase 1: Profiling (skipped for Enhancer-only) ───────────────────
        const profiles = {};
        if (runArchitect) {
            broadcast('Architect', '── Phase 1: Profiling Data ──', 'phase');
            logger.log('Architect', 'Starting Data Profiling');
            for (const file of files) {
                broadcast('Architect', `Profiling ${file}...`, 'info');
                const profile = await profileData(qlikGlobal, path.resolve(dataDir, file), workApp);
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

        // ── Phase 1 → 2 gate ─────────────────────────────────────────────────
        if (!(await checkControl(ctrl, broadcast))) return;

        // ── Phase 2: Architect / Enhancer-only base read ──────────────────────
        let currentScript = '';
        let success = false;

        if (runArchitect) {
            broadcast('Architect', '── Phase 2: Architectural Reasoning ──', 'phase');
            const maxAttempts = 3;
            let feedback = null;

            for (let attempt = 1; attempt <= maxAttempts && !success; attempt++) {
                broadcast('Architect', `Generating Script — Attempt ${attempt}/${maxAttempts}`, 'info');
                logger.log('Architect', `Generating Script Attempt ${attempt}`);

                const heartbeat = setInterval(async () => {
                    try { await qlikGlobal.engineVersion(); } catch (_) { /* ignore */ }
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

                const validation = await validateScript(qlikGlobal, currentScript, workApp);
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
                if (success) break;
                if (!(await checkControl(ctrl, broadcast))) return;
            }
        } else if (runEnhancer || runLayout) {
            // preloadedBaseScript was fetched before the working session opened
            // (see top of runAgent). Re-calling fetchLiveBaseScript here would
            // conflict with the already-open working session — so we reuse it.
            if (preloadedBaseScript) {
                currentScript = preloadedBaseScript;
                success = true;
            } else if (runLayout && !runEnhancer) {
                // Layout only mode doesn't strictly need the base script to exist
                success = true;
            } else {
                return; // fetchLiveBaseScript already broadcast the error
            }
        }

        // ── Phase 2 → 3 gate ─────────────────────────────────────────────────
        if (!(await checkControl(ctrl, broadcast))) return;

        // ── Phase 3: Enhancer ─────────────────────────────────────────────────
        if (success && runEnhancer) {
            broadcast('Enhancer', '── Phase 3: Enhancer Agent ──', 'phase');
            logger.log('Enhancer', 'Starting Enrichment Phase (Hybrid)');

            let plan, enrichedScript, report;

            // Stage A: Inspect + Plan
            try {
                const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
                const metadata = await inspector.inspectMetadata(workApp);
                const { generateEnrichmentPlan } = require('./enhancer_brain');
                plan = await generateEnrichmentPlan(metadata, currentScript);
                broadcast('Enhancer', plan.reasoningSummary, 'reasoning');
            } catch (planErr) {
                console.error('[Enhancer] Plan stage error:', planErr.stack || planErr);
                broadcast('Enhancer', `Plan generation failed [${planErr.constructor?.name}]: ${planErr.message}`, 'error');
                logger.error('Enhancer', 'Plan Stage Error', planErr);
                plan = null;
            }

            // Stage B: Compose enrichments
            if (plan) {
                try {
                    const { composeEnrichment } = require('./enhancer_composer');
                    ({ enrichedScript, report } = await composeEnrichment(plan, currentScript, qlikGlobal, workApp));

                    report.forEach(r => {
                        const ok = r.status.startsWith('Applied');
                        const icon = ok ? '✅' : '❌';
                        const reason = !ok && r.reason ? ` — ${r.reason}` : '';
                        broadcast('Enhancer', `${icon} [${r.tier.toUpperCase()}] ${r.tool}: ${r.status}${reason}`, ok ? 'success' : 'warning');
                    });
                    logger.enhancement('Enhancement Report', report);
                } catch (composeErr) {
                    console.error('[Enhancer] Compose stage error:', composeErr.stack || composeErr);
                    broadcast('Enhancer', `Compose failed [${composeErr.constructor?.name}]: ${composeErr.message}`, 'error');
                    logger.error('Enhancer', 'Compose Stage Error', composeErr);
                    enrichedScript = null;
                }
            }

            // Stage C: Final validation
            if (enrichedScript) {
                try {
                    const enhancedValidation = await validateScript(qlikGlobal, enrichedScript, workApp);
                    if (enhancedValidation.success && enhancedValidation.synKeys === 0) {
                        broadcast('Enhancer', '✅ Enriched script validated.', 'success');
                        logger.enhancement('Validation Success', 'Hybrid script passed checks.');
                        currentScript = enrichedScript;
                        if (io) io.emit('script-update', { phase: 'enhancer', script: currentScript });
                    } else {
                        broadcast('Enhancer', '⚠️ Enriched script invalid — reverting to base.', 'warning');
                        if (enhancedValidation.errors?.length) {
                            enhancedValidation.errors.forEach(e => broadcast('Enhancer', `↳ ${e}`, 'error'));
                        }
                    }
                } catch (valErr) {
                    console.error('[Enhancer] Validate stage error:', valErr.stack || valErr);
                    broadcast('Enhancer', `Final validation failed [${valErr.constructor?.name}]: ${valErr.message}`, 'error');
                }
            }

        } else if (success && !runEnhancer) {
            broadcast('System', 'Enhancer skipped (Architect-only mode).', 'info');
        }

        // ── Phase 4: Finalization ─────────────────────────────────────────────

        let persistentApp = null;
        const { openSession: openS, createPersistentApp } = require('./qlik_tools');

        if (success && (runArchitect || runEnhancer)) {
            broadcast('System', '── Phase 4: Finalization ──', 'phase');
            fs.writeFileSync('final_script.qvs', currentScript);
            broadcast('System', 'Final script saved to final_script.qvs', 'success');
            logger.log('System', 'Final Script Saved', { path: 'final_script.qvs' });

            broadcast('System', '── Phase 5: Promoting to Persistent App ──', 'phase');
            if (session) { await closeSession(session); session = null; }

            const conn2 = await openS();
            session = conn2.session;
            const promoGlobal = conn2.global;

            persistentApp = await createPersistentApp(promoGlobal, appName);
            try {
                await persistentApp.createConnection({ qName: 'SourceData', qConnectionString: path.resolve(dataDir), qType: 'folder' });
            } catch (e) {
                if (!e.message?.includes('already exists')) throw e;
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
        }

        // --- PHASE 6: UI LAYOUT GENERATION (AGENT 4) ---
        if (runLayout && success) {
            broadcast('System', '── Phase 6: Layout & Semantic Injection ──', 'phase');

            // If we skipped Phase 4/5 (Layout Only mode), we need to open the existing app
            if (!persistentApp) {
                broadcast('System', `Opening existing app '${appName}'...`, 'info');
                if (session) { await closeSession(session); session = null; }
                const conn3 = await openS();
                session = conn3.session;

                const docList = await conn3.global.getDocList();
                const targetDoc = docList.find(d => d.qDocName === appName || d.qTitle === appName);
                if (!targetDoc) {
                    throw new Error(`Cannot run Layout Agent: App '${appName}' does not exist.`);
                }
                persistentApp = await conn3.global.openDoc(targetDoc.qDocId);
            }

            broadcast('System', 'Synthesizing Dashboard Blueprint (Sub-Agent A & B)...', 'system');
            logger.log('Runner', 'Starting Layout Agent generation sequence.');

            // Simplified summary of model for prompt
            const tableList = await persistentApp.getTablesAndKeys({ qWindowSize: { qcx: 100, qcy: 100 }, qNullSize: { qcx: 0, qcy: 0 }, qCellHeight: 0, qSyntheticMode: false, qIncludeSysVars: false });

            // Format table strings simply for LLM to reason out Facts/Dims
            let modelExcerpt = "TABLES IN APP:\n";
            if (tableList.qtr && tableList.qtr.length > 0) {
                for (const table of tableList.qtr) {
                    const columns = (table.qFields || []).map(f => f.qName).join(', ');
                    modelExcerpt += `- ${table.qName} (Columns: ${columns || 'None'})\n`;
                }
            }

            const blueprint = await generateLayoutPlan(modelExcerpt);

            if (blueprint) {
                broadcast('System', 'Building App Dashboard using JSON Vaccines (Sub-Agent C)...', 'system');
                const layoutSuccess = await composeLayout(persistentApp, blueprint);
                if (layoutSuccess) {
                    await persistentApp.doSave();
                    broadcast('System', 'Executive Dashboard successfully mounted and saved in .qvf.', 'success');
                } else {
                    broadcast('System', 'Layout composition failed.', 'error');
                }
            } else {
                broadcast('System', 'Layout brain failed to synthesize a blueprint.', 'error');
            }
        } else if (!success) {
            broadcast('Architect', '❌ Failed to generate valid script within attempt limit.', 'error');
            logger.error('Architect', 'Failed to generate script after max attempts');
        }

    } catch (err) {
        const errMsg = err.message || JSON.stringify(err);
        broadcast('System', `Fatal Error: ${errMsg}`, 'error');
        logger.error('System', 'Fatal Process Error', err);
    } finally {
        if (session) {
            try { await closeSession(session); } catch (_) { /* ignore */ }
        }
        logger.log('System', 'Process Terminated');
        logger.save();
        broadcast('System', 'Agent process complete. Audit log saved.', 'info');
    }
}

module.exports = { runAgent };
