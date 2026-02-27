const fs = require('fs');
const path = require('path');
const { classifyTablesAndFields } = require('./brain');

async function testStep1() {
    console.log("=== Testing Step 1: Table & Field Classification ===");

    const profileFile = path.resolve(__dirname, 'test_profile_output.json');
    if (!fs.existsSync(profileFile)) {
        console.error(`Missing profile data. Please run test_profiler.js first.`);
        process.exit(1);
    }

    const profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    console.log(`Loaded profile data for ${profileData.tables.length} tables.`);

    console.log("Sending to LLM for Classification. Please wait...");
    try {
        const classificationMatrix = await classifyTablesAndFields(profileData);

        console.log("\n--- Classification Success ---");
        console.log(JSON.stringify(classificationMatrix, null, 2));

        fs.writeFileSync('test_classification_output.json', JSON.stringify(classificationMatrix, null, 2));
        console.log("\nSaved classification matrix to test_classification_output.json");
    } catch (err) {
        console.error("Test Failed:", err);
    }
}

testStep1();
