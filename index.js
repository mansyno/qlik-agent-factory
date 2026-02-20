const fs = require('fs');
const path = require('path');
const { openSession, closeSession, profileData, validateScript, createConnection } = require('./qlik_tools');
const { generateScript } = require('./brain');
const logger = require('./.agent/utils/logger.js'); // Import Logger

const args = process.argv.slice(2);
const jobArg = args.find(a => a.startsWith('--job='));
const dataDirArg = args.find(a => a.startsWith('--data='));

let dataDir = './data';
let targetAppName = "Architect_Agent_Output";

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

        // Create the shared connection
        const { createConnection } = require('./qlik_tools');

        await workApp.createConnection({
            qName: 'SourceData',
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });
        console.log(`Created connection 'SourceData' pointing to ${path.resolve(dataDir)}`);

        // 1. Profiling
        console.log("\n--- Phase 1: Profiling Data ---");
        logger.log('Architect', 'Starting Data Profiling');
        const profiles = {};
        for (const file of files) {
            const filePath = path.resolve(dataDir, file);
            console.log(`Profiling ${file}...`);
            // Pass workApp to profileData
            const profile = await profileData(global, filePath, workApp);
            if (profile.error) {
                console.error(`Failed to profile ${file}: ${profile.error}`);
                logger.error('Architect', `Profiling failed for ${file}`, profile.error);
            } else {
                profiles[file] = profile;
            }
        }

        if (Object.keys(profiles).length === 0) {
            console.error("No data could be profiled. Exiting.");
            process.exit(1);
        }

        // 2. Inference Loop
        console.log("\n--- Phase 2: Architectural Reasoning ---");
        let currentScript = "";
        let attempt = 0;
        let maxAttempts = 3;
        let success = false;
        let feedback = null;

        while (attempt < maxAttempts && !success) {
            attempt++;
            console.log(`\nAttempt ${attempt}/${maxAttempts}: Generating Script...`);
            logger.log('Architect', `Generating Script Attempt ${attempt}`);

            // Start heartbeat to keep Qlik connection alive during AI generation
            const heartbeat = setInterval(async () => {
                try {
                    await global.engineVersion();
                } catch (e) { /* ignore */ }
            }, 5000);

            try {
                currentScript = await generateScript({
                    profiles,
                    feedback,
                    previousScript: currentScript // Pass previous script for context if retrying
                });
            } catch (err) {
                console.error("Error during inference loop:", err.message);
                logger.error('Architect', 'AI Inference Error', err);

                // Check for Rate Limit (429)
                if (err.message.includes('429') || err.message.includes('Quota exceeded')) {
                    console.log("Rate limit hit. Waiting 60 seconds before retrying...");
                    await new Promise(resolve => setTimeout(resolve, 60000));
                }

                clearInterval(heartbeat);
                continue; // Retry loop
            } finally {
                clearInterval(heartbeat);
            }

            console.log("Generated Script Preview:");
            console.log(currentScript.substring(0, 200) + "...\n");

            console.log("Validating Script...");
            const validation = await validateScript(global, currentScript, workApp);

            if (validation.success && validation.synKeys === 0) {
                console.log("Validation Successful! No Syntax Errors, No Synthetic Keys.");
                logger.log('Architect', 'Script Verification Passed', { attempt });

                // --- PHASE 3: ENHANCER AGENT (Agent 3) ---
                console.log("\n--- Phase 3: Enhancer Agent (Script Enrichment) ---");
                logger.log('Enhancer', 'Starting Enrichment Phase');
                try {
                    const { enhanceScript } = require('./enhancer');
                    const enrichedScript = await enhanceScript(workApp, currentScript);

                    console.log("Enhancer finished. Validating Enriched Script...");
                    const enhancedValidation = await validateScript(global, enrichedScript, workApp);

                    if (enhancedValidation.success) {
                        console.log("Enriched Script Validated Successfully!");
                        logger.enhancement('Validation Success', 'Enriched script passed checks.');
                        currentScript = enrichedScript; // Promote enriched script to final
                        success = true;
                    } else {
                        console.error("Enhancer produced invalid script.");
                        console.error(`Errors: ${enhancedValidation.errors.join(', ')}`);

                        logger.error('Enhancer', 'Enhancement Failed Validation', {
                            errors: enhancedValidation.errors
                        });

                        fs.writeFileSync('debug_enhanced_script.qvs', enrichedScript);
                        console.error("Dumped invalid script to debug_enhanced_script.qvs");

                        // CONFLICT RESOLUTION: WARN USER explicitly via Log and Console.
                        console.warn("WARNING: Reverting to Base Script due to Enhancer errors.");
                        logger.log('System', 'Fallback: Reverted to Base Architect Script');

                        // We proceed with the Base Script to ensure delivery, but flagged as warning.
                        success = true;
                    }
                } catch (enhancerErr) {
                    console.error("Critical Error in Enhancer Agent:", enhancerErr);
                    logger.error('Enhancer', 'Critical Runtime Error', enhancerErr);
                    // Fallback to base script
                    console.warn("WARNING: Reverting to Base Script due to Enhancer Crash.");
                    success = true;
                }
            } else {
                console.warn("Validation Failed or Synthetic Keys found.");
                console.warn(`Success: ${validation.success}, SynKeys: ${validation.synKeys}`);
                if (validation.errors.length > 0) console.warn(`Errors: ${validation.errors.join(', ')}`);

                logger.log('Architect', 'Validation Failed', {
                    synKeys: validation.synKeys,
                    errors: validation.errors
                });

                feedback = validation;
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
