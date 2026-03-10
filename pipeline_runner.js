const { profileData, profileNativeRelationships, openSession, closeSession } = require('./qlik_tools');
const { classifyTablesAndFields } = require('./brain');
const { resolveArchitecture } = require('./deterministic_modeler');
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

        let profiles = {};
        for (const file of files) {
            console.log(`  Profiling ${file} (Pass A)...`);
            const p = await profileData(globalObj, path.join(dataPath, file), workApp);
            if (p && !p.error) {
                profiles[file.replace('.csv', '')] = p;
            }
        }

        console.log("  [PIPELINE] Profiling Native Relationships (Pass B)...");
        const relationships = await profileNativeRelationships(globalObj, dataPath, files, workApp);

        const fullProfile = {
            tables: profiles,
            relationships: relationships
        };

        // Step 1: Classify Tables
        console.log("\n[PIPELINE] Step 1: Classifying Tables...");
        const classificationResult = await classifyTablesAndFields(fullProfile);

        if (classificationResult.error && classificationResult.error !== "null" && classificationResult.error !== null) {
            console.error(`[PIPELINE] LLM Escape Hatch: ${classificationResult.error}`);
            throw new Error(classificationResult.error);
        }

        const classifications = classificationResult.classifications;

        // Write classification to disk for debugging
        fs.writeFileSync(path.join(__dirname, '.debug_classifications.json'), JSON.stringify(classifications, null, 2));

        // Step 2 & 3: Deterministic Normalization and Structure Strategy
        console.log("\n[PIPELINE] Step 2-3: Resolving Architecture Deterministically...");
        const { normalizedData, structuralBlueprint, finalDirectives } = resolveArchitecture(fullProfile, classifications);

        // Step 4: Compilation Validation (Fast pass)
        console.log("\n[PIPELINE] Step 4: Compiling via Qlik Engine...");
        const fastScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, true);

        // Use the shared `workApp` created at the start of the pipeline
        const validation = await validateScript(globalObj, fastScript, workApp);

        if (validation.success && validation.synKeys === 0) {
            console.log("[PIPELINE] Validation SUCCESS: 0 Synthetic Keys, 0 Circular References.");

            // Re-generate without the 1-row limit for production
            const finalScript = generateQvsScript(finalDirectives, normalizedData, dataPath, structuralBlueprint, false);

            return {
                success: true,
                finalScript: finalScript,
                directives: finalDirectives
            };
        } else {
            console.error("[PIPELINE] Validation FAILED:", validation.errors);
            const errStr = `Qlik Engine Compilation Failed:\n${validation.errors.join('\n')}\n` +
                `Synthetic Keys Found: ${validation.synKeys}\n` +
                `Circular References: ${validation.circularReferences}`;
            throw new Error(errStr);
        }
    } finally {
        if (sessionData) await closeSession(sessionData.session);
    }
}

module.exports = { runPipeline };
