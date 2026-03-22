const fs = require('fs');
const path = require('path');
const { profileAllData } = require('../../architect_profiler');
const { classifyData } = require('../../architect_classifier');
const { determineRelationships } = require('../../architect_relationship_detector');
const { generateBlueprint, findFactGroups, escalateToLinkTableStrategy } = require('../../architect_structural_tester');
const { collapseFactGroups } = require('../../architect_metadata_collapser');
const { generateQvsScript } = require('../../architect_generator');
const { validateScript, getEngineMetrics } = require('../../qlik_tools');
const logger = require('../../.agent/utils/logger.js');

const CACHE_FILE = '.cache_base_script.qvs';

async function runArchitectPhase(context) {
    const { dataDir, workApp, runFolder, qlikGlobal, io } = context;

    context.emit('Architect', '── Phase 1: Profiling Data (Local Streaming) ──', 'phase');
    logger.info('Architect', 'Starting Deterministic Data Profiling');

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.txt'));

    // Cleanup OLD debug files to prevent user confusion
    const oldFiles = fs.readdirSync(process.cwd()).filter(f => f.startsWith('.debug_') || f.endsWith('_script.qvs'));
    oldFiles.forEach(f => { try { fs.unlinkSync(path.join(process.cwd(), f)); } catch (_) { } });

    context.emit('Architect', `Analyzing ${files.length} tables...`, 'info');
    
    // Step 0: Engine Native Profiling (for memory/symbol metrics)
    const engineMetrics = await getEngineMetrics(qlikGlobal, dataDir, files, workApp);

    // Step 1: Profiling
    const profileResult = await profileAllData(dataDir, files, engineMetrics);
    if (profileResult.error) {
        context.emit('Architect', `Failed to profile data: ${profileResult.error}`, 'error');
        throw new Error(profileResult.error);
    }
    
    const metadata = profileResult.metadata;
    const globalFieldValues = profileResult.globalFieldValues;
    context.emit('Architect', `Profiling complete. Found ${metadata.relationships.overlap.length} potential relationships.`, 'success');

    // ── Phase 1 → 2 gate ─────────────────────────────────────────────────
    if (!(await context.checkControl())) return false;

    // ── Phase 2: Architectural Reasoning (Deterministic) ──────────────────────
    context.emit('Architect', '── Phase 2: Architectural Reasoning (Deterministic) ──', 'phase');

    // Step 1: Classify Tables
    context.emit('Architect', `Step 1: Classifying Tables and Fields...`, 'info');
    const classResult = await classifyData(metadata, runFolder);
    const classifications = classResult.classifications;
    fs.writeFileSync(path.join(runFolder, '.debug_classifications.json'), JSON.stringify(classifications, null, 2));

    // Identify Fact Groups IMMEDIATELY to ensure shared namespace
    const factGroups = findFactGroups(metadata, classifications);
    let processedMetadata = metadata;
    let processedClassifications = classifications;

    if (factGroups.length > 0) {
        context.emit('Architect', `Identified ${factGroups.length} groups of fact tables for concatenation.`, 'info');
        const result = collapseFactGroups(metadata, classifications, factGroups);
        processedMetadata = result.metadata;
        processedClassifications = result.classifications;
    }

    if (!(await context.checkControl())) return false;

    // Step 2: Relationship Detection & Normalization
    context.emit('Architect', `Step 2: Normalizing Relationships to prevent Synthetic Keys...`, 'info');
    const relResult = determineRelationships(processedMetadata, processedClassifications, globalFieldValues);
    
    // Memory Cleanup: The field value sets are no longer needed
    if (globalFieldValues) {
        Object.keys(globalFieldValues).forEach(key => delete globalFieldValues[key]);
    }
    const normalizedData = relResult.normalizedData;

    if (!(await context.checkControl())) return false;

    // Step 3: Structural Strategy & Compilation
    context.emit('Architect', `Step 3: Calculating Best Multi-Fact Strategy...`, 'info');
    let { structuralBlueprint, directives: finalDirectives } = generateBlueprint(normalizedData, factGroups);
    context.emit('Architect', `Selected Base Strategy: ${structuralBlueprint.strategy}`, 'info');

    context.emit('Architect', 'Step 4: Real-time Qlik Engine Structural Validation...', 'info');
    let finalFastScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, true);
    let validation = await validateScript(qlikGlobal, finalFastScript, workApp);

    // Fallback Logic if Synthetic Keys are found
    if (validation.synKeys > 0 && structuralBlueprint.strategy === 'SINGLE_FACT') {
        context.emit('Architect', `⚠️ Qlik Engine detected ${validation.synKeys} Synthetic Keys. Forcing LINK_TABLE strategy...`, 'warning');
        
        structuralBlueprint = escalateToLinkTableStrategy(structuralBlueprint, normalizedData);

        finalFastScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, true);
        validation = await validateScript(qlikGlobal, finalFastScript, workApp);
    }

    fs.writeFileSync(path.join(runFolder, '.debug_final_script.qvs'), finalFastScript);

    if (validation.success && (validation.synKeys === 0 || validation.synKeys === undefined)) {
        context.emit('Architect', `✅ Final strategy validated. Model is clean (0 Syn Keys).`, 'success');
        logger.log('Architect', 'Script Verification Passed');
    } else {
        const primaryError = validation.errors && validation.errors[0] ? validation.errors[0] : "Unknown Error";
        const details = (validation.errors && validation.errors.length > 1) ? validation.errors[1] : "";
        
        context.emit('Architect', `⚠️ Warning: Qlik Engine Compilation Failed: ${primaryError}`, 'warning');
        
        if (details) {
            context.emit('System', details, 'warning');
        }

        context.emit('Architect', `Proceeding with app creation despite validation failure to allow manual inspection in Qlik Hub.`, 'info');
        logger.warn('Architect', 'Validation Failed - Proceeding anyway', { synKeys: validation.synKeys, errors: validation.errors });
    }

    context.success = true;
    context.currentScript = generateQvsScript(finalDirectives, normalizedData, dataDir, structuralBlueprint, false);
    fs.writeFileSync(path.join(runFolder, CACHE_FILE), context.currentScript);
    if (io) io.emit('script-update', { phase: 'architect', script: context.currentScript });

    return true;
}

module.exports = { runArchitectPhase };