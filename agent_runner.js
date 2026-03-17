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
            // Exclude % fields (hidden/keys)
            if (field.name.startsWith('%')) continue;

            // Exclude fields that are JUST metadata like 'SourceTable_XXXX' unless they are actual flags
            if (field.name.includes('SourceTable') && !field.name.toLowerCase().includes('flag')) continue;

            // Exclude numeric/measure fields — dual flags are for text/categorical fields only
            const isNumeric = field.tags && (field.tags.includes('$numeric') || field.tags.includes('$integer'));
            if (isNumeric) continue;
            
            const isCalendar = /^(Year|Month|Quarter|Week|Day|WeekDay|MonthYear|Date_Diff|Month_Diff|Year_Diff|Date|Time|Timestamp)$/i.test(field.name) || (field.tags && (field.tags.includes('$date') || field.tags.includes('$timestamp')));
            if (isCalendar) continue;

            const isKnownFlagName = /flag|status|yes|no|active|valid|binary|imported|return/i.test(field.name);
            const hasTwoValues = field.distinctCount === 2 && field.sampleValues && field.sampleValues.length === 2;
            
            if (hasTwoValues) {
                const valStr = field.sampleValues.map(v => String(v).toLowerCase());
                const isFlagContent = valStr.some(v => 
                    ['yes', 'no', 'y', 'n', '1', '0', 'true', 'false', 'active', 'inactive'].includes(v)
                );

                // HIGH CONFIDENCE -> Deterministic Plan
                if (isKnownFlagName || isFlagContent) {
                    broadcast('Enhancer', `Deterministic Match: Added [dual_flag_injector] for ${tableName}.${field.name}`, 'info');
                    const mappingPairs = field.sampleValues.map(v => `'${v}'`).join(', ');
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
    const linkTable = metadata.tables['LinkTable'] || metadata.tables['Link Table'];

    // Identify Facts and Potential Flags
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        if (tableName === 'LinkTable' || tableName === 'MasterCalendar' || tableName === 'CanonicalDateBridge') continue;
        
        const hasMeasure = table.fields.some(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'));
        if (hasMeasure) factTables.push(tableName);

        // Ambiguous 2-value fields -> Hint for LLM to decide
        table.fields.forEach(field => {
            if (field.name.startsWith('%')) return;
            // Exclude numeric fields — dual flags only apply to text/categorical fields
            const isNumeric = field.tags && (field.tags.includes('$numeric') || field.tags.includes('$integer'));
            if (isNumeric) return;
            const isCalendar = /^(Year|Month|Quarter|Week|Day|WeekDay|MonthYear|Date_Diff|Month_Diff|Year_Diff|Date|Time|Timestamp)$/i.test(field.name) || (field.tags && (field.tags.includes('$date') || field.tags.includes('$timestamp')));
            if (isCalendar) return;

            if (field.distinctCount === 2 && field.sampleValues && field.sampleValues.length === 2) {
                const isKnownFlagName = /flag|status|yes|no|active|valid|binary|imported|return/i.test(field.name);
                const valStr = field.sampleValues.map(v => String(v).toLowerCase());
                const isFlagContent = valStr.some(v => ['yes', 'no', 'y', 'n', '1', '0', 'true', 'false'].includes(v));

                // If NOT high confidence (deterministic), pass as a hint for LLM evaluation
                if (!isKnownFlagName && !isFlagContent) {
                    const values = field.sampleValues.join(', ');
                    hints.push(`Dual Injection Candidate: table='${tableName}', field='${field.name}', values='${values}' (LLM: evaluate if this should be a toggleable dual flag)`);
                }
            }
        });
    }

    // Pareto Hints (Fact + LinkTable/Direct + Dimension)
    if (factTables.length > 0) {
        factTables.forEach(fact => {
            const table = metadata.tables[fact];
            const measure = table.fields.find(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'))?.name;
            const key = `%Key_${fact}`;
            
            // If LinkTable exists, use it
            if (linkTable) {
                const linkFields = linkTable.fields.map(f => f.name);
                const dimensions = linkFields.filter(f => !f.startsWith('%') && f !== 'OrderID');
                if (measure && linkFields.includes(key) && dimensions.length > 0) {
                    const bestDim = dimensions.find(d => !d.toLowerCase().includes('source') && !d.toLowerCase().includes('id')) || dimensions[0];
                    hints.push(`Pareto Candidate: factTable='${fact}', linkTable='${linkTable.tableName || 'LinkTable'}', keyField='${key}', dimensionField='${bestDim}', measureField='${measure}'`);
                }
            } else {
                // Star Schema: Dimensions might be directly in the fact table or separate tables
                // For now, look for high-cardinality attributes in the fact table itself as Pareto candidates
                const dimensions = table.fields.filter(f => f.type === 'ATTRIBUTE' && f.distinctCount > 10 && !f.name.toLowerCase().includes('date') && !f.name.toLowerCase().includes('id'));
                if (measure && dimensions.length > 0) {
                    hints.push(`Pareto Candidate: factTable='${fact}', dimensionField='${dimensions[0].name}', measureField='${measure}' (Self-contained Pareto)`);
                }
            }
        });
    }

    // Market Basket Hints (1-to-many on LinkTable or Fact)
    const basketTarget = linkTable || metadata.tables[factTables[0]];
    if (basketTarget) {
        const fields = basketTarget.fields;
        const orderIdField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('order') || n.includes('trans') || n.includes('basket') || n.includes('header');
        })?.name;
        
        const itemField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('product') || n.includes('item') || n.includes('article');
        })?.name;
        
        if (orderIdField && itemField) {
            hints.push(`Market Basket Candidate: factTable='${basketTarget.tableName || 'LinkTable'}', idField='${orderIdField}', itemField='${itemField}'`);
        }
    }

    return hints;
}

// ── Main Agent Runner ─────────────────────────────────────────────────────────
async function runAgent({ dataDir, appName, pipeline = ['architect', 'enhancer'], io, broadcastAgentState, agentControl }) {
    const broadcast = (typeof broadcastAgentState === 'function')
        ? broadcastAgentState
        : (agent, msg, type) => logger.log(type?.toUpperCase() || 'INFO', msg, null, agent);
    const ctrl = agentControl || null;

    logger.initialize();
    logger.info('System', 'Job Started', { dataDir, targetAppName: appName });
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
        session = connection.session; // EXPLICIT ASSIGNMENT
        qlikGlobal = connection.global;
        broadcast('System', 'Connected to Qlik Engine.', 'success');
        logger.info('System', 'Connected to Qlik Engine');

        let workApp;
        if (runArchitect) {
            broadcast('System', 'Creating session app for architecture...', 'info');
            workApp = await qlikGlobal.createSessionApp();
        } else {
            broadcast('System', `Opening persistent app '${appName}' for enrichment...`, 'info');
            try {
                workApp = await qlikGlobal.openDoc(appName);
            } catch (e) {
                // FALLBACK: Name resolution bridge
                const appConn = await openSessionForApp(appName);
                // CRITICAL: Close and replace the old session to avoid a "dangling" main session
                if (session) { try { await session.close(); } catch (_) { } }
                session = appConn.session;
                qlikGlobal = appConn.global;
                workApp = appConn.appHandle;
            }
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
            logger.info('Architect', 'Starting Deterministic Data Profiling');

            // Cleanup OLD debug files to prevent user confusion
            const oldFiles = fs.readdirSync(process.cwd()).filter(f => f.startsWith('.debug_') || f.endsWith('_script.qvs'));
            oldFiles.forEach(f => { try { fs.unlinkSync(path.join(process.cwd(), f)); } catch (_) { } });

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
                logger.warn('Architect', 'Validation Failed - Proceeding anyway', { synKeys: validation.synKeys, errors: validation.errors });
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
            logger.info('Enhancer', 'Starting Enrichment Phase (Hybrid)');

            let fastBaseScript = currentScript;
            let plan = null;
            let enrichedScript = null;
            let report = null;
            let metadata = null; // hoisted so Stage B can use it for reference validation

            // Stage A: Inspect + Plan
            const stageStart = Date.now();
            try {
                // Reload workApp with the FULL production script so cardinality counts are real.
                // The previous state of workApp is from the FIRST 1 validation run — wrong data for inspection.
                broadcast('Enhancer', 'Loading full dataset for metadata inspection...', 'info');
                await workApp.setScript(currentScript);
                await workApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

                // Ensure Enhancer validation loops use a FAST (FIRST 1) baseline for speed
                if (!currentScript.includes('FIRST 1')) {
                    fastBaseScript = currentScript.replace(/LOAD/g, 'FIRST 1\nLOAD');
                }

                metadata = await getLiveMetadata(workApp);
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
                    hints.forEach(h => logger.debug('Enhancer', `PRE-FLIGHT HINT: ${h}`));
                }

                const planStart = Date.now();
                const llmResult = await generateEnrichmentPlan(mdMetadata, currentScript, hints);
                const planTime = (Date.now() - planStart) / 1000;
                logger.debug('Enhancer', `Planning took ${planTime.toFixed(1)}s`);

                // Deduplicate: If deterministic logic already added a tool for a specific target, 
                // ignore the LLM's proposal for that same tool/target combo.
                const llmPlan = (llmResult.plan || []).filter(llmTool => {
                    // Filter out tools with empty parameters immediately to prevent rejection logs
                    if (!llmTool.parameters || Object.keys(llmTool.parameters).length === 0) {
                        logger.warn('Enhancer', `LLM proposed ${llmTool.toolId} with EMPTY parameters. Filtering out.`);
                        return false;
                    }

                    // Sanitize mappingPairs if present (LLM often misses quotes or uses semicolons)
                    if (llmTool.toolId === 'dual_flag_injector' && llmTool.parameters.mappingPairs) {
                        let mp = String(llmTool.parameters.mappingPairs);
                        // If it doesn't look like it has quotes, try to wrap the labels
                        if (!mp.includes("'")) {
                            // Replace semicolon with comma, then split by comma and try to quote strings
                            mp = mp.replace(/;/g, ',');
                            const parts = mp.split(',').map(p => {
                                p = p.trim();
                                return (isNaN(p) && !p.startsWith("'")) ? `'${p}'` : p;
                            });
                            llmTool.parameters.mappingPairs = parts.join(', ');
                            logger.debug('Enhancer', `Sanitized mappingPairs for ${llmTool.parameters.fieldName}`);
                        }
                    }

                    return !deterministicPlan.some(detTool => {
                        if (detTool.toolId !== llmTool.toolId) return false;
                        
                        // Check if parameters match the key target fields
                        if (detTool.toolId === 'as_of_table') {
                            // For as_of_table, we consider it a duplicate if the target table is the same
                            // or if the LLM proposes an as_of for a LinkTable when one is already deterministically planned.
                            const detTarget = detTool.parameters.targetTable;
                            const llmTarget = llmTool.parameters.targetTable;
                            if (detTarget === llmTarget) return true;
                            // If deterministic plan has an as_of for 'LinkTable' and LLM also proposes one, it's a duplicate.
                            if (detTarget === 'LinkTable' && llmTarget === 'LinkTable') return true;
                            return false;
                        }
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
                logger.error('Enhancer', `Plan generation failed [${planErr.constructor?.name}]: ${planErr.message}`, planErr);
                broadcast('Enhancer', `Plan generation failed [${planErr.constructor?.name}]: ${planErr.message}`, 'error');
                plan = null;
            }

            // Stage B: Compose enrichments
            if (plan) {
                try {
                    const composerResult = await composeEnrichment(plan, fastBaseScript, qlikGlobal, workApp, metadata);
                    enrichedScript = currentScript + composerResult.appliedEnrichments;
                    report = composerResult.report;

                    report.forEach(r => {
                        const ok = r.status.startsWith('Applied');
                        const icon = ok ? '✅' : '❌';
                        const reason = !ok && r.reason ? ` — ${r.reason}` : '';
                        broadcast('Enhancer', `${icon} [${r.tier.toUpperCase()}] ${r.tool}: ${r.status}${reason}`, ok ? 'success' : 'warning');
                    });
                    logger.enhancement('Enhancement Report', report);
                } catch (composeErr) {
                    logger.error('Enhancer', `Compose failed [${composeErr.constructor?.name}]: ${composeErr.message}`, composeErr);
                    broadcast('Enhancer', `Compose failed [${composeErr.constructor?.name}]: ${composeErr.message}`, 'error');
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
                    logger.error('Enhancer', `Final validation failed [${valErr.constructor?.name}]: ${valErr.message}`, valErr);
                    broadcast('Enhancer', `Final validation failed [${valErr.constructor?.name}]: ${valErr.message}`, 'error');
                }
            }

        } else if (success && !runEnhancer) {
            broadcast('System', 'Enhancer skipped (Architect-only mode).', 'info');
        }

        // ── Phase 4: Finalization ─────────────────────────────────────────────
        let persistentApp = null;

        if (success && (runArchitect || runEnhancer)) {
            broadcast('System', '── Phase 4: Finalization ──', 'phase');
            fs.writeFileSync('final_script.qvs', currentScript);
            broadcast('System', 'Final script saved to final_script.qvs', 'success');
            logger.info('System', 'Final Script Saved', { path: 'final_script.qvs' });

            broadcast('System', '── Phase 5: Promoting to Persistent App ──', 'phase');
            // IMPORTANT: Qlik Desktop only allows ONE active document per session.
            // The session app from Phase 1 is still open. We MUST close this session
            // and open a fresh one before we can create/open a persistent app.
            await closeSession(session);
            session = null;
            const promoConn = await openSession();
            session = promoConn.session;
            const promoGlobal = promoConn.global;

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
            logger.info('System', 'App Reload Finished', { success: reloadOk });

            await persistentApp.doSave();
            broadcast('System', `App '${appName}' saved successfully.`, 'success');
            logger.info('System', 'App Saved', { appName });
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
                    // GUI-based resolution if direct fails - but capture the NEW session
                    const connFallback = await openSessionForApp(appName);
                    if (session) await closeSession(session);
                    session = connFallback.session;
                    qlikGlobal = connFallback.global;
                    persistentApp = connFallback.appHandle;
                }
            }

            broadcast('System', 'Synthesizing Dashboard Blueprint (Sub-Agent A & B)...', 'system');
            logger.info('Runner', 'Starting Layout Agent generation sequence.');

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
        logger.info('System', 'Process Terminated');
        logger.save();
        broadcast('System', 'Agent process complete. Audit log saved.', 'info');
    }
}

module.exports = { runAgent };
