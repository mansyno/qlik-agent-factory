const { runAgent } = require('../agent_runner');

async function testStateIndependence() {
    const mockState = {
        dataDir: './data', // assuming this exists or mocking it
        appName: 'TestApp',
        pipeline: ['architect'],
        io: { emit: () => {} },
        broadcastAgentState: () => {},
        agentControl: { stopRequested: false }
    };

    console.log("Starting Run 1...");
    // We expect this to fail or succeed, but we want to see if variables reset
    try { await runAgent(mockState); } catch (e) {}
    
    // Check global scope (if they were leaked)
    if (global.success !== undefined) {
        console.error("FAIL: 'success' variable leaked to global scope!");
    } else {
        console.log("PASS: 'success' is not global.");
    }

    if (global.currentScript !== undefined) {
        console.error("FAIL: 'currentScript' variable leaked to global scope!");
    } else {
        console.log("PASS: 'currentScript' is not global.");
    }
}

testStateIndependence();
