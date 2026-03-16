/**
 * agent_runner.js
 * Decoupled agent orchestration — callable from the Express API or CLI.
 * Accepts an `io` instance and `broadcastAgentState` for real-time streaming.
 */

const fs = require('fs');
const path = require('path');
const { openSession, openSessionForApp, closeSession, profileData, profileNativeRelationships, validateScript, getEngineMetrics, getLiveMetadata, formatMetadataAsMarkdown, createPersistentApp } = require('./qlik_tools');
const { classifyTablesAndFields } = require('./brain');
const { resolveArchitecture } = require('./deterministic_modeler');
const { generateQvsScript } = require('./architect_generator');
const { generateLayoutPlan } = require('./layout_brain');
const { composeLayout } = require('./layout_composer');

const logger = require('./.agent/utils/logger.js');
const { profileAllData } = require('./architect_profiler');
const { classifyData } = require('./architect_classifier');
const { determineRelationships } = require('./architect_relationship_detector');
const { generateBlueprint, findFactGroups } = require('./architect_structural_tester');
const { collapseFactGroups } = require('./architect_metadata_collapser');
const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
const { generateEnrichmentPlan } = require('./enhancer_brain');
const { composeEnrichment, checkOneToManyViability } = require('./enhancer_composer');

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

/**
 * Executes "Tier 1" deterministic checks to automatically add tools to the plan
 * without calling the LLM.
 */
function runDeterministicChecks(metadata, broadcast) {
    const deterministicPlan = [];
    
    // 1. Check for as_of_table
    let hasDate = false;
    let dateField = 'CanonicalDate';
    let sourceTable = 'MasterCalendar'; // Default fallback
    
    // First pass: look for CanonicalDate (preferred)
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        if (table.fields.some(f => f.name === 'CanonicalDate')) {
            hasDate = true;
            dateField = 'CanonicalDate';
            sourceTable = tableName;
            break;
        }
    }
    
    // Second pass: if no CanonicalDate, find ANY date field
    if (!hasDate) {
        for (const [tableName, table] of Object.entries(metadata.tables)) {
            const dateF = table.fields.find(f => f.tags && (f.tags.includes('$date') || f.tags.includes('$timestamp')));
            if (dateF) {
                hasDate = true;
                dateField = dateF.name;
                sourceTable = tableName;
                break;
            }
        }
    }
    
    if (hasDate) {
        broadcast('Enhancer', `Deterministic Match: Added [as_of_table] for ${dateField} in ${sourceTable}`, 'info');
        deterministicPlan.push({
            tier: 'catalog',
            toolId: 'as_of_table',
            parameters: { 
                dateField,
                sourceTable
            }
        });
    }
    
    // 2. Check for dual_flag_injector
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        for (const field of table.fields) {
            // Exclude % fields (hidden/keys) and SourceTable fields
            if (field.name.startsWith('%') || field.name.includes('SourceTable')) continue;
            
            if (field.distinctCount === 2 && field.sampleValues && field.sampleValues.length === 2) {
                broadcast('Enhancer', `Deterministic Match: Added [dual_flag_injector] for ${tableName}.${field.name}`, 'info');
                // Format mappingPairs as "'Val1','Val2'"
                const mappingPairs = field.sampleValues.map(v => `'${v}'`).join(',');
                deterministicPlan.push({
                    tier: 'catalog',
                    toolId: 'dual_flag_injector',
                    parameters: { 
                        targetTable: tableName, 
                        fieldName: field.name,
                        mappingPairs
                    }
                });
            }
        }
    }
    
    return deterministicPlan;
}

/**
 * Stage A2: Pre-Flight Inspection
 * Scans metadata for patterns like Pareto and Market Basket to provide hints to the LLM.
 */
function runPreFlightInspection(metadata) {
    const hints = [];
    const factTables = [];

    // Identify Facts (tables with measures)
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        if (tableName === 'LinkTable' || tableName === 'MasterCalendar' || tableName === 'CanonicalDateBridge') continue;
        const hasMeasure = table.fields.some(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'));
        if (hasMeasure) factTables.push(tableName);
    }

    // Pareto Hints (Fact + LinkTable + Dimension)
    if (factTables.length > 0 && metadata.tables['LinkTable']) {
        const linkFields = metadata.tables['LinkTable'].fields.map(f => f.name);
        const dimensions = linkFields.filter(f => !f.startsWith('%') && f !== 'OrderID');

        factTables.forEach(fact => {
            const table = metadata.tables[fact];
            const measure = table.fields.find(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'))?.name;
            const key = `%Key_${fact}`;
            
            // Check if key exists in LinkTable
            if (measure && linkFields.includes(key) && dimensions.length > 0) {
                // Find a "good" dimension (not ID, not SourceTable)
                const bestDim = dimensions.find(d => !d.toLowerCase().includes('source') && !d.toLowerCase().includes('id')) || dimensions[0];
                hints.push(`Pareto Candidate: factTable='${fact}', linkTable='LinkTable', keyField='${key}', dimensionField='${bestDim}', measureField='${measure}'`);
            }
        });
    }

    // Market Basket Hints (1-to-many on LinkTable)
    if (metadata.tables['LinkTable']) {
        const fields = metadata.tables['LinkTable'].fields;
        const orderIdField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('order') || n.includes('trans') || n.includes('basket') || n.includes('header');
        })?.name;
        
        const itemField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('product') || n.includes('item') || n.includes('article');
        })?.name;
        
        if (orderIdField && itemField) {
            hints.push(`Market Basket Candidate: factTable='LinkTable', idField='${orderIdField}', itemField='${itemField}'`);
        }
    }

    return hints;
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
    let success = false;
    let currentScript = '';

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

        let workApp;
        if (runArchitect) {
            broadcast('System', 'Creating session app for architecture...', 'info');
            workApp = await qlikGlobal.createSessionApp();
        } else {
            broadcast('System', `Opening persistent app '${appName}' for enrichment...`, 'info');
            const appConn = await openSessionForApp(appName);
            workApp = appConn.appHandle;
        }

        try {
            await workApp.createConnection({
                qName: 'SourceData',
                qConnectionString: path.resolve(dataDir),
                qType: 'folder'
            });
        } catch (e) {
            if (!e.message?.includes('already exists')) throw e;
        }

        // ── Phase 1: Profiling (Deterministic Streaming) ───────────────────
        if (runArchitect) {
            broadcast('Architect', '── Phase 1: Profiling Data (Local Streaming) ──', 'phase');
            logger.log('Architect', 'Starting Deterministic Data Profiling');

            // Cleanup OLD debug files to prevent user confusion
            const oldFiles = fs.readdirSync(process.cwd()).filter(f => f.startsWith('.debug_') || f.endsWith('_script.qvs'));
            oldFiles.forEach(f => { try { fs.unlinkSync(path.join(process.cwd(), f)); } catch (_) { } });

            const { profileAllData } = require('./architect_profiler');
            const { getEngineMetrics } = require('./qlik_tools');

            broadcast('Architect', `Analyzing ${files.length} tables...`, 'info');
            
            // Step 0: Engine Native Profiling (for memory/symbol metrics)
            const engineMetrics = await getEngineMetrics(qlikGlobal, dataDir, files, workApp);

            // Step 1: Profiling
            const profileResult = await profileAllData(dataDir, files, engineMetrics);
            if (profileResult.error) {
                broadcast('Architect', `Failed to profile data: ${profileResult.error}`, 'error');
                throw new Error(profileResult.error);
            }
            
            const metadata = profileResult.metadata;
            const globalFieldValues = profileResult.globalFieldValues;
            broadcast('Architect', `Profiling complete. Found ${metadata.relationships.overlap.length} potential relationships.`, 'success');

            // ── Phase 1 → 2 gate ─────────────────────────────────────────────────
            if (!(await checkControl(ctrl, broadcast))) return;

            // ── Phase 2: Architectural Reasoning (Deterministic) ──────────────────────
            broadcast('Architect', '── Phase 2: Architectural Reasoning (Deterministic) ──', 'phase');

            const { classifyData } = require('./architect_classifier');
            const { determineRelationships } = require('./architect_relationship_detector');
            const { generateBlueprint, findFactGroups } = require('./architect_structural_tester');
            const { generateQvsScript } = require('./architect_generator');

            // Step 1: Classify Tables
            broadcast('Architect', `Step 1: Classifying Tables and Fields...`, 'info');
            const classResult = await classifyData(metadata);
            const classifications = classResult.classifications;
            fs.writeFileSync(path.join(process.cwd(), '.debug_classifications.json'), JSON.stringify(classifications, null, 2));

            // Identify Fact Groups IMMEDIATELY to ensure shared namespace
            const factGroups = findFactGroups(metadata, classifications);
            let processedMetadata = metadata;
            let processedClassifications = classifications;

            if (factGroups.length > 0) {
                broadcast('Architect', `Identified ${factGroups.length} groups of fact tables for concatenation.`, 'info');
                const { collapseFactGroups } = require('./architect_metadata_collapser');
                const result = collapseFactGroups(metadata, classifications, factGroups);
                processedMetadata = result.metadata;
                processedClassifications = result.classifications;
            }

            if (!(await checkControl(ctrl, broadcast))) return;

            // Step 2: Relationship Detection & Normalization
            broadcast('Architect', `Step 2: Normalizing Relationships to prevent Synthetic Keys...`, 'info');
            const relResult = determineRelationships(processedMetadata, processedClassifications, globalFieldValues);
            
            // Memory Cleanup: The field value sets are no longer needed
            if (globalFieldValues) {
                Object.keys(globalFieldValues).forEach(key => delete globalFieldValues[key]);
            }
            const normalizedData = relResult.normalizedData;

            if (!(await checkControl(ctrl, broadcast))) return;

            // Step 3: Structural Strategy & Compilation
            broadcast('Architect', `Step 3: Calculating Best Multi-Fact Strategy...`, 'info');
            let { structuralBlueprint, directives: finalDirectives } = generateBlueprint(normalizedData, factGroups);
            broadcast('Architect', `Selected Base Strategy: ${structuralBlueprint.strategy}`, 'info');

            broadcast('Architect', 'Step 4: Real-time Qlik Engine Structural Validation...', 'info');
            let finalFastScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, true);
            let validation = await validateScript(qlikGlobal, finalFastScript, workApp);

            // Fallback Logic if Synthetic Keys are found
            if (validation.synKeys > 0 && structuralBlueprint.strategy === 'SINGLE_FACT') {
                broadcast('Architect', `⚠️ Qlik Engine detected ${validation.synKeys} Synthetic Keys. Forcing LINK_TABLE strategy...`, 'warning');
                
                structuralBlueprint.strategy = 'LINK_TABLE';
                const sharedKeysSet = new Set();
                const factTables = structuralBlueprint.factTables.map(f => f.tableName);
                const keyPresenceInFacts = {}; 
                
                factTables.forEach(fName => {
                    const tableNorms = normalizedData.find(n => n.tableName === fName);
                    tableNorms.normalizedFields.forEach(nf => {
                        if (nf.type === 'IDENTIFIER') {
                            if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                            keyPresenceInFacts[nf.normalizedName].add(fName);
                        }
                    });
                });

                Object.keys(keyPresenceInFacts).forEach(k => {
                    if (keyPresenceInFacts[k].size > 1) sharedKeysSet.add(k);
                });

                structuralBlueprint.linkTableRequired = true;
                structuralBlueprint.linkTableBlueprint = {
                    linkTableName: 'LinkTable',
                    sharedKeys: Array.from(sharedKeysSet)
                };

                finalFastScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, true);
                validation = await validateScript(qlikGlobal, finalFastScript, workApp);
            }

            fs.writeFileSync(path.join(process.cwd(), '.debug_final_script.qvs'), finalFastScript);

            if (validation.success && (validation.synKeys === 0 || validation.synKeys === undefined)) {
                broadcast('Architect', `✅ Final strategy validated. Model is clean (0 Syn Keys).`, 'success');
                logger.log('Architect', 'Script Verification Passed');
            } else {
                const primaryError = validation.errors[0] || "Unknown Error";
                const details = (validation.errors.length > 1) ? validation.errors[1] : "";
                
                broadcast('Architect', `⚠️ Warning: Qlik Engine Compilation Failed: ${primaryError}`, 'warning');
                
                if (details) {
                    broadcast('System', details, 'warning');
                }

                broadcast('Architect', `Proceeding with app creation despite validation failure to allow manual inspection in Qlik Hub.`, 'info');
                logger.log('Architect', 'Validation Failed - Proceeding anyway', { synKeys: validation.synKeys, errors: validation.errors });
            }

            success = true;
            // Generate the FINAL production script regardless of validation success
            currentScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, false);
            fs.writeFileSync(CACHE_FILE, currentScript);
            if (io) io.emit('script-update', { phase: 'architect', script: currentScript });

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

            const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
            // The original `const { generateEnrichmentPlan } = require('./enhancer_brain');` is moved inside the try block.

            // Stage A: Inspect + Plan
            const stageStart = Date.now();
            try {
                // Clear cache to ensure fixes on disk are picked up if server is long-running
                delete require.cache[require.resolve('./qlik_tools')];
                delete require.cache[require.resolve('./enhancer_brain')];
                
                const { getLiveMetadata, formatMetadataAsMarkdown } = require('./qlik_tools');
                const { generateEnrichmentPlan } = require('./enhancer_brain');
                const { checkOneToManyViability } = require('./enhancer_composer');
                
                const metadata = await getLiveMetadata(workApp);
                const mdMetadata = formatMetadataAsMarkdown(metadata);
                
                const metaSize = JSON.stringify(metadata).length;
                const mdSize = mdMetadata.length;
                console.log(`[PERF] Enhancer Live Metadata size: ${(metaSize / 1024).toFixed(1)} KB (MD Table: ${(mdSize / 1024).toFixed(1)} KB)`);

                // Stage A1: Deterministic "Tier 1" logic
                const deterministicPlan = runDeterministicChecks(metadata, broadcast);

                // Stage A2: Pre-Flight Inspection (Hints)
                const hints = runPreFlightInspection(metadata);
                if (hints.length > 0) {
                    broadcast('Enhancer', `Pre-Flight: Identified ${hints.length} potential patterns. Passing hints to LLM.`, 'info');
                    hints.forEach(h => console.log(`[HINT] ${h}`));
                }

                const planStart = Date.now();
                const llmResult = await generateEnrichmentPlan(mdMetadata, currentScript, hints);
                const planTime = (Date.now() - planStart) / 1000;
                console.log(`[PERF] Enhancer Planning took ${planTime.toFixed(1)}s`);

                // Deduplicate: If deterministic logic already added a tool for a specific target, 
                // ignore the LLM's proposal for that same tool/target combo.
                const llmPlan = (llmResult.plan || []).filter(llmTool => {
                    // Filter out tools with empty parameters immediately to prevent rejection logs
                    if (!llmTool.parameters || Object.keys(llmTool.parameters).length === 0) {
                        console.warn(`[Enhancer] LLM proposed ${llmTool.toolId} with EMPTY parameters. Filtering out.`);
                        return false;
                    }

                    return !deterministicPlan.some(detTool => {
                        if (detTool.toolId !== llmTool.toolId) return false;
                        
                        // Check if parameters match the key target fields
                        if (detTool.toolId === 'as_of_table') return true; // Only ever one as_of per run usually
                        if (detTool.toolId === 'dual_flag_injector') {
                            return detTool.parameters.fieldName === llmTool.parameters.fieldName &&
                                   detTool.parameters.targetTable === llmTool.parameters.targetTable;
                        }
                        return false; 
                    });
                });

                // Merge Plans
                plan = {
                    plan: [...deterministicPlan, ...llmPlan],
                    reasoningSummary: llmResult.reasoningSummary
                };

                broadcast('Enhancer', plan.reasoningSummary || 'Enrichment plan formulated.', 'reasoning');
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
                try {
                    persistentApp = await qlikGlobal.openDoc(appName);
                } catch (e) {
                    // GUI-based resolution if direct fails
                    const { openSessionForApp } = require('./qlik_tools');
                    const connFallback = await openSessionForApp(appName);
                    persistentApp = connFallback.appHandle;
                }
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
