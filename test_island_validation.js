const { openSession, closeSession, validateScript } = require('./qlik_tools');

async function runTest() {
    let sessionData = null;
    try {
        console.log("Starting Subgraph/Island test...");
        sessionData = await openSession();
        const globalObj = sessionData.global;
        const workApp = await globalObj.createSessionApp();

        // This script simulates the lorries failure: 
        // Group 1: FactA -> Dim1
        // Group 2: FactB -> Dim2
        // They do NOT connect to each other.
        const islandScript = `
        FactA:
        LOAD * INLINE [
            FactID_A, DimKey1, ValueA
            1, 100, 50
        ];
        
        Dim1:
        LOAD * INLINE [
            DimKey1, DimDesc1
            100, "Group 1 Dimension"
        ];

        FactB:
        LOAD * INLINE [
            FactID_B, DimKey2, ValueB
            2, 200, 75
        ];

        Dim2:
        LOAD * INLINE [
            DimKey2, DimDesc2
            200, "Group 2 Dimension"
        ];
        `;

        console.log("Validating fractured script...");
        const result = await validateScript(globalObj, islandScript, workApp);
        console.log("Validation Result:", JSON.stringify(result, null, 2));

        if (!result.success && result.errors.some(e => e.includes("disconnected groups"))) {
            console.log("SUCCESS: BFS validation correctly caught the 2 disconnected sub-graphs.");
        } else {
            console.error("FAILURE: BFS validation did NOT catch the sub-graphs.");
        }

    } catch (e) {
        console.error("Error during test:", e);
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

runTest();
