const logger = require('../../.agent/utils/logger.js');
const { generateLayoutPlan } = require('../../layout_brain');
const { composeLayout } = require('../../layout_composer');

async function runLayoutPhase(context) {
    const { appName, qlikGlobal } = context;

    context.emit('System', '── Phase 6: Layout & Semantic Injection ──', 'phase');

    // If we skipped Phase 4/5 (Layout Only mode), we need to open the existing app
    if (!context.persistentApp) {
        context.emit('System', `Opening existing app '${appName}'...`, 'info');
        try {
            context.persistentApp = await qlikGlobal.openDoc(appName);
        } catch (e) {
            // GUI-based resolution if direct fails - but capture the NEW session
            await context.fallbackToOpenSessionForApp();
        }
    }

    context.emit('System', 'Synthesizing Dashboard Blueprint (Sub-Agent A & B)...', 'system');
    logger.info('Runner', 'Starting Layout Agent generation sequence.');

    // Simplified summary of model for prompt
    const tableList = await context.persistentApp.getTablesAndKeys({ qWindowSize: { qcx: 100, qcy: 100 }, qNullSize: { qcx: 0, qcy: 0 }, qCellHeight: 0, qSyntheticMode: false, qIncludeSysVars: false });

    // Format table strings simply for LLM to reason out Facts/Dims
    let modelExcerpt = "TABLES IN APP:\n";
    if (tableList.qtr && tableList.qtr.length > 0) {
        for (const table of tableList.qtr) {
            const columns = (table.qFields || []).map(f => f.qName).join(', ');
            modelExcerpt += `- ${table.qName} (Columns: ${columns || 'None'})\n`;
        }
    }

    const blueprint = await generateLayoutPlan(modelExcerpt);

    if (blueprint) {
        context.emit('System', 'Building App Dashboard using JSON Vaccines (Sub-Agent C)...', 'system');
        const layoutSuccess = await composeLayout(context.persistentApp, blueprint);
        if (layoutSuccess) {
            await context.persistentApp.doSave();
            context.emit('System', 'Executive Dashboard successfully mounted and saved in .qvf.', 'success');
        } else {
            context.emit('System', 'Layout composition failed.', 'error');
        }
    } else {
        context.emit('System', 'Layout brain failed to synthesize a blueprint.', 'error');
    }

    return true;
}

module.exports = { runLayoutPhase };