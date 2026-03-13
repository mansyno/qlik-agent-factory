const path = require('path');

/**
 * Step 8: Deterministic QVS Script Generator
 * Converts JSON structural directives into physical Qlik Load Script syntax.
 *
 * @param {Array} directives - Phase B output (per-table load instructions)
 * @param {Array} normalizedData - Step 2 output (field name mappings)
 * @param {string} sourceDirectory - Path to CSV source files
 * @param {object} structuralBlueprint - Phase A output (fact/dim/link table blueprint)
 * @param {boolean} fastLoad - If true, loads only FIRST 1 row for validation
 */
function generateQvsScript(directives, normalizedData, sourceDirectory, structuralBlueprint = null, fastLoad = true) {
    let script = `
///$tab Main
SET ThousandSep=',';
SET DecimalSep='.';
SET MoneyThousandSep=',';
SET MoneyDecimalSep='.';
SET MoneyFormat='$#,##0.00;-$#,##0.00';
SET TimeFormat='h:mm:ss TT';
SET DateFormat='M/D/YYYY';
SET TimestampFormat='M/D/YYYY h:mm:ss[.fff] TT';
SET FirstWeekDay=6;
SET BrokenWeeks=1;
SET ReferenceDay=0;
SET FirstMonthOfYear=1;
SET CollationLocale='en-US';
SET CreateSearchIndexOnReload=1;
SET MonthNames='Jan;Feb;Mar;Apr;May;Jun;Jul;Aug;Sep;Oct;Nov;Dec';
SET LongMonthNames='January;February;March;April;May;June;July;August;September;October;November;December';
SET DayNames='Mon;Tue;Wed;Thu;Fri;Sat;Sun';
SET LongDayNames='Monday;Tuesday;Wednesday;Thursday;Friday;Saturday;Sunday';
SET NumericalAbbreviation='3:k;6:M;9:G;12:T;15:P;18:E;21:Z;24:Y;-3:m;-6:μ;-9:n;-12:p;-15:f;-18:a;-21:z;-24:y';

///$tab Auto Architect Load
`;

    // Extract table definitions for fast lookup
    const tableLookup = {};
    normalizedData.forEach(t => {
        tableLookup[t.tableName] = {
            fields: t.normalizedFields,
            originalFileName: t.originalFileName
        };
    });

    const isLinkTable = structuralBlueprint && structuralBlueprint.strategy === 'LINK_TABLE';
    const factGroups = (structuralBlueprint && structuralBlueprint.factGroups) || [];
    const isConcat = structuralBlueprint && structuralBlueprint.strategy === 'CONCATENATE' || factGroups.length > 0;
    // MULTI_FACT_STAR: multiple facts but no link table needed — treat each fact as a standard table
    const isMultiFactStar = structuralBlueprint && structuralBlueprint.strategy === 'MULTI_FACT_STAR';

    // Build sets for Link Table shared keys
    const sharedKeysSet = new Set();
    const linkBlueprint = structuralBlueprint && structuralBlueprint.linkTableBlueprint;
    if (isLinkTable && linkBlueprint && linkBlueprint.sharedKeys) {
        linkBlueprint.sharedKeys.forEach(k => sharedKeysSet.add(k));
    }

    const factTableNames = new Set();
    if (structuralBlueprint && structuralBlueprint.factTables) {
        structuralBlueprint.factTables.forEach(ft => factTableNames.add(ft.tableName));
    }

    // For CONCATENATE strategy, we need the union of all fact fields for EACH group
    const groupFieldUnions = {}; // "groupIndex" -> Set of unified field names
    if (isConcat) {
        factGroups.forEach((group, idx) => {
            const union = new Set();
            group.forEach(table => {
                const fields = tableLookup[table] ? tableLookup[table].fields : [];
                fields.forEach(f => union.add(f.normalizedName));
            });
            groupFieldUnions[idx] = union;
        });
    }

    const bridgeScripts = [];

    directives.forEach(directive => {
        const tableName = directive.tableName;
        const tableInfo = tableLookup[tableName];
        
        if (!tableInfo) {
            console.warn(`[Generator] Warning: No normalized fields found for table ${tableName}. Skipping.`);
            return;
        }
        
        const normalizedFields = tableInfo.fields;
        const originalFileName = tableInfo.originalFileName || `${tableName}.csv`;

        const isFactTable = factTableNames.has(tableName);
        const groupIndex = factGroups.findIndex(g => g.includes(tableName));
        const isInGroup = groupIndex !== -1;
        const consolidatedName = isInGroup 
            ? (factGroups.length > 1 ? `Consolidated_Fact_${groupIndex + 1}` : `Consolidated_Fact`)
            : null;

        script += `\n// --- Table: ${tableName} ---\n`;
        if (directive.notes) script += `// Notes: ${directive.notes}\n`;
        if (fastLoad) script += `FIRST 1\n`;

        // If concatenating, label all facts in group as [Consolidated_Fact_X]
        if (isInGroup) {
            const isFirstInGroup = factGroups[groupIndex][0] === tableName;
            if (!isFirstInGroup) script += `CONCATENATE([${consolidatedName}])\n`;
            script += `[${consolidatedName}]:\nLOAD\n`;
        } else {
            script += `[${tableName}]:\nLOAD\n`;
        }

        const fieldLines = [];
        let mappingDone = false;

        // Universal Fact ID (needed for Date Bridging in some modes)
        // In LINK_TABLE mode, each fact already has a unique %Key_<TableName> composite key
        if (isFactTable && isConcat) {
            fieldLines.push(`    AutoNumber(RowNo() & '|' & '${tableName}') AS [%FactID]`);
        }

        // Concatenation Logic
        if (isInGroup) {
            mappingDone = true;
            // Add Source Table tracker
            fieldLines.push(`    '${tableName}' AS [%SourceTable]`);

            // Check every field in the group union
            const groupUnion = groupFieldUnions[groupIndex];
            groupUnion.forEach(globalField => {
                const localFieldObj = normalizedFields.find(f => f.normalizedName === globalField);
                const isSharedKey = sharedKeysSet.has(globalField);
                const cleanNorm = globalField.replace(/[\[\]]/g, '');

                if (localFieldObj) {
                    // In LinkTable mode, shared keys MUST be prefixed to isolate fact resident load from dimension tables.
                    if (isLinkTable && isSharedKey) {
                        fieldLines.push(`    [${localFieldObj.originalName}] AS [${consolidatedName}_${cleanNorm}]`);
                    } else if (localFieldObj.originalName === globalField) {
                        fieldLines.push(`    [${localFieldObj.originalName}]`);
                    } else {
                        fieldLines.push(`    [${localFieldObj.originalName}] AS [${globalField}]`);
                    }
                } else {
                    // Padding for missing fields in this specific group table
                    // THIS IS CRITICAL: If this is a shared key, we MUST use the prefixed name even for Null() 
                    // otherwise it will collide with dimensions and create synthetic keys.
                    if (isLinkTable && isSharedKey) {
                        fieldLines.push(`    Null() AS [${consolidatedName}_${cleanNorm}]`);
                    } else {
                        fieldLines.push(`    Null() AS [${globalField}]`);
                    }
                }
            });
        }

        // Link Table Logic: Each fact gets a deterministic composite key for bridging
        if (isLinkTable && isFactTable) {
            const keyName = isInGroup 
                ? `%Key_${consolidatedName}`
                : `%Key_${tableName}`;

            const grainFields = (directive.notes || "").includes("Grain:") 
                ? directive.notes.split("Grain:")[1].split(",").map(g => g.trim())
                : [];

            if (grainFields.length > 0) {
                const hashComponents = grainFields.map(gf => `[${gf}]`).join(` & '|' & `);
                fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS [${keyName}]`);
            } else {
                // Fallback to identifiers if grain is missing
                const ids = normalizedFields.filter(f => f.type === 'IDENTIFIER');
                if (ids.length > 0) {
                    const hashComponents = ids.map(f => `[${f.originalName}]`).join(` & '|' & `);
                    fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS [${keyName}]`);
                }
            }

            if (!mappingDone) {
                mappingDone = true;
                normalizedFields.forEach(f => {
                    const isSharedKey = sharedKeysSet.has(f.normalizedName);
                    if (isSharedKey) {
                        const cleanNorm = f.normalizedName.replace(/[\[\]]/g, '');
                        fieldLines.push(`    [${f.originalName}] AS [${tableName}_${cleanNorm}]`);
                    } else if (f.originalName === f.normalizedName) {
                        fieldLines.push(`    [${f.originalName}]`);
                    } else {
                        const cleanNorm = f.normalizedName.replace(/[\[\]]/g, '');
                        fieldLines.push(`    [${f.originalName}] AS [${cleanNorm}]`);
                    }
                });
            }
        }
        // Standard Dims / References
        if (!mappingDone) {
            normalizedFields.forEach(f => {
                if (f.originalName === f.normalizedName) {
                    fieldLines.push(`    [${f.originalName}]`);
                } else {
                    const cleanNorm = f.normalizedName.replace(/[\[\]]/g, '');
                    fieldLines.push(`    [${f.originalName}] AS [${cleanNorm}]`);
                }
            });
        }

        script += fieldLines.join(',\n') + '\n';
        script += `FROM [lib://SourceData/${originalFileName}]\n(txt, utf8, embedded labels, delimiter is ',', msq);\n`;
    });

    // --- Generate the Centralized Link Table ---
    if (isLinkTable) {
        script += `\n// --- Centralized Link Table ---\n`;
        script += `// Bridges Fact tables through shared dimension keys to prevent Synthetic Keys.\n`;

        const factTablesToBridge = [...factTableNames];
        const processedGroups = new Set();
        let isFirstFact = true;

        factTablesToBridge.forEach(factName => {
            const groupIndex = factGroups.findIndex(g => g.includes(factName));
            const consolidatedName = groupIndex !== -1 
                ? (factGroups.length > 1 ? `Consolidated_Fact_${groupIndex + 1}` : `Consolidated_Fact`)
                : factName;
            
            if (groupIndex !== -1 && processedGroups.has(groupIndex)) return;
            if (groupIndex !== -1) processedGroups.add(groupIndex);

            const tableInfo = tableLookup[factName];
            if (!tableInfo) return;
            const tableNorms = tableInfo.fields;

            const hasSharedKeys = tableNorms.some(f => sharedKeysSet.has(f.normalizedName));
            if (!hasSharedKeys) return;

            if (!isFirstFact) script += `CONCATENATE([LinkTable])\n`;
            if (isFirstFact) script += `[LinkTable]:\n`;

            script += `LOAD\n`;
            const linkFieldLines = [
                `    [%Key_${consolidatedName}] AS [%Key_${consolidatedName}]`, // Use consolidated key
                `    [%Key_${consolidatedName}] AS [%DateBridgeKey]`,
                `    '${consolidatedName}' AS [%SourceTable]`
            ];

            sharedKeysSet.forEach(sharedKey => {
                const hasField = tableNorms.find(f => f.normalizedName === sharedKey);
                if (hasField) {
                    const cleanNorm = sharedKey.replace(/[\[\]]/g, '');
                    const sourceFieldName = `${consolidatedName}_${cleanNorm}`;
                    linkFieldLines.push(`    [${sourceFieldName}] AS [${sharedKey}]`);
                }
            });

            script += linkFieldLines.join(',\n') + '\n';
            script += `RESIDENT [${consolidatedName}];\n\n`;

            isFirstFact = false;
        });

        // Drop the renamed shared keys from the fact tables (isolation)
        // Grouped (Consolidated) Facts
        factGroups.forEach((group, idx) => {
            const cName = factGroups.length > 1 ? `Consolidated_Fact_${idx + 1}` : `Consolidated_Fact`;
            groupFieldUnions[idx].forEach(fieldName => {
                if (sharedKeysSet.has(fieldName)) {
                    const cleanNorm = fieldName.replace(/[\[\]]/g, '');
                    script += `DROP FIELD [${cName}_${cleanNorm}] FROM [${cName}];\n`;
                }
            });
        });

        // Standalone Facts
        factTableNames.forEach(factName => {
            const factIsInGroup = factGroups.some(g => g.includes(factName));
            if (!factIsInGroup) {
                const factInfo = tableLookup[factName];
                if (factInfo) {
                    factInfo.fields.forEach(f => {
                        if (sharedKeysSet.has(f.normalizedName)) {
                            const cleanNorm = f.normalizedName.replace(/[\[\]]/g, '');
                            script += `DROP FIELD [${factName}_${cleanNorm}] FROM [${factName}];\n`;
                        }
                    });
                }
            }
        });
    }

    // --- Canonical Date Bridge ---
    const factDates = structuralBlueprint && structuralBlueprint.dates 
        ? structuralBlueprint.dates.filter(d => d.isFactTable) 
        : [];

    if (structuralBlueprint && structuralBlueprint.dateBridgeRequired && factDates.length > 0) {
        script += `\n// --- Canonical Date Bridge ---\n`;
        script += `// Unifies multiple dates into a single axis for cross-date analysis.\n`;
        script += `[CanonicalDateBridge]:\n`;

        let isFirstDate = true;
        const processedGroupsDate = new Set();
        factDates.forEach(d => {
            const groupIndex = factGroups.findIndex(g => g.includes(d.tableName));
            const consolidatedName = groupIndex !== -1 
                ? (factGroups.length > 1 ? `Consolidated_Fact_${groupIndex + 1}` : `Consolidated_Fact`)
                : d.tableName;

            if (!isFirstDate) script += `CONCATENATE([CanonicalDateBridge])\n`;
            
            script += `LOAD\n`;
            if (isConcat || isMultiFactStar) {
                // No composite key available — use RowNo as a bridge key
                script += `    AutoNumber(RowNo() & '|' & '${d.tableName}') AS [%FactKey_${d.tableName}],\n`;
            } else {
                // LINK_TABLE mode: bridge connects to LinkTable using unified key
                const keyName = groupIndex !== -1 
                    ? (factGroups.length > 1 ? `%Key_Consolidated_Fact_${groupIndex + 1}` : `%Key_Consolidated_Fact`)
                    : `%Key_${d.tableName}`;
                script += `    [${keyName}] AS [%DateBridgeKey],\n`;
            }
            
            script += `    [${d.fieldName}] AS [CanonicalDate],\n`;
            script += `    '${d.fieldName}' AS [DateType]\n`;
            script += `RESIDENT [${consolidatedName}];\n\n`;
            
            isFirstDate = false;
        });

        // Add Master Calendar for the Canonical Date axis
        script += `\n// --- Master Calendar ---\n`;
        script += `[MasterCalendar]:\n`;
        script += `LOAD\n`;
        script += `    [CanonicalDate],\n`;
        script += `    Year([CanonicalDate]) AS [Year],\n`;
        script += `    Month([CanonicalDate]) AS [Month],\n`;
        script += `    Day([CanonicalDate]) AS [Day],\n`;
        script += `    'Q' & Ceil(Month([CanonicalDate])/3) AS [Quarter]\n`;
        script += `RESIDENT [CanonicalDateBridge];\n`;
    }
    return script;
}

module.exports = { generateQvsScript };

