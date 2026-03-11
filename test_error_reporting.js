const { openSession, validateScript } = require('./qlik_tools');

async function testErrorReporting() {
    console.log("Testing Verbose Error Reporting...");
    const { session, global } = await openSession();
    
    try {
        const app = await global.createSessionApp();
        
        // Script that will fail during reload due to non-existent library
        const brokenScript = `
            TEMP:
            LOAD * FROM [lib://MissingConnectionXYZ/test.csv] (txt);
        `;
        
        console.log("Validating broken script...");
        const result = await validateScript(global, brokenScript, app);
        
        console.log("\n--- Validation Result ---");
        console.log("Success:", result.success);
        console.log("Errors:", JSON.stringify(result.errors, null, 2));
        
    } catch (err) {
        console.error("Test failed:", err);
    } finally {
        await session.close();
    }
}

testErrorReporting();
