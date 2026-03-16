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
    // Stage 1: The REFACTORED logic (no cache deletion)
    const { runAgent } = require(moduleToTest);
    
    // In refactored state, require() returns the same cached object immediately
    
    if (i % 10 === 0) {
        console.log(`Run ${i} - Memory: ${getMemory()} MB`);
    }
}

console.log(`Final Memory (Refactored): ${getMemory()} MB`);
