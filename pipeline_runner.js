const { profileData, openSession, closeSession } = require('./qlik_tools');
const { classifyTablesAndFields, normalizeFields, buildAssociationGraph, resolveModelStructure, resolveTemporalAndJoins } = require('./brain');
const { generateQvsScript } = require('./architect_generator');
const { validateScript } = require('./qlik_tools');
const path = require('path');
const fs = require('fs');

/**
 * Executes the entire Data Architect Pipeline (Steps 0 - 8).
 * @param {string} dataPath - Absolute path to the directory containing CSVs
 * @returns {object} { success, finalScript, warnings, directives }
 */
async function runPipeline(dataPath) {
    let sessionData = null;
    try {
        console.log("\n[PIPELINE] Initializing Qlik Engine Session...");
        sessionData = await openSession();
        const globalObj = sessionData.global;
        const workApp = await globalObj.createSessionApp();

        // Ensure Data Connection exists for the entire pipeline
        try {
            await workApp.createConnection({
                qName: 'SourceData',
                qConnectionString: dataPath.replace(/\\\\/g, '/'),
                qType: 'folder'
            });
        } catch (e) { } // Ignore if already exists

        // Step 0: Profile Data
        console.log("\n[PIPELINE] Step 0: Profiling Data...");
        const files = fs.readdirSync(dataPath).filter(f => f.endsWith('.csv'));
        if (files.length === 0) throw new Error("No CSV files found in " + dataPath);

        let fullProfile = [];
        for (const file of files) {
            console.log(`  Profiling ${file}...`);
            const p = await profileData(globalObj, path.join(dataPath, file), workApp);
            if (p && !p.error) {
                fullProfile.push({
                    tableName: file.replace('.csv', ''),
                    rowCount: "Unknown",
                    fields: p.fields
                });
            }
        }

        // Step 1: Classify Tables
        console.log("\n[PIPELINE] Step 1: Classifying Tables...");
        const classifications = await classifyTablesAndFields(fullProfile);

        // Loop Controls
        let maxRetries = 3;
        let currentRetry = 0;
        let compilationErrorContext = null;

        let normalizedData;
        let graph;
        let structuralBlueprint;
        let finalDirectives;
        let finalScript;

        // --- TIERED FEEDBACK LOOP ---
        // We encompass Steps 2 thru 8 in a retry loop.
        while (currentRetry < maxRetries) {
            try {
                // Step 2: Normalize Fields
                console.log(`\n[PIPELINE] Step 2: Normalizing Fields (Attempt ${currentRetry + 1}/${maxRetries})...`);
                // Introduce compilation error context if we are looping back due to Synthetic Keys
                normalizedData = await normalizeFields(fullProfile, classifications, compilationErrorContext);

                // Step 3: Conceptual Association Graph
                console.log("\n[PIPELINE] Step 3: Building Conceptual Graph...");
                graph = await buildAssociationGraph(normalizedData);
                if (graph.circularReferenceDetected) {
                    console.warn("[PIPELINE] WARNING: LLM detected a conceptual Circular Reference.", graph.resolutionPlan);
                    // If the LLM *predicts* a loop, we could theoretically loop back to Step 2 here,
                    // but we will let the Qlik Engine make the final determination in Step 8.
                }

                // Step 4 & 5: Model Structure Blueprint
                console.log("\n[PIPELINE] Steps 4-5: Resolving Model Structure...");
                structuralBlueprint = await resolveModelStructure(fullProfile, classifications, normalizedData, graph);

                // Step 6 & 7: Temporal & Join Blueprint
                console.log("\n[PIPELINE] Steps 6-7: Resolving Temporal and Join Strategies...");
                finalDirectives = await resolveTemporalAndJoins(structuralBlueprint, fullProfile);

                // Step 8: Compilation Validation
                console.log("\n[PIPELINE] Step 8: Compiling via Qlik Engine...");
                finalScript = generateQvsScript(finalDirectives, normalizedData, dataPath);

                // Use the shared `workApp` created at the start of the pipeline
                const validation = await validateScript(globalObj, finalScript, workApp);

                if (validation.success) {
                    console.log("[PIPELINE] Validation SUCCESS: 0 Synthetic Keys, 0 Circular References.");
                    return {
                        success: true,
                        finalScript: finalScript,
                        directives: finalDirectives
                    };
                } else {
                    console.error("[PIPELINE] Validation FAILED:", validation.errors);
                    compilationErrorContext = `Qlik Engine Compilation Failed:\n${validation.errors.join('\\n')}\n` +
                        `Synthetic Keys Found: ${validation.synKeys}\n` +
                        `Circular References: ${validation.circularReferences}\n` +
                        `Fix the field normalization to prevent these associations.`;

                    currentRetry++;
                    if (currentRetry >= maxRetries) {
                        throw new Error("Max compilation retries exceeded.");
                    }
                    console.log(`[PIPELINE] Initiating feedback loop... Restarting at Step 2.`);
                }

            } catch (loopErr) {
                console.error("[PIPELINE] Unhandled error in Loop:", loopErr.message);
                throw loopErr;
            }
        }

    } catch (err) {
        console.error("[PIPELINE] Fatal Error:", err);
        return { success: false, error: err.message };
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

module.exports = { runPipeline };
