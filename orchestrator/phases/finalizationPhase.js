const fs = require('fs');
const path = require('path');
const logger = require('../../.agent/utils/logger.js');
const { createPersistentApp } = require('../../qlik_tools');

async function runFinalizationPhase(context) {
    const { runFolder, dataDir, appName } = context;

    context.emit('System', '── Phase 4: Finalization ──', 'phase');
    fs.writeFileSync(path.join(runFolder, 'final_script.qvs'), context.currentScript);
    context.emit('System', 'Final script saved to final_script.qvs', 'success');
    logger.info('System', 'Final Script Saved', { path: 'final_script.qvs' });

    context.emit('System', '── Phase 5: Promoting to Persistent App ──', 'phase');
    
    // Switch connection state to persistent app context
    await context.transitionToPersistentAppSession();

    context.persistentApp = await createPersistentApp(context.qlikGlobal, appName);
    try {
        await context.persistentApp.createConnection({ qName: 'SourceData', qConnectionString: path.resolve(dataDir), qType: 'folder' });
    } catch (e) {
        if (!e.message?.includes('already exists')) throw e;
    }
    
    await context.persistentApp.setScript(context.currentScript);
    const reloadResult = await context.persistentApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });
    const reloadOk = reloadResult.qSuccess;
    const reloadMsg = reloadOk
        ? '✅ Success'
        : `❌ Failed — ${reloadResult.qErrorDesc || 'no detail'} (code ${reloadResult.qErrorCode})`;
    
    context.emit('System', `Reload: ${reloadMsg}`, reloadOk ? 'success' : 'error');
    logger.info('System', 'App Reload Finished', { success: reloadOk });

    await context.persistentApp.doSave();
    context.emit('System', `App '${appName}' saved successfully.`, 'success');
    logger.info('System', 'App Saved', { appName });
    
    return true;
}

module.exports = { runFinalizationPhase };