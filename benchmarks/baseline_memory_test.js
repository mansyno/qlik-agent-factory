const fs = require('fs');
const path = require('path');

function getMemory() {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    return Math.round(used * 100) / 100;
}

const moduleToTest = path.resolve(__dirname, '../agent_runner.js');

console.log(`Initial Memory: ${getMemory()} MB`);

// Simulate 50 "runs" of the agent via the server route
for (let i = 1; i <= 50; i++) {
    // Stage 1: The current bad practice in server.js
    Object.keys(require.cache).forEach(key => {
        if (key.includes('agent_runner') || key.includes('brain') || key.includes('enhancer') || key.includes('layout') || key.includes('deterministic_modeler') || key.includes('architect_generator')) {
            delete require.cache[key];
        }
    });

    const { runAgent } = require(moduleToTest);
    
    // We don't actually call runAgent because it needs Qlik and LLM keys,
    // we just test the impact of re-parsing and re-compiling the module tree.
    
    if (i % 10 === 0) {
        console.log(`Run ${i} - Memory: ${getMemory()} MB`);
    }
}

console.log(`Final Memory (Current Logic): ${getMemory()} MB`);
