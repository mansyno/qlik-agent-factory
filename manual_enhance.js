const fs = require('fs');
const path = require('path');
const { openSession, closeSession } = require('./qlik_tools');
const { enhanceScript } = require('./enhancer');
const logger = require('./.agent/utils/logger.js');

async function main() {
    logger.initialize();
    console.log("=== Manual Enhancer Verification ===");

    // 1. Read the input script
    const scriptPath = 'test_base_script.qvs';
    if (!fs.existsSync(scriptPath)) {
        console.error(`Error: ${scriptPath} not found.`);
        process.exit(1);
    }
    const inputScript = fs.readFileSync(scriptPath, 'utf8');
    console.log(`Loaded script from ${scriptPath}`);

    let session;
    try {
        const connection = await openSession();
        session = connection.session;
        const global = connection.global;
        const app = await global.createSessionApp();

        // 2. Setup Data Connection
        const dataDir = path.resolve('./data');
        await app.createConnection({
            qName: 'SourceData',
            qConnectionString: dataDir,
            qType: 'folder'
        });

        // 3. Load Base Script
        console.log("Loading base script...");
        await app.setScript(inputScript);
        const reloadResult = await app.doReload();

        if (!reloadResult) {
            console.error("Base script reload failed!");
        } else {
            console.log("Base script reloaded successfully.");
        }

        // 4. Run Enhancer
        console.log("Running Enhancer...");
        const enrichedScript = await enhanceScript(app, inputScript);

        // 5. Validate Output
        const { validateScript } = require('./qlik_tools');
        const validation = await validateScript(global, enrichedScript, app);

        if (validation.success) {
            console.log("SUCCESS: Enriched script is valid!");
            fs.writeFileSync('manual_enriched_script.qvs', enrichedScript);
            console.log("Saved to manual_enriched_script.qvs");
        } else {
            console.error("FAILURE: Enriched script is Invalid.");
            console.error(validation.errors);
            fs.writeFileSync('manual_enriched_script_failed.qvs', enrichedScript);
        }

    } catch (err) {
        console.error("Error:", err);
    } finally {
        if (session) await closeSession(session);
        logger.save();
    }
}

main();
