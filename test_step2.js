const fs = require('fs');
const path = require('path');
const { normalizeFields } = require('./brain');

async function testStep2() {
    console.log("=== Testing Step 2: Field Normalization ===");

    const profileFile = path.resolve(__dirname, 'test_profile_output.json');
    const classFile = path.resolve(__dirname, 'test_classification_output.json');

    if (!fs.existsSync(profileFile) || !fs.existsSync(classFile)) {
        console.error(`Missing prerequisite data. Please run test_profiler.js and test_step1.js first.`);
        process.exit(1);
    }

    const profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const classificationData = JSON.parse(fs.readFileSync(classFile, 'utf8'));

    console.log("Sending Profile + Classification to LLM for Normalization. Please wait...");
    try {
        const normalizationMatrix = await normalizeFields(profileData, classificationData);

        console.log("\n--- Normalization Success ---");
        // Print out just the composite keys array length as a sanity check
        let compositeCount = 0;
        normalizationMatrix.forEach(t => {
            if (t.compositeKeys && t.compositeKeys.length > 0) {
                compositeCount += t.compositeKeys.length;
                console.log(`[!] Table ${t.tableName} defined ${t.compositeKeys.length} composite key(s).`);
            }
        });

        console.log(`Total Composite Keys Defined: ${compositeCount}`);

        fs.writeFileSync('test_normalization_output.json', JSON.stringify(normalizationMatrix, null, 2));
        console.log("\nSaved normalization matrix to test_normalization_output.json");
    } catch (err) {
        console.error("Test Failed:", err);
    }
}

testStep2();
