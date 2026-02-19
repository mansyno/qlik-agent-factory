const fs = require('fs');
const path = require('path');
const { openSession, closeSession, profileData, validateScript, createConnection } = require('./qlik_tools');
const { generateScript } = require('./brain');

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
    console.log("=== Qlik Architect Agent Started ===");
    console.log(`Target Data Directory: ${dataDir}`);
    console.log(`Target App Name: ${targetAppName}`);

    if (!fs.existsSync(dataDir)) {
        console.error(`Error: Directory ${dataDir} does not exist.`);
        process.exit(1);
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.txt'));
    if (files.length === 0) {
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

        // Create a single session app for profiling to avoid "App already open" issues
        // or effectively reuse the context.
        const workApp = await global.createSessionApp();

        // Create the shared connection
        const { createConnection } = require('./qlik_tools'); // Re-import to get new function? 
        // actually require is cached, but since I edited the file on disk, Node might not reload it if I was in a long running process. 
        // But here I am restarting the process every time.

        await workApp.createConnection({
            qName: 'SourceData',
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });
        console.log(`Created connection 'SourceData' pointing to ${path.resolve(dataDir)}`);

        // 1. Profiling
        console.log("\n--- Phase 1: Profiling Data ---");
        const profiles = {};
        for (const file of files) {
            const filePath = path.resolve(dataDir, file);
            console.log(`Profiling ${file}...`);
            // Pass workApp to profileData
            const profile = await profileData(global, filePath, workApp);
            if (profile.error) {
                console.error(`Failed to profile ${file}: ${profile.error}`);
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
                success = true;
            } else {
                console.warn("Validation Failed or Synthetic Keys found.");
                console.warn(`Success: ${validation.success}, SynKeys: ${validation.synKeys}`);
                if (validation.errors.length > 0) console.warn(`Errors: ${validation.errors.join(', ')}`);

                feedback = validation;
            }


        }

        // 3. Finalization
        console.log("\n--- Phase 3: Finalization ---");
        if (success) {
            const outputPath = 'final_script.qvs';
            fs.writeFileSync(outputPath, currentScript);
            console.log(`Success! Optimized Load Script saved to ${outputPath}`);

            // --- PROMOTION PHASE ---
            try {
                console.log("\n--- Phase 4: Promoting to Persistent App ---");

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
                await persistentApp.createConnection({
                    qName: 'SourceData',
                    qConnectionString: path.resolve(dataDir),
                    qType: 'folder'
                });

                // 3. Set Script
                console.log("Setting script...");
                await persistentApp.setScript(currentScript);

                // 4. Reload
                console.log("Reloading data...");
                const reloadResult = await persistentApp.doReload();
                console.log(`Reload Success: ${reloadResult}`);

                if (!reloadResult) {
                    console.warn("Warning: Reload failed. Check Qlik logs or script logic.");
                }

                // 5. Save
                console.log("Saving app...");
                await persistentApp.doSave();
                console.log(`App '${appName}' saved successfully.`);

            } catch (promoErr) {
                console.error("Error during promotion phase:", promoErr.message);
            }

        } else {
            console.error("Failed to generate a valid script within the attempt limit.");
            if (currentScript) {
                fs.writeFileSync('failed_script.qvs', currentScript);
                console.log("Saved last attempt to failed_script.qvs");
            }
        }

    } catch (err) {
        console.error("Fatal Error:", err);
    } finally {
        if (session) {
            try {
                await closeSession(session);
            } catch (e) { console.error("Error closing session:", e); }
        }
        console.log("=== Agent Terminated ===");
    }
}

main();
