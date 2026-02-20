const enigma = require('enigma.js');
const WebSocket = require('ws');
const schema = require('enigma.js/schemas/12.20.0.json');
const fs = require('fs');

const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
const bridgeBuilder = require('./.agent/skills/qlik-canonical-bridge-builder/bridge_builder.js');
const derivedFieldGen = require('./.agent/skills/qlik-derived-field-generator/derived_fields.js');
const dualInjector = require('./.agent/skills/qlik-dual-logic-injector/dual_injector.js');
const asOfGen = require('./.agent/skills/qlik-asof-table-generator/asof_generator.js');

async function debugEnhancer() {
    console.log("--- Debugging Enhancer Agent ---");

    const session = enigma.create({
        schema,
        url: 'ws://localhost:4848/app/engineData',
        createSocket: url => new WebSocket(url),
    });

    try {
        const global = await session.open();
        console.log("Connected to Engine.");

        // Open the app that was saved successfully
        const app = await global.openDoc('Agent_Generated_App');
        console.log("Opened 'Agent_Generated_App'.");

        // 1. Inspect
        const enrichmentMap = await inspector.inspectMetadata(app);
        console.log("Enrichment Map:", JSON.stringify(enrichmentMap, null, 2));

        // 2. Build Scripts
        let enhancementScript = "\n\n// *** ENHANCER AGENT OUTPUT ***\n";

        enhancementScript += bridgeBuilder.buildBridgeScript(enrichmentMap);
        enhancementScript += derivedFieldGen.generateDerivedFieldsScript();
        enhancementScript += dualInjector.generateDualScript(enrichmentMap);
        enhancementScript += asOfGen.generateAsOfScript();

        // 3. Save
        fs.writeFileSync('debug_output.qvs', enhancementScript);
        console.log("Saved debug_output.qvs");

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await session.close();
    }
}

debugEnhancer();
