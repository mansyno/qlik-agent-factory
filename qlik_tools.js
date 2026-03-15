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

    // --- Strategy 1: Direct openDoc by name (Qlik Desktop / Already known GUID) ---
    // This is the fastest way. Qlik Desktop accepts the app name or full path.
    console.log(`[openSessionForApp] Attempting direct openDoc('${appName}')...`);
    try {
        const appHandle = await global.openDoc(appName);
        console.log(`[openSessionForApp] Successfully opened '${appName}' directly.`);
        return { session, global, appHandle };
    } catch (directErr) {
        console.log(`[openSessionForApp] Direct openDoc failed: ${directErr.message}. Falling back to docList resolution...`);
    }

    // --- Strategy 2: getDocList() name → GUID resolution (Hub/Server fallback) ---
    try {
        const docList = await global.getDocList();
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

        // Clean up
        await session.close();
        throw new Error(`App '${appName}' not found in docList and direct open failed.`);
    } catch (docListErr) {
        try { await session.close(); } catch (_) { }
        throw new Error(`App '${appName}' could not be opened. Error: ${docListErr.message}`);
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
 * Fetches engine-level metrics (Symbol table size, memory footprint) for a set of tables.
 * This aligns with the "Data Profiling" phase in qliktext.txt.
 */
async function getEngineMetrics(global, dataDir, files, app = null) {
    let sessionApp = app;
    let createdApp = false;
    
    if (!sessionApp) {
        sessionApp = await global.createSessionApp();
        createdApp = true;
    }

    const connectionName = 'MetricProbe_' + Date.now();
    
    try {
        await sessionApp.createConnection({
            qName: connectionName,
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });

        let script = '';
        files.forEach(f => {
            const tableName = f.replace('.csv', '');
            script += `[${tableName}]: LOAD * FROM [lib://${connectionName}/${f}] (txt, utf8, embedded labels, delimiter is ',', msq);\n`;
        });

        await sessionApp.setScript(script);
        await sessionApp.doReload();

        // getTablesAndKeys with extra details provides memory and symbol counts
        const tableData = await sessionApp.getTablesAndKeys({ 
            qWindowSize: { qcx: 100, qcy: 100 }, 
            qNullSize: { qcx: 0, qcy: 0 }, 
            qSyntheticMode: false,
            qIncludeSysVars: false
        });

        const metrics = {};
        tableData.qtr.forEach(t => {
            metrics[t.qName] = {
                rows: t.qNoOfRows,
                fields: t.qNoOfFields,
                memorySize: t.qByteSize, // Total size in memory
                isSynthetic: t.qIsSynthetic
            };
        });

        return metrics;
    } catch (err) {
        console.error("[QLIK_TOOLS] getEngineMetrics error:", err);
        return {};
    } finally {
        if (createdApp && sessionApp) {
            await sessionApp.session.close();
        }
    }
}
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

function stripQlikMetadata(line) {
    if (!line) return "";
    // Regex matches the ISO-like timestamp and subsequent metadata (Process ID, etc)
    // Example: "20260310T134006.057+0200      "
    const cleaned = line.replace(/^[0-9T.:+-]+\s+/g, '').trim();
    // Also remove line numbers like "0139 " (4 digits + space)
    return cleaned.replace(/^[0-9]{4}\s+/g, '').trim();
}

function cleanQlikError(logContent) {
    if (!logContent) return null;
    const lines = logContent.split('\n');
    const errorLines = lines.filter(l => l.includes('Error:'));
    
    if (errorLines.length > 0) {
        let lastError = errorLines[errorLines.length - 1];
        const parts = lastError.split('Error:');
        if (parts.length > 1) {
            return `Error: ${parts[1].trim()}`;
        }
        return stripQlikMetadata(lastError);
    }
    return null;
}

async function getLatestScriptLog() {
    try {
        const logDir = 'd:\\Users\\Daniel\\Documents\\Qlik\\Sense\\Log\\Script';
        if (!fs.existsSync(logDir)) return null;

        const files = fs.readdirSync(logDir)
            .filter(f => f.endsWith('.log'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(logDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length === 0) return null;

        const latestFile = path.join(logDir, files[0].name);
        const content = fs.readFileSync(latestFile, 'utf8');
        
        const coreError = cleanQlikError(content);
        const logLines = content.split('\n').filter(l => l.trim().length > 0);
        
        // Clean up the last 15 lines for context
        const cleanedLines = logLines.slice(-15).map(stripQlikMetadata).filter(l => l.length > 0);

        return {
            coreError,
            fullContext: cleanedLines.join('\n')
        };
    } catch (err) {
        console.error(`[QLIK_TOOLS] Failed to read physical log: ${err.message}`);
        return null;
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
        console.log(`[QLIK_TOOLS] Validating script (Version V5 - Physical Logs)...`);
        await app.setScript(scriptText);

        const reloadRes = await app.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });

        if (!reloadRes.qSuccess) {
            const engineError = reloadRes.qErrorDesc || "Unknown Script Error";
            console.error(`[QLIK_ENGINE_ERROR] ${engineError}`);
            
            // Deterministic approach: Read the newest log file from disk
            const physicalLog = await getLatestScriptLog();
            
            let displayError = (physicalLog && physicalLog.coreError) ? physicalLog.coreError : `Reload Failed: ${engineError}`;
            let verboseDetails = (physicalLog && physicalLog.fullContext)
                ? `\n--- RELOAD LOG CONTEXT ---\n${physicalLog.fullContext}`
                : "No detailed engine logs found on disk.";

            return {
                success: false,
                synKeys: 0,
                circularReferences: false,
                errors: [
                    displayError,
                    verboseDetails
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
                // Use a CHAIN strategy: (T1-T2, T2-T3, ...)
                for (let i = 0; i < tableList.length - 1; i++) {
                    adjacencyList[tableList[i]].add(tableList[i + 1]);
                    adjacencyList[tableList[i + 1]].add(tableList[i]);
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
            componentCount = 1;
        }

        // Circular Reference Detection
        let edgeCount = 0;
        const edgeSet = new Set();
        for (const [node, neighbors] of Object.entries(adjacencyList)) {
            for (const neighbor of neighbors) {
                const edgeKey = [node, neighbor].sort().join('||');
                edgeSet.add(edgeKey);
            }
        }
        edgeCount = edgeSet.size;
        const hasCircularRefs = edgeCount > (realTables.length - componentCount);

        const success = (synKeys === 0 && !hasCircularRefs);
        const errors = [];
        
        if (synKeys > 0) errors.push(`Failed validation: Engine created ${synKeys} Synthetic Keys.`);
        
        if (hasCircularRefs) {
            errors.push(`Failed validation: Circular references detected. The data model has ${edgeCount} unique table associations but only ${realTables.length} tables (tree limit: ${realTables.length - componentCount}).`);
        }

        if (componentCount > 1) {
            console.warn(`[VALIDATION WARNING] The data model contains ${componentCount} disconnected groups.`);
        }

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

async function getLiveMetadata(app) {
    try {
        console.log("[QLIK_TOOLS] Fetching Live Metadata (getTablesAndKeys)...");
        const tableData = await app.getTablesAndKeys({ 
            qWindowSize: { qcx: 0, qcy: 100 }, 
            qNullSize: { qcx: 0, qcy: 0 }, 
            qSyntheticMode: true 
        });

        const metadata = {
            tables: {},
            syntheticKeys: []
        };

        for (const t of tableData.qtr) {
            if (t.qIsSynthetic) {
                metadata.syntheticKeys.push(t.qName);
                continue;
            }

            const fields = [];
            for (const f of t.qFields) {
                let cardinal = 0;
                let samples = [];
                
                try {
                    const fieldHandle = await app.getField(f.qName);
                    cardinal = await fieldHandle.getCardinal();

                    // Stable way to get samples: Create a temporary list object
                    const sessionObj = await app.createSessionObject({
                        qInfo: { qType: 'FieldValues' },
                        qListObjectDef: {
                            qDef: { qFieldDefs: [f.qName] },
                            qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 5 }]
                        }
                    });
                    const layout = await sessionObj.getLayout();
                    if (layout.qListObject.qDataPages && layout.qListObject.qDataPages.length > 0) {
                        samples = layout.qListObject.qDataPages[0].qMatrix.map(m => m[0].qText);
                    }
                    await app.destroySessionObject(sessionObj.id);
                } catch (fieldErr) {
                    console.warn(`[QLIK_TOOLS] Warning: Could not fetch details for field ${f.qName}:`, fieldErr.message);
                }

                fields.push({
                    name: f.qName,
                    tags: f.qTags || [],
                    isKey: f.qKeyType !== 'NOT_KEY' && f.qKeyType !== 0,
                    distinctCount: cardinal,
                    sampleValues: samples
                });
            }

            metadata.tables[t.qName] = {
                rowCount: t.qNoOfRows,
                fields: fields
            };
        }

        return metadata;
    } catch (err) {
        console.error("[QLIK_TOOLS] getLiveMetadata error:", err);
        return { error: err.message };
    }
}

/**
 * Formats dense metadata object into a concise Markdown table for LLM consumption.
 */
function formatMetadataAsMarkdown(metadata) {
    if (!metadata || metadata.error) return "Error: No metadata available.";

    let md = "| Table | Field | Distinct | Tags | Samples |\n";
    md += "| :--- | :--- | :--- | :--- | :--- |\n";

    for (const [tableName, tableInfo] of Object.entries(metadata.tables)) {
        for (const field of tableInfo.fields) {
            const tags = (field.tags || []).join(', ');
            // Truncate samples to save tokens
            const samples = (field.sampleValues || [])
                .map(v => String(v).substring(0, 20)) // Limit individual sample length
                .slice(0, 3) // Limit number of samples
                .join(', ');
            
            md += `| ${tableName} | ${field.name} | ${field.distinctCount} | ${tags} | ${samples} |\n`;
        }
    }

    if (metadata.syntheticKeys && metadata.syntheticKeys.length > 0) {
        md += `\n**Synthetic Keys Detected:** ${metadata.syntheticKeys.join(', ')}\n`;
    }

    return md;
}

module.exports = {
    openSession,
    openSessionForApp,
    closeSession,
    profileData,
    profileNativeRelationships,
    validateScript,
    createConnection,
    createPersistentApp,
    getEngineMetrics,
    getLiveMetadata,
    formatMetadataAsMarkdown
};
