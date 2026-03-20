const fs = require('fs');
const path = require('path');
const logger = require('../../.agent/utils/logger.js');
const { getLiveMetadata, formatMetadataAsMarkdown, validateScript } = require('../../qlik_tools');
const { runDeterministicChecks, runPreFlightInspection, deduplicatePlans } = require('../../enhancer_heuristics');
const { generateEnrichmentPlan } = require('../../enhancer_brain');
const { composeEnrichment } = require('../../enhancer_composer');

async function runEnhancerPhase(context) {
    const { workApp, qlikGlobal, io } = context;

    context.emit('Enhancer', '── Phase 3: Enhancer Agent ──', 'phase');
    logger.info('Enhancer', 'Starting Enrichment Phase (Hybrid)');

    let fastBaseScript = context.currentScript;
    let plan = null;
    let enrichedScript = null;
    let report = null;
    let metadata = null; // hoisted so Stage B can use it for reference validation

    // Stage A: Inspect + Plan
    const stageStart = Date.now();
    try {
        // Reload workApp with the FULL production script so cardinality counts are real.
        // The previous state of workApp is from the FIRST 1 validation run — wrong data for inspection.
        context.emit('Enhancer', 'Loading full dataset for metadata inspection...', 'info');
        await workApp.setScript(context.currentScript);
        await workApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

        // Ensure Enhancer validation loops use a FAST (FIRST 1) baseline for speed
        if (!context.currentScript.includes('FIRST 1')) {
            fastBaseScript = context.currentScript.replace(/LOAD/g, 'FIRST 1\nLOAD');
        }

        metadata = await getLiveMetadata(workApp);
        const mdMetadata = formatMetadataAsMarkdown(metadata);
        
        const metaSize = JSON.stringify(metadata).length;
        const mdSize = mdMetadata.length;
        console.log(`[PERF] Enhancer Live Metadata size: ${(metaSize / 1024).toFixed(1)} KB (MD Table: ${(mdSize / 1024).toFixed(1)} KB)`);

        // Stage A1: Deterministic "Tier 1" logic
        const deterministicPlan = runDeterministicChecks(metadata, (agent, msg, type) => context.emit(agent, msg, type));

        // Stage A2: Pre-Flight Inspection (Hints)
        const hints = runPreFlightInspection(metadata);
        if (hints.length > 0) {
            context.emit('Enhancer', `Pre-Flight: Identified ${hints.length} potential patterns. Passing hints to LLM.`, 'info');
            hints.forEach(h => logger.debug('Enhancer', `PRE-FLIGHT HINT: ${h}`));
        }

        const planStart = Date.now();
        const llmResult = await generateEnrichmentPlan(mdMetadata, context.currentScript, hints);
        const planTime = (Date.now() - planStart) / 1000;
        logger.debug('Enhancer', `Planning took ${planTime.toFixed(1)}s`);

        // Deduplicate
        const llmPlan = deduplicatePlans(llmResult.plan, deterministicPlan, logger);

        // Merge Plans
        plan = {
            plan: [...deterministicPlan, ...llmPlan],
            reasoningSummary: llmResult.reasoningSummary
        };

        context.emit('Enhancer', plan.reasoningSummary || 'Enrichment plan formulated.', 'reasoning');
    } catch (planErr) {
        logger.error('Enhancer', `Plan generation failed [${planErr.constructor?.name}]: ${planErr.message}`, planErr);
        context.emit('Enhancer', `Plan generation failed [${planErr.constructor?.name}]: ${planErr.message}`, 'error');
        plan = null;
    }

    // Stage B: Compose enrichments
    if (plan) {
        try {
            const composerResult = await composeEnrichment(plan, fastBaseScript, qlikGlobal, workApp, metadata);
            enrichedScript = context.currentScript + composerResult.appliedEnrichments;
            report = composerResult.report;

            report.forEach(r => {
                const ok = r.status.startsWith('Applied');
                const icon = ok ? '✅' : '❌';
                const reason = !ok && r.reason ? ` — ${r.reason}` : '';
                context.emit('Enhancer', `${icon} [${r.tier.toUpperCase()}] ${r.tool}: ${r.status}${reason}`, ok ? 'success' : 'warning');
            });
            logger.enhancement('Enhancement Report', report);
        } catch (composeErr) {
            logger.error('Enhancer', `Compose failed [${composeErr.constructor?.name}]: ${composeErr.message}`, composeErr);
            context.emit('Enhancer', `Compose failed [${composeErr.constructor?.name}]: ${composeErr.message}`, 'error');
            enrichedScript = null;
        }
    }

    // Stage C: Final validation
    if (enrichedScript) {
        try {
            const enhancedValidation = await validateScript(qlikGlobal, enrichedScript, workApp);
            if (enhancedValidation.success && enhancedValidation.synKeys === 0) {
                context.emit('Enhancer', '✅ Enriched script validated.', 'success');
                logger.enhancement('Validation Success', 'Hybrid script passed checks.');
                context.currentScript = enrichedScript;
                if (io) io.emit('script-update', { phase: 'enhancer', script: context.currentScript });
            } else {
                context.emit('Enhancer', '⚠️ Enriched script invalid — reverting to base.', 'warning');
                if (enhancedValidation.errors?.length) {
                    enhancedValidation.errors.forEach(e => context.emit('Enhancer', `↳ ${e}`, 'error'));
                }
            }
        } catch (valErr) {
            logger.error('Enhancer', `Final validation failed [${valErr.constructor?.name}]: ${valErr.message}`, valErr);
            context.emit('Enhancer', `Final validation failed [${valErr.constructor?.name}]: ${valErr.message}`, 'error');
        }
    }
    
    return true;
}

module.exports = { runEnhancerPhase };