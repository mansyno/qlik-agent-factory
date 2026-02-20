const inspector = require('./.agent/skills/qlik-metadata-inspector/inspector.js');
const bridgeBuilder = require('./.agent/skills/qlik-canonical-bridge-builder/bridge_builder.js');
const derivedFieldGen = require('./.agent/skills/qlik-derived-field-generator/derived_fields.js');
const dualInjector = require('./.agent/skills/qlik-dual-logic-injector/dual_injector.js');
const asOfGen = require('./.agent/skills/qlik-asof-table-generator/asof_generator.js');

async function enhanceScript(app, baseScript) {
    console.log("--- Starting Enhancer Agent (Agent 3) ---");

    // 1. Inspect Metadata (Post-Architect Load)
    // The app passed to this function MUST have the Base Script loaded and data reloaded.
    const enrichmentMap = await inspector.inspectMetadata(app);
    console.log("Enrichment Map generated.");

    // Log detection results
    const logger = require('./.agent/utils/logger.js');
    if (enrichmentMap.canonicalDateKey) {
        logger.enhancement('Metadata Inspection', `Found Canonical Date Key: ${enrichmentMap.canonicalDateKey}`);
    } else {
        logger.error('Enhancer', 'Metadata Inspection Warning', 'No Canonical Date Key found in LinkTable.');
    }

    // 2. Build Enhancement Scripts
    let enhancementScript = "\n\n// *** ENHANCER AGENT OUTPUT ***\n";

    // Canonical Bridge
    try {
        const bridgeScript = bridgeBuilder.buildBridgeScript(enrichmentMap);
        enhancementScript += bridgeScript;
        logger.enhancement('Bridge Builder', 'Generated Canonical Bridge Script');
    } catch (e) {
        logger.error('Enhancer', 'Bridge Builder Failed', e);
    }

    // Derived Fields (Calendar)
    try {
        const derivedScript = derivedFieldGen.generateDerivedFieldsScript(enrichmentMap);
        enhancementScript += derivedScript;
        logger.enhancement('Derived Fields', 'Generated Auto-Calendar Script');
    } catch (e) {
        logger.error('Enhancer', 'Derived Fields Failed', e);
    }

    // Dual Logic Injection
    try {
        const dualScript = dualInjector.generateDualScript(enrichmentMap);
        enhancementScript += dualScript;
        logger.enhancement('Dual Injector', 'Evaluated Dual Flags');
    } catch (e) {
        logger.error('Enhancer', 'Dual Injector Failed', e);
    }

    // As-Of Table
    // Note: As-Of generation might require data from the bridge to be loaded first.
    // In a single script run, we can put it at the end, but it relies on resident data.
    // If we just concatenate scripts, it runs *after* the base load.
    // Bridge creates [Canonical Date].
    // As-Of reads [Canonical Date].
    // So order matters: Bridge -> AsOf.
    try {
        const asOfScript = asOfGen.generateAsOfScript(enrichmentMap);
        enhancementScript += asOfScript;
        logger.enhancement('As-Of Generator', 'Generated Rolling Period Table');
    } catch (e) {
        logger.error('Enhancer', 'As-Of Generator Failed', e);
    }

    // 3. Combine
    const finalScript = baseScript + enhancementScript;

    console.log("--- Enhancer Agent Finished ---");
    return finalScript;
}

module.exports = { enhanceScript };
