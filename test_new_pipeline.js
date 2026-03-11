const { runPipeline } = require('./pipeline_runner');
const path = require('path');

const dataDir = path.resolve(__dirname, 'northwind'); // or any test directory

async function test() {
    try {
        console.log(`Testing pipeline on ${dataDir}...`);
        const result = await runPipeline(dataDir);
        
        console.log("\n====== FINAL QVS SCRIPT ======\n");
        console.log(result.finalScript);
        
        console.log("\nPipeline succeeded!");
    } catch (err) {
        console.error("Pipeline failed:", err);
    }
}

test();
