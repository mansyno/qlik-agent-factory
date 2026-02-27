const fs = require('fs');
const path = require('path');
const { generateQvsScript } = require('./architect_generator');
const { openSession, validateScript, closeSession } = require('./qlik_tools');

async function testStep8() {
    console.log("=== Testing Step 8: Absolute Compilation Validation ===");

    const dirFile = path.resolve(__dirname, 'test_directives_output.json');
    const normFile = path.resolve(__dirname, 'test_normalization_output.json');

    if (!fs.existsSync(dirFile) || !fs.existsSync(normFile)) {
        console.error(`Missing prerequisite data. Please run test_step4_7.js first.`);
        process.exit(1);
    }

    const directives = JSON.parse(fs.readFileSync(dirFile, 'utf8'));
    const normalizedData = JSON.parse(fs.readFileSync(normFile, 'utf8'));

    // 1. Generate the Script locally using deterministic Node.js string building
    console.log("Generating QVS code from JSON directives...");
    const sourcePath = 'd:\\A_i\\qlik\\poc architect agent\\northwind';
    const finalScript = generateQvsScript(directives, normalizedData, sourcePath);

    fs.writeFileSync('test_final_script.qvs', finalScript);
    console.log("Script mapped. Expected lines:", finalScript.split('\\n').length);
    console.log("Saved script to test_final_script.qvs");

    // 2. Validate with Qlik Engine
    console.log("\\n--- Initializing Engine Validation ---");
    let sessionData = null;
    try {
        sessionData = await openSession();
        console.log("Engine Session Opened.");

        const sessionApp = await sessionData.global.createSessionApp();

        try {
            await sessionApp.createConnection({
                qName: 'SourceData',
                qConnectionString: sourcePath, // Pass the raw host OS path
                qType: 'folder'
            });
        } catch (e) {
            console.log("Connection creation skipped/failed: ", e.message);
        }

        console.log("Setting generated script...");
        const validationResult = await validateScript(sessionData.global, finalScript, sessionApp);

        console.log("\\n--- engine validation Result ---");
        console.log("Success:", validationResult.success);
        console.log("Synthetic Keys Detected:", validationResult.synKeys);
        console.log("Circular References Detected:", validationResult.circularReferences);

        if (validationResult.errors && validationResult.errors.length > 0) {
            console.log("\\nCompilation Errors:");
            validationResult.errors.forEach(e => console.log('  ' + e));
        }

        if (validationResult.success) {
            console.log("\\n[!] Model Validated: Data Architect Pipeline V2 Successfully Compiled!");
        } else {
            console.log("\\n[!] Model Failed: See errors above.");
        }

    } catch (err) {
        console.error("Engine Validation Failed:", err);
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

testStep8();
