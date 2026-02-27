const path = require('path');
const fs = require('fs');
const { openSession, closeSession } = require('./qlik_tools');
const { profileAllData } = require('./architect_profiler');

async function runTest() {
    console.log("=== Testing Architect Profiler (Step 0) ===");
    const dataDir = path.resolve(__dirname, 'northwind'); // try northwind or DATA

    if (!fs.existsSync(dataDir)) {
        console.error(`Folder doesn't exist: ${dataDir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.txt'));
    console.log(`Found ${files.length} files to profile.`);

    let session;
    let global;
    try {
        const connection = await openSession();
        session = connection.session;
        global = connection.global;

        console.log(`Engine connected. Initiating profileAllData...`);
        const result = await profileAllData(global, dataDir, files);

        if (result.error) {
            console.error("Test Failed with Error:", result.error);
        } else {
            console.log("\n--- Profiling Successful ---");
            console.log(JSON.stringify(result.metadata, null, 2));
            fs.writeFileSync('test_profile_output.json', JSON.stringify(result.metadata, null, 2));
            console.log("Saved output to test_profile_output.json");
        }

    } catch (e) {
        console.error("Test execution error:", e);
    } finally {
        if (session) {
            await closeSession(session);
        }
        process.exit(0);
    }
}

runTest();
