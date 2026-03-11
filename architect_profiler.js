const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const MAX_DISTINCT_VALUES = 100000; // Cap to prevent memory explosion

/**
 * Step 1: Deterministic Data Profiler
 * Reads CSVs locally using streams and builds comprehensive statistics for AI Model mapping.
 */
async function profileAllData(dataDir, files, engineMetrics = {}) {
    console.log(`[Profiler] Starting local CSV profiling for ${files.length} tables...`);
    const metadata = { tables: {}, relationships: { overlap: [], subsets: [] } };
    const globalFieldValues = {}; // fieldName -> Set of values (for cross-table overlap)

    for (const file of files) {
        const filePath = path.join(dataDir, file);
        const tableName = path.basename(file, path.extname(file)).replace(/\W/g, '_');
        console.log(`[Profiler] Scanning table: ${tableName}`);
        
        try {
            const tableStats = await scanTable(filePath);
            tableStats.tableName = tableName;

            // Merge Engine-Native Metrics (Memory, Symbol counts)
            if (engineMetrics[tableName]) {
                tableStats.engineMetrics = engineMetrics[tableName];
                const mem = tableStats.engineMetrics.memorySize || 0;
                console.log(`  Merged Engine Metrics for ${tableName}: ${Math.round(mem / 1024)} KB`);
            }

            metadata.tables[tableName] = tableStats;

            // Store distincts for relational metrics
            Object.keys(tableStats.fields).forEach(fieldName => {
                const uniqueKey = `${tableName}.${fieldName}`;
                globalFieldValues[uniqueKey] = tableStats.fields[fieldName]._distinctSet;
                // Delete the actual Set from the final output to avoid massive JSON dumps
                delete tableStats.fields[fieldName]._distinctSet;
            });
            
        } catch (err) {
            console.error(`[Profiler] Error scanning ${tableName}:`, err);
        }
    }

    console.log(`[Profiler] Calculating cross-table relational metrics...`);
    calculateRelationalMetrics(metadata, globalFieldValues);
    
    return { success: true, metadata };
}

function scanTable(filePath) {
    return new Promise((resolve, reject) => {
        let rowCount = 0;
        let columnCount = 0;
        let totalCells = 0;
        let nonNullCells = 0;
        const fields = {};

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('headers', (headers) => {
                columnCount = headers.length;
                headers.forEach(h => {
                    fields[h] = {
                        name: h,
                        nullCount: 0,
                        blankCount: 0,
                        distinctCount: 0,
                        minLength: Infinity,
                        maxLength: 0,
                        sumLength: 0,
                        minNumeric: Infinity,
                        maxNumeric: -Infinity,
                        isNumeric: true,
                        _distinctSet: new Set()
                    };
                });
            })
            .on('data', (row) => {
                rowCount++;
                totalCells += columnCount;
                
                Object.keys(fields).forEach(col => {
                    const val = row[col];
                    const f = fields[col];
                    
                    if (val === undefined || val === null || val === '') {
                        f.nullCount++;
                    } else {
                        nonNullCells++;
                        const strVal = String(val);
                        
                        // Blanks (whitespace only)
                        if (strVal.trim().length === 0) f.blankCount++;
                        
                        // Length stats
                        const len = strVal.length;
                        if (len < f.minLength) f.minLength = len;
                        if (len > f.maxLength) f.maxLength = len;
                        f.sumLength += len;
                        
                        // Distincts
                        if (f._distinctSet.size < MAX_DISTINCT_VALUES) {
                            f._distinctSet.add(strVal);
                        }
                        
                        // Numeric check
                        if (f.isNumeric) {
                            const num = Number(strVal);
                            if (isNaN(num)) {
                                f.isNumeric = false;
                                f.minNumeric = null;
                                f.maxNumeric = null;
                            } else {
                                if (num < f.minNumeric) f.minNumeric = num;
                                if (num > f.maxNumeric) f.maxNumeric = num;
                            }
                        }
                    }
                });
            })
            .on('end', () => {
                // Finalize stats
                Object.keys(fields).forEach(col => {
                    const f = fields[col];
                    f.distinctCount = f._distinctSet.size;
                    f.nullPercentage = rowCount === 0 ? 0 : parseFloat(((f.nullCount / rowCount) * 100).toFixed(2));
                    f.avgLength = (rowCount - f.nullCount) === 0 ? 0 : parseFloat((f.sumLength / (rowCount - f.nullCount)).toFixed(2));
                    f.uniquenessRatio = (rowCount - f.nullCount) === 0 ? 0 : parseFloat((f.distinctCount / (rowCount - f.nullCount)).toFixed(4));
                    if (f.minLength === Infinity) f.minLength = 0;
                    
                    delete f.sumLength; // cleanup
                });
                
                resolve({
                    rowCount,
                    columnCount,
                    tableDensity: totalCells === 0 ? 0 : parseFloat(((nonNullCells / totalCells) * 100).toFixed(2)),
                    fields
                });
            })
            .on('error', reject);
    });
}

/**
 * Compares distinct values across all tables to find exact overlaps and subset relationships.
 */
function calculateRelationalMetrics(metadata, globalFieldValues) {
    const fieldKeys = Object.keys(globalFieldValues);
    
    for (let i = 0; i < fieldKeys.length; i++) {
        for (let j = i + 1; j < fieldKeys.length; j++) {
            const keyA = fieldKeys[i];
            const keyB = fieldKeys[j];
            
            const [tableA, colA] = keyA.split('.');
            const [tableB, colB] = keyB.split('.');
            
            const setA = globalFieldValues[keyA];
            const setB = globalFieldValues[keyB];
            
            if (setA.size === 0 || setB.size === 0) continue;
            
            // Optimization: Only check fields with similar names, substring inclusions, or identifiers
            const nameLowerA = colA.toLowerCase().replace(/[\s_]/g, '');
            const nameLowerB = colB.toLowerCase().replace(/[\s_]/g, '');
            const nameMatch = nameLowerA === nameLowerB || nameLowerA.includes(nameLowerB) || nameLowerB.includes(nameLowerA);
            const isIdentifier = /(id|key|code|num|number)/i.test(colA) && /(id|key|code|num|number)/i.test(colB);
                                 
            if (!nameMatch && !isIdentifier) continue;

            let intersectionCount = 0;
            const smallerSet = setA.size < setB.size ? setA : setB;
            const largerSet = setA.size < setB.size ? setB : setA;
            
            for (const val of smallerSet) {
                if (largerSet.has(val)) intersectionCount++;
            }
            
            if (intersectionCount === 0) continue;
            
            const overlapA = intersectionCount / setA.size;
            const overlapB = intersectionCount / setB.size;
            
            if (overlapA > 0.1 || overlapB > 0.1) {
                metadata.relationships.overlap.push({
                    fieldA: keyA,
                    fieldB: keyB,
                    intersectionCount,
                    overlapRatioA: parseFloat(overlapA.toFixed(4)),
                    overlapRatioB: parseFloat(overlapB.toFixed(4))
                });
            }
            
            // Subset detection (one set is almost perfectly contained in another)
            if (overlapA >= 0.95 && setA.size < setB.size) {
                metadata.relationships.subsets.push({ subset: keyA, superset: keyB });
            } else if (overlapB >= 0.95 && setB.size < setA.size) {
                metadata.relationships.subsets.push({ subset: keyB, superset: keyA });
            }
        }
    }
}

module.exports = {
    profileAllData
};
