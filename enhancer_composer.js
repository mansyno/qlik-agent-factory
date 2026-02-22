const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger');
const { validateScript } = require('./qlik_tools');
const { attemptSelfHeal } = require('./enhancer_brain');

/**
 * Loads the catalog of deterministic templates (array-based structure).
 */
function loadCatalog() {
    try {
        const catalogPath = path.join(__dirname, 'templates', 'catalog.json');
        const raw = fs.readFileSync(catalogPath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        logger.error('Composer', 'Failed to load catalog', e);
        return [];
    }
}

/**
 * Executes a Catalog tool by replacing placeholders in its template.
 * @param {Object} toolDefinition - From the Enrichment Plan
 * @param {Array} catalog - The loaded catalog definitions (array)
 * @returns {String} The generated script snippet
 */
function executeCatalogTool(toolDefinition, catalog) {
    const { toolId, parameters } = toolDefinition;
    const templateDef = catalog.find(t => t.id === toolId);

    if (!templateDef) {
        logger.error('Composer', `Catalog tool '${toolId}' not found in manifest.`);
        return null; // Signal failure
    }

    let script = templateDef.template;
    for (const [key, value] of Object.entries(parameters)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        script = script.replace(regex, value);
    }

    // Detect any unreplaced {{placeholder}} — means LLM omitted required parameters
    const missing = [...script.matchAll(/{{(\w+)}}/g)].map(m => m[1]);
    if (missing.length > 0) {
        logger.error('Composer', `Catalog tool '${toolId}' has unreplaced parameters: ${missing.join(', ')}`);
        return null; // Signal failure with a clear reason via the caller's report
    }

    logger.enhancement('Catalog Tool Executed', `Injected ${toolId}`);
    return script;
}

/**
 * Formats a Forge tool (AI-synthesized custom block) into a script block.
 * @param {Object} toolDefinition - From the Enrichment Plan
 * @returns {String} The formatted script block
 */
function executeForgeTool(toolDefinition) {
    const { patternName, description, script } = toolDefinition;
    logger.log('Composer', `Preparing custom script for pattern: ${patternName}`);
    return `\n// --- FORGE PATTERN: ${patternName} ---\n// Description: ${description}\n${script}\n`;
}

/**
 * Dynamically checks if a 1-to-many relationship exists between two fields
 * by querying the Qlik Engine. Used to validate Market Basket viability.
 */
async function checkOneToManyViability(sessionApp, idField, itemField) {
    try {
        const hypercubeDef = {
            qInfo: { qType: "ViabilityCheck" },
            qHyperCubeDef: {
                qDimensions: [{ qDef: { qFieldDefs: [idField] } }],
                qMeasures: [{ qDef: { qDef: `Count(Distinct [${itemField}])` } }],
                qInitialDataFetch: [{ qTop: 0, qLeft: 0, qHeight: 50, qWidth: 2 }],
                qSuppressZero: true,
                qSuppressMissing: true
            }
        };
        const hcObject = await sessionApp.createSessionObject(hypercubeDef);
        const hcLayout = await hcObject.getLayout();
        const rows = hcLayout.qHyperCube.qDataPages[0]?.qMatrix || [];
        // If any group has > 1 distinct item, it's 1-to-many
        return rows.some(row => row[1]?.qNum > 1);
    } catch (e) {
        logger.error('Composer', 'Failed viability check', e);
        return false;
    }
}

/**
 * Composes the final enrichment script based on the AI's plan.
 * - Tier 1 (Catalog): Validated in sandbox. If it fails, skip and log. No LLM self-heal.
 * - Tier 2 (Forge): Validated in sandbox. If it fails, one LLM self-heal attempt is made.
 *
 * @param {Object} plan - The JSON Enrichment Plan from the Brain
 * @param {String} baseScript - The Architect's script
 * @param {Object} sessionGlobal - From openSession()
 * @param {Object} sessionApp - The active Qlik session app
 * @returns {Promise<Object>} { enrichedScript, report: Array }
 */
async function composeEnrichment(plan, baseScript, sessionGlobal, sessionApp) {
    if (!plan || !plan.plan) {
        logger.error('Composer', 'Invalid Enrichment Plan format received');
        return { enrichedScript: baseScript, report: [] };
    }

    const catalog = loadCatalog();
    let cumulativeScript = baseScript + "\n\n// *** ENHANCER AGENT OUTPUT (Hybrid Model) ***\n";
    let appliedEnrichments = "";
    const enhancementReport = [];

    for (const tool of plan.plan) {
        const toolIdentifier = tool.toolId || tool.patternName || 'Unknown Tool';
        let proposedSnippet = "";

        try {
            // --- STEP 0: Pre-validation for specific tools ---
            if (toolIdentifier === 'market_basket' && tool.parameters) {
                const { idField, itemField } = tool.parameters;
                logger.log('Composer', `Checking 1-to-many viability for [${idField}] -> [${itemField}]...`);
                const isViable = await checkOneToManyViability(sessionApp, idField, itemField);
                if (!isViable) {
                    enhancementReport.push({
                        tool: toolIdentifier,
                        tier: 'catalog',
                        status: 'Rejected',
                        reason: `Data does not support market basket (Max 1 distinct '${itemField}' per '${idField}')`
                    });
                    logger.error('Composer', `Basket rejected: No 1-to-many relationship found.`);
                    appliedEnrichments += `\n// --- CATALOG TOOL: ${toolIdentifier} (REJECTED) ---\n// Reason: No 1-to-many relationship found for ${idField}->${itemField}\n`;
                    continue;
                }
            }

            // --- STEP 1: Generate the snippet ---
            if (tool.tier === 'catalog') {
                proposedSnippet = executeCatalogTool(tool, catalog);
                if (!proposedSnippet) {
                    enhancementReport.push({ tool: toolIdentifier, tier: 'catalog', status: 'Rejected', reason: 'Tool ID not found in catalog' });
                    continue;
                }
            } else if (tool.tier === 'forge') {
                proposedSnippet = executeForgeTool(tool);
            } else {
                logger.error('Composer', `Unknown tier '${tool.tier}' in Enrichment Plan`);
                enhancementReport.push({ tool: toolIdentifier, tier: tool.tier, status: 'Rejected', reason: `Unknown tier: ${tool.tier}` });
                continue;
            }

            // --- STEP 2: Validate the snippet in the sandbox ---
            let testScript = cumulativeScript + appliedEnrichments + proposedSnippet;
            logger.log('Composer', `Validating [${tool.tier.toUpperCase()}] tool: ${toolIdentifier}...`);
            let validation = await validateScript(sessionGlobal, testScript, sessionApp);

            if (validation.success && validation.synKeys === 0) {
                // SUCCESS — commit
                appliedEnrichments += proposedSnippet;
                enhancementReport.push({ tool: toolIdentifier, tier: tool.tier, status: 'Applied', reason: 'Passed validation' });
                logger.enhancement('Tool Applied', `${toolIdentifier} committed successfully.`);
                continue;
            }

            // --- STEP 3: Handle Failure ---
            const firstError = validation.errors && validation.errors.length > 0
                ? validation.errors.join('; ')
                : 'Synthetic Keys detected';

            if (tool.tier === 'forge') {
                // FORGE FAILURE: one LLM self-heal attempt
                logger.log('Composer', `Forge failure for '${toolIdentifier}'. Attempting self-heal...`);
                let healedScript = null;
                try {
                    healedScript = await attemptSelfHeal(tool.script, firstError);
                } catch (healErr) {
                    logger.error('Composer', `Self-heal call failed for '${toolIdentifier}'`, healErr);
                }

                if (healedScript) {
                    const healedSnippet = executeForgeTool({ ...tool, script: healedScript });
                    testScript = cumulativeScript + appliedEnrichments + healedSnippet;
                    logger.log('Composer', `Validating healed snippet for: ${toolIdentifier}...`);
                    validation = await validateScript(sessionGlobal, testScript, sessionApp);

                    if (validation.success && validation.synKeys === 0) {
                        appliedEnrichments += healedSnippet;
                        enhancementReport.push({ tool: toolIdentifier, tier: 'forge', status: 'Applied (Healed)', reason: 'Passed validation after retry' });
                        logger.enhancement('Tool Healed', `${toolIdentifier} applied after self-correction.`);
                        continue;
                    }
                }

                // Self-heal also failed
                const healedError = (validation.errors && validation.errors.join('; ')) || 'Self-heal failed or produced invalid script';
                enhancementReport.push({ tool: toolIdentifier, tier: 'forge', status: 'Rejected', reason: healedError });
                logger.error('Composer', `Forge tool '${toolIdentifier}' rejected after self-heal`, healedError);
                appliedEnrichments += `\n// --- FORGE TOOL: ${toolIdentifier} (REJECTED) ---\n// Reason: ${healedError}\n`;

            } else {
                // CATALOG FAILURE: skip cleanly, no LLM self-heal for deterministic tools
                enhancementReport.push({ tool: toolIdentifier, tier: 'catalog', status: 'Rejected', reason: firstError });
                logger.error('Composer', `Catalog tool '${toolIdentifier}' failed sandbox. Skipping.`, firstError);
                appliedEnrichments += `\n// --- CATALOG TOOL: ${toolIdentifier} (REJECTED) ---\n// Reason: ${firstError}\n`;
            }

        } catch (e) {
            enhancementReport.push({ tool: toolIdentifier, tier: tool.tier, status: 'Error', reason: e.message });
            logger.error('Composer', `Unexpected error applying tool '${toolIdentifier}'`, e);
            appliedEnrichments += `\n// --- TOOL: ${toolIdentifier} (ERROR) ---\n// Exception: ${e.message}\n`;
        }
    }

    const enrichedScript = cumulativeScript + appliedEnrichments;
    return { enrichedScript, report: enhancementReport };
}

module.exports = { composeEnrichment };
