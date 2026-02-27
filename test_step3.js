const fs = require('fs');
const path = require('path');
const { buildAssociationGraph } = require('./brain');

async function testStep3() {
    console.log("=== Testing Step 3: Association Graph Validation ===");

    const normFile = path.resolve(__dirname, 'test_normalization_output.json');

    if (!fs.existsSync(normFile)) {
        console.error(`Missing prerequisite data. Please run test_step2.js first.`);
        process.exit(1);
    }

    const normalizedData = JSON.parse(fs.readFileSync(normFile, 'utf8'));

    console.log("Sending Normalized Tables to LLM for Graph Tracing. Please wait...");
    try {
        const graphReport = await buildAssociationGraph(normalizedData);

        console.log("\n--- Graph Validation Validation Success ---");
        console.log(`Edges Identified: ${graphReport.edges.length}`);
        console.log(`Circular Reference Detected: ${graphReport.circularReferenceDetected}`);

        if (graphReport.circularReferenceDetected) {
            console.log(`\nRESOLUTION PLAN:\n${graphReport.resolutionPlan}`);
        } else {
            console.log("Schema is structurally sound (No cycles).");
        }

        fs.writeFileSync('test_graph_output.json', JSON.stringify(graphReport, null, 2));
        console.log("\nSaved graph report to test_graph_output.json");
    } catch (err) {
        console.error("Test Failed:", err);
    }
}

testStep3();
