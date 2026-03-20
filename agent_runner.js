/**
 * agent_runner.js
 * Decoupled agent orchestration — callable from the Express API or CLI.
 * Accepts an `io` instance and `broadcastAgentState` for real-time streaming.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger.js');
const PipelineContext = require('./orchestrator/PipelineContext');
const { runArchitectPhase } = require('./orchestrator/phases/architectPhase');
const { runEnhancerPhase } = require('./orchestrator/phases/enhancerPhase');
const { runFinalizationPhase } = require('./orchestrator/phases/finalizationPhase');
const { runLayoutPhase } = require('./orchestrator/phases/layoutPhase');

// ── Main Agent Runner ─────────────────────────────────────────────────────────
async function runAgent(config) {
    const context = new PipelineContext(config);

    try {
        await context.initialize();

        const runArchitect = context.pipeline.includes('architect');
        const runEnhancer = context.pipeline.includes('enhancer');
        const runLayout = context.pipeline.includes('layout');

        // ── Enhancer/Layout-only: read base script BEFORE opening the working session ────
        let preloadedBaseScript = null;
        if (!runArchitect && (runEnhancer || runLayout)) {
            preloadedBaseScript = await context.fetchLiveBaseScript();
            if (!preloadedBaseScript && runEnhancer) return; // fatal for enhancer, layout can ignore
        }

        await context.connectEngine();

        if (runArchitect) {
            await context.createSessionApp();
        } else {
            await context.openPersistentAppForWork();
        }

        // ── Phase 1 & 2: Profiling & Architectural Reasoning (Architect) ───────────
        if (runArchitect) {
            const architectSuccess = await runArchitectPhase(context);
            if (!architectSuccess) return; // stopped or failed
        } else if (runEnhancer || runLayout) {
            if (preloadedBaseScript) {
                context.currentScript = preloadedBaseScript;
                context.success = true;
            } else if (runLayout && !runEnhancer) {
                // Layout only mode doesn't strictly need the base script to exist
                context.success = true;
            } else {
                return; 
            }
        }

        if (!(await context.checkControl())) return;

        // ── Phase 3: Enhancer ─────────────────────────────────────────────────
        if (context.success && runEnhancer) {
            const enhancerSuccess = await runEnhancerPhase(context);
            if (!enhancerSuccess) return;
        } else if (context.success && !runEnhancer) {
            context.emit('System', 'Enhancer skipped (Architect-only mode).', 'info');
        }

        // ── Phase 4 & 5: Finalization & Promotion ─────────────────────────────
        if (context.success && (runArchitect || runEnhancer)) {
            await runFinalizationPhase(context);
        }

        // --- Phase 6: UI LAYOUT GENERATION (AGENT 4) ---
        if (runLayout && context.success) {
            await runLayoutPhase(context);
        } else if (!context.success) {
            context.emit('Architect', '❌ Failed to generate valid script within attempt limit.', 'error');
            logger.error('Architect', 'Failed to generate script after max attempts');
        }

    } catch (err) {
        context.logError('System', 'Fatal Error', err);
    } finally {
        await context.cleanup();
        logger.info('System', 'Process Terminated');
        logger.save();
        context.emit('System', 'Agent process complete. Audit log saved.', 'info');
    }
}

module.exports = { runAgent };