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

    const commonPrefix = findCommonPrefix(files);
    if (commonPrefix) console.log(`[Profiler] Detected common prefix to strip: "${commonPrefix}"`);

    for (const file of files) {
        const filePath = path.join(dataDir, file);
        const originalName = path.basename(file, path.extname(file));
        const tableName = commonPrefix ? originalName.replace(commonPrefix, '').trim() : originalName;
        
        console.log(`[Profiler] Scanning table: ${tableName} (Source: ${file})`);
        
        try {
            const tableStats = await scanTable(filePath);
            tableStats.tableName = tableName;
            tableStats.originalFileName = file;

            // Merge Engine-Native Metrics (Memory, Symbol counts)
            if (engineMetrics[originalName]) {
                tableStats.engineMetrics = engineMetrics[originalName];
                const mem = tableStats.engineMetrics.memorySize || 0;
                console.log(`  Merged Engine Metrics for ${tableName}: ${Math.round(mem / 1024)} KB`);
            }

            metadata.tables[tableName] = tableStats;

            // Store distincts for relational metrics using the CLEAN tableName
            Object.keys(tableStats.fields).forEach(fieldName => {
                const uniqueKey = `${tableName}.${fieldName}`;
                globalFieldValues[uniqueKey] = tableStats.fields[fieldName]._distinctSet;
                
                // Note: We keep _distinctSet attached for late-binding in the detector,
                // but we will manually clear them after Phase 2 to save memory.
            });
            
        } catch (err) {
            console.error(`[Profiler] Error scanning ${tableName}:`, err);
        }
    }

    console.log(`[Profiler] Calculating initial cross-table relational metrics (Identical/Common names)...`);
    calculateRelationalMetrics(metadata, globalFieldValues);
    
    return { success: true, metadata, globalFieldValues };
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
                        sampleValues: [],
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
                            if (!f._distinctSet.has(strVal) && f.sampleValues.length < 3) {
                                f.sampleValues.push(strVal);
                            }
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
                    f.informationDensity = rowCount === 0 ? 0 : parseFloat(((rowCount - f.nullCount) / rowCount).toFixed(4));
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
            
            const lastDotA = keyA.lastIndexOf('.');
            const lastDotB = keyB.lastIndexOf('.');
            const tableA = keyA.substring(0, lastDotA);
            const colA = keyA.substring(lastDotA + 1);
            const tableB = keyB.substring(0, lastDotB);
            const colB = keyB.substring(lastDotB + 1);
            
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

function findCommonPrefix(files) {
    if (!files || files.length <= 1) return "";
    
    // Sort to easily find the shared prefix between the most different strings
    const sorted = [...files].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    
    let i = 0;
    while (i < first.length && first[i] === last[i]) {
        i++;
    }
    
    const prefix = first.substring(0, i);
    
    // Try to find a logical end for the prefix (space, dash, underscore)
    // so we don't snap "CustomerRecord1" and "CustomerRecord2" to "CustomerRecord"
    const lastSeparator = Math.max(
        prefix.lastIndexOf(' - '),
        prefix.lastIndexOf(' – '),
        prefix.lastIndexOf('_'),
        prefix.lastIndexOf(' ')
    );
    
    if (lastSeparator !== -1) {
        return prefix.substring(0, lastSeparator + 1);
    }
    
    return prefix;
}

module.exports = {
    profileAllData
};
