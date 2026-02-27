const fs = require('fs');
const path = require('path');
const { resolveModelStructure, resolveTemporalAndJoins } = require('./brain');

async function testStep4to7() {
    console.log("=== Testing Steps 4-7: Architectural Blueprint Generation ===");

    const profileFile = path.resolve(__dirname, 'test_profile_output.json');
    const classFile = path.resolve(__dirname, 'test_classification_output.json');
    const normFile = path.resolve(__dirname, 'test_normalization_output.json');
    const graphFile = path.resolve(__dirname, 'test_graph_output.json');

    if (!fs.existsSync(profileFile) || !fs.existsSync(classFile) || !fs.existsSync(normFile) || !fs.existsSync(graphFile)) {
        console.error(`Missing prerequisite data. Please run tests 0 through 3 first.`);
        process.exit(1);
    }

    const profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const classData = JSON.parse(fs.readFileSync(classFile, 'utf8'));
    const normData = JSON.parse(fs.readFileSync(normFile, 'utf8'));
    const graphData = JSON.parse(fs.readFileSync(graphFile, 'utf8'));

    console.log("\n--- [Phase A] Resolving Model Structure ---");
    try {
        const structuralBlueprint = await resolveModelStructure(profileData, classData, normData, graphData);

        console.log("Link Table Required:", structuralBlueprint.linkTableRequired);
        console.log(`Identified ${structuralBlueprint.factTables.length} Fact Entities.`);
        console.log(`Identified ${structuralBlueprint.dimensionTables.length} Dimension Entities.`);

        fs.writeFileSync('test_structure_output.json', JSON.stringify(structuralBlueprint, null, 2));

        console.log("\n--- [Phase B] Resolving Temporal & Joins ---");
        const scriptDirectives = await resolveTemporalAndJoins(structuralBlueprint, profileData);

        let bridgeCount = 0;
        scriptDirectives.forEach(d => {
            if (d.requiresDateBridge) bridgeCount++;
        });

        console.log(`Generated directives for ${scriptDirectives.length} tables.`);
        console.log(`Identified ${bridgeCount} tables requiring Canonical Date Bridges.`);

        fs.writeFileSync('test_directives_output.json', JSON.stringify(scriptDirectives, null, 2));
        console.log("\nSuccess! Saved outputs to test_structure_output.json and test_directives_output.json");
    } catch (err) {
        console.error("Test Failed:", err);
    }
}

testStep4to7();
