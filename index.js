const fs = require('fs');
const path = require('path');
const { openSession, closeSession, profileData, validateScript, createConnection } = require('./qlik_tools');
const { generateScript } = require('./brain');
const logger = require('./.agent/utils/logger.js'); // Import Logger

const args = process.argv.slice(2);
const jobArg = args.find(a => a.startsWith('--job='));
const dataDirArg = args.find(a => a.startsWith('--data='));
const appNameArg = args.find(a => a.startsWith('--app='));

let dataDir = './data';
let targetAppName = "Architect_Agent_Output";

if (appNameArg) {
    targetAppName = appNameArg.split('=')[1];
}

if (jobArg) {
    const jobPath = jobArg.split('=')[1];
    if (fs.existsSync(jobPath)) {
        console.log(`Loading Job Configuration from ${jobPath}`);
        const jobConfig = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

        if (jobConfig.data && jobConfig.data.sourcePath) {
            dataDir = jobConfig.data.sourcePath;
        }
        if (jobConfig.output && jobConfig.output.appName) {
            targetAppName = jobConfig.output.appName;
        }
    } else {
        console.error(`Error: Job config file ${jobPath} not found.`);
        process.exit(1);
    }
} else if (dataDirArg) {
    dataDir = dataDirArg.split('=')[1];
}

async function main() {
    logger.initialize();
    logger.log('System', 'Job Started', { dataDir, targetAppName });

    console.log("=== Qlik Architect Agent Started ===");
    console.log(`Target Data Directory: ${dataDir}`);
    console.log(`Target App Name: ${targetAppName}`);

    if (!fs.existsSync(dataDir)) {
        logger.error('System', `Directory ${dataDir} does not exist.`);
        console.error(`Error: Directory ${dataDir} does not exist.`);
        process.exit(1);
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.txt'));
    if (files.length === 0) {
        logger.error('System', `No CSV/TXT files found in ${dataDir}.`);
        console.error(`Error: No CSV/TXT files found in ${dataDir}.`);
        process.exit(1);
    }

    let session;
    let global;

    try {
        console.log("Connecting to Qlik Engine...");
        const connection = await openSession();
        session = connection.session;
        global = connection.global;
        console.log("Connected.");
        logger.log('System', 'Connected to Qlik Engine');

        // Create a single session app for profiling to avoid "App already open" issues
        // or effectively reuse the context.
        const workApp = await global.createSessionApp();

        // Create the shared connection (we ensure it exists once for the directory)
        const { createConnection } = require('./qlik_tools');
        await workApp.createConnection({
            qName: 'SourceData',
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });
        console.log(`Created connection 'SourceData' pointing to ${path.resolve(dataDir)}`);

        // --- CACHE BYPASS LOGIC ---
        const skipArchitectArg = args.find(a => a === '--skip-architect');
        const CACHE_FILE = '.cache_base_script.qvs';

        // We need a persistent session reference for the Enhancer
        let enhancerGlobal = global;
        let enhancerApp = workApp;

        if (skipArchitectArg && fs.existsSync(CACHE_FILE)) {
            console.log("=== BYPASSING ARCHITECT ===");
            console.log(`Loading cached base script from ${CACHE_FILE}...`);
            logger.log('System', 'Bypassed Architect Phase using cached script.');
            currentScript = fs.readFileSync(CACHE_FILE, 'utf8');

            // We must actually execute this script so the Enhancer can inspect the metadata
            console.log("Executing Cached Script to populate Engine Metadata...");
            await workApp.setScript(currentScript);
            await workApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

            success = true; // Pretend phase 2 succeeded

            // Re-bind the initial session for the Enhancer since we didn't run the pipeline
            enhancerGlobal = global;
            enhancerApp = workApp;
        } else {
            // --- CLOSE INIT SESSION TO PREVENT CONFLICTS ---
            // We only do this if running the full pipeline, because pipeline_runner creates its own session.
            if (session) {
                console.log("Closing init session to free resources for the Pipeline Runner...");
                await closeSession(session);
                session = null;
            }

            // --- V2 ARCHITECT PIPELINE ---
            console.log("\n--- Phase 1 & 2: V2 Data Architect Pipeline ---");
            const { runPipeline } = require('./pipeline_runner');

            // Execute the pipeline which orchestrates Steps 0 -> 8
            const pipelineResult = await runPipeline(path.resolve(dataDir));

            if (pipelineResult.success) {
                success = true;
                currentScript = pipelineResult.finalScript;

                // Cache the successful base script
                fs.writeFileSync(CACHE_FILE, currentScript);
                console.log(`Saved base script to cache: ${CACHE_FILE}`);
            } else {
                console.error("Pipeline Validation Failed:", pipelineResult.error || "Unknown Error");
            }
        } // End Cache Bypass block

        if (success) {
            // --- PHASE 3: ENHANCER AGENT (Tool-Aware Hybrid Model) ---
            console.log("\n--- Phase 3: Enhancer Agent (Hybrid Reasoning) ---");
            logger.log('Enhancer', 'Starting Enrichment Phase (Hybrid)');
            try {
                // 1. Inspect Metadata
                const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
                const metadata = await inspector.inspectMetadata(workApp);

                // 2. Brain Reasoning (LLM)
                const { generateEnrichmentPlan } = require('./enhancer_brain');
                const plan = await generateEnrichmentPlan(metadata, currentScript);
                console.log("\n[Enhancer AI Reasoning]:", plan.reasoningSummary, "\n");

                // 3. Composer Execution (Deterministic + Validation Sandbox)
                const { composeEnrichment } = require('./enhancer_composer');
                const { enrichedScript, report } = await composeEnrichment(plan, currentScript, global, workApp);

                // Print Enhancement Report
                console.log("\n=== Enhancement Report ===");
                report.forEach(r => {
                    const icon = r.status === 'Applied' ? '✅' : '❌';
                    console.log(`${icon} [${r.tier.toUpperCase()}] ${r.tool}: ${r.status}`);
                    if (r.status !== 'Applied') {
                        console.log(`   └─ Reason: ${r.reason}`);
                    }
                });
                console.log("==========================\n");

                // Save report to audit log metadata
                logger.enhancement('Enhancement Report', report);

                console.log("Composer finished. Validating final Hybrid Script...");
                const enhancedValidation = await validateScript(global, enrichedScript, workApp);

                if (enhancedValidation.success && enhancedValidation.synKeys === 0) {
                    console.log("Enriched Hybrid Script Validated Successfully!");
                    logger.enhancement('Validation Success', 'Hybrid script passed checks.');
                    currentScript = enrichedScript; // Promote enriched script to final
                } else {
                    // Because composeEnrichment is now isolated and self-healing, the final script 
                    // should theoretically ALWAYS pass. If it doesn't, we have a critical Sandbox failure.
                    console.error("CRITICAL: Enhancer produced invalid final script despite isolated validation.");
                    console.error(`Errors: ${enhancedValidation.errors.join(', ')}`);

                    logger.error('Enhancer', 'Final Enhancement Failed Validation', {
                        errors: enhancedValidation.errors
                    });

                    fs.writeFileSync('debug_enhanced_script.qvs', enrichedScript);
                    console.error("Dumped invalid script to debug_enhanced_script.qvs");

                    console.warn("WARNING: Reverting to Base Architect Script.");
                    logger.log('System', 'Fallback: Reverted to Base Architect Script');
                }
            } catch (enhancerErr) {
                console.error("Critical Error in Enhancer Agent:", enhancerErr);
                logger.error('Enhancer', 'Critical Runtime Error', enhancerErr);
                console.warn("WARNING: Reverting to Base Script due to Enhancer Crash.");
            }
        }

        // 4. Finalization
        console.log("\n--- Phase 4: Finalization ---");
        if (success) {
            const outputPath = 'final_script.qvs';
            fs.writeFileSync(outputPath, currentScript);
            console.log(`Success! Optimized Load Script saved to ${outputPath}`);
            logger.log('System', 'Final Script Saved', { path: outputPath });

            // --- PROMOTION PHASE ---
            try {
                console.log("\n--- Phase 5: Promoting to Persistent App ---");

                // Close the profiling/validation session first to avoid "App already open" conflicts
                if (session) {
                    console.log("Closing validation session...");
                    await closeSession(session);
                    session = null; // Prevent double close in finally block
                }

                // Open a NEW session for the persistent app
                console.log("Opening new session for promotion...");
                const { openSession, createPersistentApp, createConnection, closeSession: closeSessionTools } = require('./qlik_tools');
                const connection = await openSession();
                const promoSession = connection.session;
                const promoGlobal = connection.global;

                // Update the main session variable so finally block can close it if error
                session = promoSession;

                const appName = targetAppName;

                // 1. Create/Open real app
                const persistentApp = await createPersistentApp(promoGlobal, appName);

                // 2. Create Connection
                console.log("Creating 'SourceData' connection in persistent app...");
                try {
                    await persistentApp.createConnection({
                        qName: 'SourceData',
                        qConnectionString: path.resolve(dataDir),
                        qType: 'folder'
                    });
                } catch (connErr) {
                    if (connErr.message.includes('already exists')) {
                        console.log("Connection 'SourceData' already exists. Using existing.");
                    } else {
                        throw connErr;
                    }
                }

                // 3. Set Script
                console.log("Setting script...");
                await persistentApp.setScript(currentScript);

                // 4. Reload
                console.log("Reloading data...");
                const reloadResult = await persistentApp.doReload();
                console.log(`Reload Success: ${reloadResult}`);
                logger.log('System', 'App Reload Finished', { success: reloadResult });

                if (!reloadResult) {
                    console.warn("Warning: Reload failed. Check Qlik logs or script logic.");
                    logger.error('System', 'Reload Failed in Final App');
                }

                // 5. Save
                console.log("Saving app...");
                await persistentApp.doSave();
                console.log(`App '${appName}' saved successfully.`);
                logger.log('System', 'App Saved', { appName });

            } catch (promoErr) {
                console.error("Error during promotion phase:", promoErr.message);
                logger.error('System', 'Promotion Phase Error', promoErr);
            }

        } else {
            console.error("Failed to generate a valid script within the attempt limit.");
            logger.error('Architect', 'Failed to generate script after max attempts');
            if (currentScript) {
                fs.writeFileSync('failed_script.qvs', currentScript);
                console.log("Saved last attempt to failed_script.qvs");
            }
        }

    } catch (err) {
        console.error("Fatal Error:", err);
        logger.error('System', 'Fatal Process Error', err);
    } finally {
        if (session) {
            try {
                await closeSession(session);
            } catch (e) { console.error("Error closing session:", e); }
        }
        logger.log('System', 'Process Terminated');
        logger.save(); // SAVE THE AUDIT LOG
        console.log("=== Agent Terminated ===");
    }
}

main();
