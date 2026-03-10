const enigma = require('enigma.js');
const WebSocket = require('ws');
const schema = require('enigma.js/schemas/12.170.2.json');
const path = require('path');
const fs = require('fs');

async function openSession(appId = 'engineData') {
    const session = enigma.create({
        schema,
        url: `ws://localhost:4848/app/${encodeURIComponent(appId)}`,
        createSocket: url => new WebSocket(url),
    });
    const global = await session.open();
    return { session, global };
}

/**
 * Opens a session connected directly to a named persistent app.
 * Strategy:
 *   1. Try getDocList() to resolve name → GUID (works when engine can enumerate apps).
 *   2. Fall back to openDoc(appName) directly — Qlik Desktop accepts plain names too,
 *      and getDocList() may return an empty list depending on engine/user context.
 */
async function openSessionForApp(appName) {
    // Generic engine connection (no specific app)
    const session = enigma.create({
        schema,
        url: `ws://localhost:4848/app/engineData`,
        createSocket: url => new WebSocket(url),
    });
    const global = await session.open();

    // --- Strategy 1: getDocList() name → GUID resolution ---
    const docList = await global.getDocList();
    console.log(`[openSessionForApp] getDocList returned ${docList.length} apps:`);
    docList.forEach(d => console.log(`  qDocId=${d.qDocId}  qDocName=${d.qDocName}`));

    const entry = docList.find(d =>
        d.qDocName.toLowerCase() === appName.toLowerCase() ||
        d.qDocName.replace(/\.qvf$/i, '').toLowerCase() === appName.toLowerCase() ||
        d.qDocId === appName
    );

    if (entry) {
        console.log(`[openSessionForApp] Matched via docList: ${entry.qDocId}`);
        const appHandle = await global.openDoc(entry.qDocId);
        return { session, global, appHandle };
    }

    // --- Strategy 2: direct openDoc by name (Qlik Desktop fallback) ---
    // On Desktop, openDoc accepts the app name without .qvf if the app is saved.
    console.log(`[openSessionForApp] Not in docList — trying openDoc('${appName}') directly...`);
    try {
        const appHandle = await global.openDoc(appName);
        return { session, global, appHandle };
    } catch (directErr) {
        // Clean up before rethrowing so the caller gets a useful message
        try { await session.close(); } catch (_) { }
        throw new Error(
            `App '${appName}' could not be opened. ` +
            `getDocList returned ${docList.length} apps (see server console). ` +
            `Direct openDoc error: ${directErr.message}`
        );
    }
}

async function closeSession(session) {
    if (session) {
        await session.close();
    }
}

async function profileData(global, targetPath, app = null) {
    let sessionApp = app;
    try {
        if (!sessionApp) {
            sessionApp = await global.createSessionApp();
        }

        const dir = path.dirname(targetPath);
        const filename = path.basename(targetPath);
        const tableName = filename.replace('.csv', '');
        const connectionName = 'TempData_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        await sessionApp.createConnection({
            qName: connectionName,
            qConnectionString: dir,
            qType: 'folder'
        });

        // Pass A: QUALIFY * with full data load to isolate memory and accurate counts
        const loadScript = `
            QUALIFY *;
            [${tableName}]:
            LOAD *
            FROM [lib://${connectionName}/${filename}]
            (txt, utf8, embedded labels, delimiter is ',', msq);
        `;

        await sessionApp.setScript(loadScript);
        const reloadResult = await sessionApp.doReload();

        if (!reloadResult) return { error: 'Reload failed (No data or invalid format)' };

        // Get table record to extract row count
        const tablesAndKeys = await sessionApp.getTablesAndKeys({ qWindowSize: { qcx: 0, qcy: 0 }, qNullSize: { qcx: 0, qcy: 0 }, qSyntheticMode: false });
        const tableRecord = tablesAndKeys.qtr.find(t => t.qName === tableName);
        const rowCount = tableRecord ? tableRecord.qNoOfRows : 0;

        const sessionObj = await sessionApp.createSessionObject({
            qInfo: { qType: 'FieldList' },
            qFieldListDef: {}
        });

        const layout = await sessionObj.getLayout();
        const fieldList = layout.qFieldList.qItems;

        const fields = [];
        for (const field of fieldList) {
            const fieldData = await sessionApp.getField(field.qName);
            const card = await fieldData.getCardinal();
            // Remove the Qualify prefix for the output
            const originalName = field.qName.replace(`${tableName}.`, '');
            fields.push({
                name: originalName,
                distinctCount: card
            });
        }

        return { rowCount, fields };

    } catch (err) {
        return { error: err.message };
    }
}

/**
 * Pass B: Profile Native Relationships
 * Loads 1 row from all tables UNQUALIFIED to see native engine associations & syn keys
 */
async function profileNativeRelationships(global, dataDir, files, app = null) {
    let sessionApp = app;
    try {
        if (!sessionApp) {
            sessionApp = await global.createSessionApp();
        }

        const connectionName = 'TempDataRel_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        await sessionApp.createConnection({
            qName: connectionName,
            qConnectionString: dataDir.replace(/\\\\/g, '/'),
            qType: 'folder'
        });

        let loadScript = '';
        for (const file of files) {
            const tableName = file.replace('.csv', '');
            loadScript += `
                FIRST 1
                LOAD * FROM [lib://${connectionName}/${file}]
                (txt, utf8, embedded labels, delimiter is ',', msq);
            `;
        }

        await sessionApp.setScript(loadScript);
        const reloadResult = await sessionApp.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

        if (!reloadResult.qSuccess) {
            return { error: 'Failed to profile native relationships (Reload failed).' };
        }

        const tablesAndKeys = await sessionApp.getTablesAndKeys({ qWindowSize: { qcx: 0, qcy: 0 }, qNullSize: { qcx: 0, qcy: 0 }, qSyntheticMode: true });

        const syntheticKeys = tablesAndKeys.qtr.filter(t => t.qIsSynthetic === true).map(t => {
            return {
                name: t.qName,
                fields: (t.qFields || []).map(f => f.qName)
            };
        });

        const realTables = tablesAndKeys.qtr.filter(t => t.qIsSynthetic !== true);
        const fieldToTables = {};

        realTables.forEach(t => {
            (t.qFields || []).forEach(f => {
                if (!fieldToTables[f.qName]) {
                    fieldToTables[f.qName] = [];
                }
                fieldToTables[f.qName].push(t.qName);
            });
        });

        const nativeLinks = {};
        for (const [field, tbls] of Object.entries(fieldToTables)) {
            if (tbls.length > 1) {
                nativeLinks[field] = tbls;
            }
        }

        return { syntheticKeys, nativeLinks };

    } catch (err) {
        return { error: err.message };
    }
}

async function validateScript(global, scriptText, appOrDataPath) {
    let app;
    let createdIsolatedApp = false;

    // Determine if we need to create our own sandbox app
    if (typeof appOrDataPath === 'string') {
        app = await global.createSessionApp();
        createdIsolatedApp = true;

        // Ensure the SourceData connection exists for this new isolated sandbox
        try {
            await app.createConnection({
                qName: 'SourceData',
                qConnectionString: appOrDataPath.replace(/\\\\/g, '/'),
                qType: 'folder'
            });
        } catch (e) {
            // connection might already exist in some global contexts
        }
    } else {
        // Fallback: an App object was provided directly
        app = appOrDataPath;
    }

    try {
        console.log(`[QLIK_TOOLS] Validating script (Version V3)...`);
        await app.setScript(scriptText);

        // Use doReloadEx to aggressively trap syntax compilation errors
        const reloadRes = await app.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

        if (!reloadRes.qSuccess) {
            const engineError = reloadRes.qErrorDesc || "Unknown Script Error";
            console.error(`[QLIK_ENGINE_ERROR] ${engineError}`);
            return {
                success: false,
                synKeys: 0,
                circularReferences: false,
                errors: [
                    `Qlik Engine Reload Failed: ${engineError}`,
                    "Review .debug_final_script.qvs in the project root to find the syntax error."
                ]
            };
        }

        const tables = await app.getTablesAndKeys({ qWindowSize: { qcx: 0, qcy: 0 }, qNullSize: { qcx: 0, qcy: 0 }, qSyntheticMode: true });
        const synKeys = tables.qtr.filter(t => t.qIsSynthetic === true).length;

        const realTables = tables.qtr.filter(t => t.qIsSynthetic !== true);
        const fieldToTables = {};

        realTables.forEach(t => {
            (t.qFields || []).forEach(f => {
                if (!fieldToTables[f.qName]) {
                    fieldToTables[f.qName] = [];
                }
                fieldToTables[f.qName].push(t.qName);
            });
        });

        // Build Adjacency List for Graph
        const adjacencyList = {};
        realTables.forEach(t => { adjacencyList[t.qName] = new Set(); });

        Object.values(fieldToTables).forEach(tableList => {
            if (tableList.length > 1) {
                for (let i = 0; i < tableList.length; i++) {
                    for (let j = i + 1; j < tableList.length; j++) {
                        adjacencyList[tableList[i]].add(tableList[j]);
                        adjacencyList[tableList[j]].add(tableList[i]);
                    }
                }
            }
        });

        // BFS to count Connected Components
        let componentCount = 0;
        const visited = new Set();

        if (realTables.length > 0) {
            realTables.forEach(t => {
                if (!visited.has(t.qName)) {
                    componentCount++;
                    const queue = [t.qName];
                    visited.add(t.qName);

                    while (queue.length > 0) {
                        const current = queue.shift();
                        for (const neighbor of adjacencyList[current]) {
                            if (!visited.has(neighbor)) {
                                visited.add(neighbor);
                                queue.push(neighbor);
                            }
                        }
                    }
                }
            });
        } else {
            componentCount = 1; // 0 real tables, fallback avoids false error
        }

        // Circular Reference Detection: In a tree, edges = nodes - 1.
        // If there are more unique edges than that, the graph has a cycle.
        let edgeCount = 0;
        const edgeSet = new Set();
        for (const [node, neighbors] of Object.entries(adjacencyList)) {
            for (const neighbor of neighbors) {
                const edgeKey = [node, neighbor].sort().join('||');
                edgeSet.add(edgeKey);
            }
        }
        edgeCount = edgeSet.size;
        const hasCircularRefs = edgeCount > (realTables.length - 1);

        const success = (synKeys === 0 && componentCount <= 1 && !hasCircularRefs);
        const errors = [];
        if (synKeys > 0) errors.push(`Failed validation: Engine created ${synKeys} Synthetic Keys.`);
        if (componentCount > 1) errors.push(`Failed validation: The data model is fractured into ${componentCount} disconnected groups (sub-graphs). All tables must eventually connect together into a single associative model.`);
        if (hasCircularRefs) errors.push(`Failed validation: Circular references detected. The data model has ${edgeCount} associations but only ${realTables.length} tables (expected max ${realTables.length - 1} associations for a tree).`);

        return {
            success: success,
            synKeys: synKeys,
            circularReferences: hasCircularRefs,
            errors: errors
        };
    } catch (err) {
        return {
            success: false,
            synKeys: 0,
            circularReferences: false,
            errors: [err.message]
        };
    } finally {
        if (createdIsolatedApp && app) {
            try {
                // In enigma.js, handle objects have a .session property
                await app.session.close();
            } catch (e) { }
        }
    }
}

async function createConnection(app, name, pathStr) {
    try {
        await app.createConnection({
            qName: name,
            qConnectionString: pathStr,
            qType: 'folder'
        });
        return true;
    } catch (err) {
        // Ignore if already exists (error 20002 or similar? logic needed if strict)
        // console.log("Connection might already exist: " + err.message);
        return false;
    }
}

async function createPersistentApp(global, appName) {
    try {
        console.log(`Creating persistent app: ${appName}...`);
        const newApp = await global.createApp(appName);

        // Open the app to get the handle
        const appHandle = await global.openDoc(newApp.qAppId);
        console.log(`App created and opened. ID: ${newApp.qAppId}`);
        return appHandle;
    } catch (err) {
        // If app already exists, we might want to open it instead or delete/recreate
        if (err.message.includes('already exists') || err.message.includes('App already open')) {
            console.log(`App '${appName}' already exists/open. attempting to attach...`);
            try {
                const appHandle = await global.openDoc(appName);
                return appHandle;
            } catch (openErr) {
                // If openDoc fails with "App already open", it usually means we need to getActiveDoc or it's open in another session?
                // Actually, if openDoc fails, let's try getActiveDoc if we were in a browser, but here we are in a raw socket.
                // In Qlik Sense Desktop, openDoc works even if open in Hub.
                // But let's log specifically.
                console.log("Could not open existing app: " + openErr.message);
                throw openErr;
            }
        }
        throw err;
    }
}

module.exports = {
    openSession,
    openSessionForApp,
    closeSession,
    profileData,
    profileNativeRelationships,
    validateScript,
    createConnection,
    createPersistentApp
};
