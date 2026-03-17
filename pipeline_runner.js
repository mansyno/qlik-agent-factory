const { openSession, closeSession, validateScript, getEngineMetrics } = require('./qlik_tools');
const { profileAllData } = require('./architect_profiler');
const { classifyData } = require('./architect_classifier');
const { determineRelationships } = require('./architect_relationship_detector');
const { generateBlueprint } = require('./architect_structural_tester');
const { generateQvsScript } = require('./architect_generator');
const path = require('path');
const fs = require('fs');
const logger = require('./.agent/utils/logger.js');

async function runPipeline(dataPath) {
    let sessionData = null;
    try {
        logger.log('PHASE', "Initializing Qlik Engine Session...", null, 'Pipeline');
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
        logger.log('PHASE', "Gathering Qlik Engine metrics...", null, 'Pipeline');
        const engineMetrics = await getEngineMetrics(globalObj, dataPath, files, workApp);

        // Step 1: Data Profiling (Local Streaming + Engine Metrics)
        logger.log('PHASE', "Profiling Data...", null, 'Pipeline');
        const profileResult = await profileAllData(dataPath, files, engineMetrics);
        if (profileResult.error) throw new Error(profileResult.error);
        const metadata = profileResult.metadata;

        // Step 2: Classification
        logger.log('PHASE', "Classifying Tables and Fields...", null, 'Pipeline');
        const classResult = await classifyData(metadata);
        const classifications = classResult.classifications;

        fs.writeFileSync(path.join(__dirname, '.debug_classifications.json'), JSON.stringify(classifications, null, 2));

        // Step 3: Relationship Detection & Normalization
        logger.log('PHASE', "Relationship Detection and Normalization...", null, 'Pipeline');
        const relResult = determineRelationships(metadata, classifications, profileResult.globalFieldValues);
        const normalizedData = relResult.normalizedData;

        // Step 4: Structural Tester — proposes an initial strategy
        logger.log('PHASE', "Structural Test and Blueprint Generation...", null, 'Pipeline');
        let { structuralBlueprint, directives: finalDirectives } = generateBlueprint(normalizedData);

        logger.info('Pipeline', `Initial Strategy Selected: ${structuralBlueprint.strategy}`);

        // ===== Engine-First Strategy =====
        // Phase 4a: Generate a fast test script with the proposed strategy
        let fastScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, true);
        
        fs.writeFileSync(path.join(__dirname, '.debug_final_script.qvs'), fastScript);
        
        logger.info('Pipeline', "Running Structural Test Load on Qlik Engine...");
        let validation = await validateScript(globalObj, fastScript, workApp);

        // Phase 4b: Engine-driven escalation/de-escalation
        if (validation.synKeys > 0) {
            logger.warn('Pipeline', `Test load produced ${validation.synKeys} Synthetic Keys!`);
            
            // Escalate: current strategy produced synthetic keys, try link table
            if (structuralBlueprint.strategy !== 'LINK_TABLE') {
                logger.info('Pipeline', `Escalating from ${structuralBlueprint.strategy} to LINK_TABLE to resolve synthetic keys.`);
                
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
                logger.info('Pipeline', "Escalation LinkTable keys:", { sharedKeys: structuralBlueprint.linkTableBlueprint.sharedKeys });

                fastScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, true);
                fs.writeFileSync(path.join(__dirname, '.debug_final_script.qvs'), fastScript);
                
                validation = await validateScript(globalObj, fastScript, workApp);
            }
        }

        if (validation.success && validation.synKeys === 0) {
            logger.success('Pipeline', "Validation SUCCESS: 0 Synthetic Keys, 0 Circular References.");

            // Step 5: Final Production Generation
            logger.log('PHASE', "Generating Final QVS Script...", null, 'Pipeline');
            const finalScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, false);

            return {
                success: true,
                finalScript: finalScript,
                directives: finalDirectives
            };
        } else {
            logger.error('Pipeline', "Validation FAILED Even with Fallback Strategy", { errors: validation.errors });
            const errStr = `Qlik Compilation Failed:\n${validation.errors.join('\n')}\nSyn Keys: ${validation.synKeys}`;
            throw new Error(errStr);
        }
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

module.exports = { runPipeline };
