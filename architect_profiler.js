const path = require('path');
const fs = require('fs');

/**
 * Step 0: Pre-computation Profiling (Backend)
 * Loads all tables into a transient Qlik session app using QUALIFY *
 * and extracts full statistical metadata (Row Count, Distinct %, Null %, Min, Max).
 */
async function profileAllData(global, dataDir, files) {
    let sessionApp;
    try {
        console.log(`[Profiler] Creating transient session app for profiling...`);
        sessionApp = await global.createSessionApp();

        // 1. Create Connection to the raw data directory
        const connectionName = 'SourceData_Profile_' + Date.now();
        await sessionApp.createConnection({
            qName: connectionName,
            qConnectionString: path.resolve(dataDir),
            qType: 'folder'
        });

        // 2. Generate and execute the load script using QUALIFY *
        let loadScript = `QUALIFY *;\n\n`;
        const expectedTables = [];

        for (const file of files) {
            const tableName = path.basename(file, path.extname(file)).replace(/\W/g, '_');
            expectedTables.push(tableName);
            loadScript += `"${tableName}":\nLOAD * FROM [lib://${connectionName}/${file}] (txt, utf8, embedded labels, delimiter is ',', msq);\n\n`;
        }

        console.log(`[Profiler] Setting script with ${files.length} tables and doing reload...`);
        await sessionApp.setScript(loadScript);

        const reloadResult = await sessionApp.doReload();
        if (!reloadResult) {
            return { error: 'Reload failed during profiling phase. Check data format or Qlik engine logs.' };
        }

        // 3. Extract Metadata
        console.log(`[Profiler] Extracting engine metadata...`);
        const tablesInfo = await sessionApp.getTablesAndKeys({}, {}, 0, true, false);

        const metadata = {
            tables: []
        };

        // If there's a synthetic table, fail early (though QUALIFY * makes this near impossible)
        const synTables = tablesInfo.qtr.filter(t => t.qName.startsWith('$Syn'));
        if (synTables.length > 0) {
            return { error: 'Synthetic Keys detected during profiling. This violates Step 0 constraints.' };
        }

        // Iterate through all actual tables
        for (const table of tablesInfo.qtr) {
            const rowCount = table.qNoOfRows;
            const tableMeta = {
                tableName: table.qName,
                rowCount: rowCount,
                fields: []
            };

            for (const field of table.qFields) {
                const physicalFieldName = field.qName;
                // Because of QUALIFY *, physical field is "TableName.FieldName"

                // Create a transient Hypercube to evaluate statistics for this field
                // This is generally faster than chaining multiple evaluateEx calls
                const hcDef = {
                    qInfo: { qType: 'ProfileCube' },
                    qHyperCubeDef: {
                        qDimensions: [],
                        qMeasures: [
                            { qDef: { qDef: `Count(DISTINCT [${physicalFieldName}])` } },
                            { qDef: { qDef: `NullCount([${physicalFieldName}])` } },
                            { qDef: { qDef: `MinString([${physicalFieldName}])` } },
                            { qDef: { qDef: `MaxString([${physicalFieldName}])` } }
                        ],
                        qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 4, qHeight: 1 }]
                    }
                };

                const sessionObj = await sessionApp.createSessionObject(hcDef);
                const layout = await sessionObj.getLayout();

                let distinctCount = 0, nullCount = 0, minVal = null, maxVal = null;

                if (layout.qHyperCube.qDataPages.length > 0 && layout.qHyperCube.qDataPages[0].qMatrix.length > 0) {
                    const rowCells = layout.qHyperCube.qDataPages[0].qMatrix[0];

                    const distinctCountStr = rowCells[0].qText;
                    const nullCountStr = rowCells[1].qText;
                    minVal = rowCells[2].qText === '-' ? null : rowCells[2].qText;
                    maxVal = rowCells[3].qText === '-' ? null : rowCells[3].qText;

                    distinctCount = isNaN(Number(distinctCountStr)) ? 0 : Number(distinctCountStr);
                    nullCount = isNaN(Number(nullCountStr)) ? 0 : Number(nullCountStr);
                }

                const nullPercentage = rowCount === 0 ? 0 : (nullCount / rowCount) * 100;

                // Derive the logical field name by stripping the table prefix
                const logicalFieldName = physicalFieldName.replace(`${table.qName}.`, '');

                tableMeta.fields.push({
                    name: logicalFieldName, // Standard name without qualify prefix for LLM
                    physicalName: physicalFieldName, // qualified name
                    distinctCount: distinctCount,
                    nullPercentage: parseFloat(nullPercentage.toFixed(2)),
                    min: minVal,
                    max: maxVal
                });

                await sessionApp.destroySessionObject(sessionObj.id);
            }

            metadata.tables.push(tableMeta);
        }

        console.log(`[Profiler] Profiling complete for ${metadata.tables.length} tables.`);
        return { success: true, metadata };

    } catch (err) {
        console.error(`[Profiler] Fatal error:`, err);
        return { error: err.message };
    } finally {
        if (sessionApp) {
            try {
                // Ensure we clean up the transient session app
                await sessionApp.global.closeSession(); // Or let caller manage standard close
            } catch (e) { /* ignore */ }
        }
    }
}

module.exports = {
    profileAllData
};
