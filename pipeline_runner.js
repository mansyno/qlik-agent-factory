const { openSession, closeSession, validateScript, getEngineMetrics } = require('./qlik_tools');
const { profileAllData } = require('./architect_profiler');
const { classifyData } = require('./architect_classifier');
const { determineRelationships } = require('./architect_relationship_detector');
const { generateBlueprint } = require('./architect_structural_tester');
const { generateQvsScript } = require('./architect_generator');
const path = require('path');
const fs = require('fs');

async function runPipeline(dataPath) {
    let sessionData = null;
    try {
        console.log("\n[PIPELINE] Initializing Qlik Engine Session...");
        sessionData = await openSession();
        const globalObj = sessionData.global;
        const workApp = await globalObj.createSessionApp();

        try {
            await workApp.createConnection({
                qName: 'SourceData',
                qConnectionString: dataPath.replace(/\\\\/g, '/'),
                qType: 'folder'
            });
        } catch (e) { } 
        const files = fs.readdirSync(dataPath).filter(f => f.endsWith('.csv'));
        if (files.length === 0) throw new Error("No CSV files found in " + dataPath);

        // Step 0: Engine Native Profiling (for memory/symbol metrics)
        console.log("[PIPELINE] Phase 0: Gathering Qlik Engine metrics...");
        const engineMetrics = await getEngineMetrics(globalObj, dataPath, files, workApp);

        // Step 1: Data Profiling (Local Streaming + Engine Metrics)
        console.log("\n[PIPELINE] Phase 1: Profiling Data...");
        const profileResult = await profileAllData(dataPath, files, engineMetrics);
        if (profileResult.error) throw new Error(profileResult.error);
        const metadata = profileResult.metadata;

        // Step 2: Classification
        console.log("\n[PIPELINE] Phase 2: Classifying Tables and Fields...");
        const classResult = classifyData(metadata);
        const classifications = classResult.classifications;

        fs.writeFileSync(path.join(__dirname, '.debug_classifications.json'), JSON.stringify(classifications, null, 2));

        // Step 3: Relationship Detection & Normalization
        console.log("\n[PIPELINE] Phase 3: Relationship Detection and Normalization...");
        const relResult = determineRelationships(metadata, classifications);
        const normalizedData = relResult.normalizedData;

        // Step 4: Structural Tester — proposes an initial strategy
        console.log("\n[PIPELINE] Phase 4: Structural Test and Blueprint Generation...");
        let { structuralBlueprint, finalDirectives } = generateBlueprint(normalizedData);

        console.log(`  Initial Strategy Selected: ${structuralBlueprint.strategy}`);

        // ===== Engine-First Strategy =====
        // Phase 4a: Generate a fast test script with the proposed strategy
        let fastScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, true);
        
        fs.writeFileSync(path.join(__dirname, '.debug_final_script.qvs'), fastScript);
        
        console.log("  Running Structural Test Load on Qlik Engine...");
        let validation = await validateScript(globalObj, fastScript, workApp);

        // Phase 4b: Engine-driven escalation/de-escalation
        if (validation.synKeys > 0) {
            console.warn(`[PIPELINE] WARNING: Test load produced ${validation.synKeys} Synthetic Keys!`);
            
            // Escalate: current strategy produced synthetic keys, try link table
            if (structuralBlueprint.strategy !== 'LINK_TABLE') {
                console.log(`  Escalating from ${structuralBlueprint.strategy} to LINK_TABLE to resolve synthetic keys.`);
                
                structuralBlueprint.strategy = 'LINK_TABLE';
                const sharedKeysSet = new Set();
                const factTables = structuralBlueprint.factTables.map(f => f.tableName);
                const keyPresenceInFacts = {}; 
                
                factTables.forEach(fName => {
                    const tableNorms = normalizedData.find(n => n.tableName === fName);
                    if (!tableNorms) return;
                    tableNorms.normalizedFields.forEach(nf => {
                        if (nf.type === 'IDENTIFIER' || nf.normalizedName?.endsWith('Key')) {
                            if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                            keyPresenceInFacts[nf.normalizedName].add(fName);
                        }
                    });
                });

                Object.keys(keyPresenceInFacts).forEach(k => {
                    if (keyPresenceInFacts[k].size > 1) sharedKeysSet.add(k);
                });

                structuralBlueprint.linkTableRequired = true;
                structuralBlueprint.linkTableBlueprint = {
                    linkTableName: 'LinkTable',
                    sharedKeys: Array.from(sharedKeysSet)
                };
                console.log("[PIPELINE] Escalation LinkTable keys:", structuralBlueprint.linkTableBlueprint.sharedKeys);

                fastScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, true);
                fs.writeFileSync(path.join(__dirname, '.debug_final_script.qvs'), fastScript);
                
                validation = await validateScript(globalObj, fastScript, workApp);
            }
        }

        if (validation.success && validation.synKeys === 0) {
            console.log("\n[PIPELINE] Validation SUCCESS: 0 Synthetic Keys, 0 Circular References.");

            // Step 5: Final Production Generation
            console.log("\n[PIPELINE] Phase 5: Generating Final QVS Script...");
            const finalScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, false);

            return {
                success: true,
                finalScript: finalScript,
                directives: finalDirectives
            };
        } else {
            console.error("\n[PIPELINE] Validation FAILED Even with Fallback Strategy:", validation.errors);
            const errStr = `Qlik Compilation Failed:\n${validation.errors.join('\n')}\nSyn Keys: ${validation.synKeys}`;
            throw new Error(errStr);
        }
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

module.exports = { runPipeline };
