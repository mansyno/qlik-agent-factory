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
        tableLookup[t.tableName] = t.normalizedFields;
    });

    const isLinkTable = structuralBlueprint && structuralBlueprint.strategy === 'LINK_TABLE';
    const isConcat = structuralBlueprint && structuralBlueprint.strategy === 'CONCATENATE';
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

    // For CONCATENATE strategy, we need the union of all fact fields to pad missing ones with Null()
    const allFactFields = new Set();
    if (isConcat) {
        factTableNames.forEach(ft => {
            const fields = tableLookup[ft] || [];
            fields.forEach(f => allFactFields.add(f.normalizedName));
        });
    }

    const bridgeScripts = [];

    directives.forEach(directive => {
        const tableName = directive.tableName;
        const normalizedFields = tableLookup[tableName];

        if (!normalizedFields) {
            console.warn(`[Generator] Warning: No normalized fields found for table ${tableName}. Skipping.`);
            return;
        }

        const isFactTable = factTableNames.has(tableName);

        script += `\n// --- Table: ${tableName} ---\n`;
        if (directive.notes) script += `// Notes: ${directive.notes}\n`;
        if (fastLoad) script += `FIRST 1\n`;

        // If concatenating, label all facts as [Consolidated_Fact]
        if (isConcat && isFactTable) {
            script += `[Consolidated_Fact]:\nLOAD\n`;
        } else {
            script += `[${tableName}]:\nLOAD\n`;
        }

        const fieldLines = [];

        // Universal Fact ID for Date Bridging (only needed in CONCATENATE mode)
        // In LINK_TABLE mode, each fact already has a unique %Key_<TableName> composite key
        if (isFactTable && isConcat) {
            fieldLines.push(`    AutoNumber(RowNo() & '|' & '${tableName}') AS "%FactID"`);
        }

        // Implicit Concatenation Logic
        if (isConcat && isFactTable) {
            // Add Source Table tracker
            fieldLines.push(`    '${tableName}' AS "%SourceTable"`);

            // Check every field in the universal union
            allFactFields.forEach(globalField => {
                const localFieldObj = normalizedFields.find(f => f.normalizedName === globalField);
                if (localFieldObj) {
                    // Field exists in this table
                    if (localFieldObj.originalName === localFieldObj.normalizedName) {
                        fieldLines.push(`    "${localFieldObj.originalName}"`);
                    } else {
                        fieldLines.push(`    "${localFieldObj.originalName}" AS "${localFieldObj.normalizedName}"`);
                    }
                } else {
                    // Implicit Concatenation requires identical fields. Pad with Null().
                    fieldLines.push(`    Null() AS "${globalField}"`);
                }
            });
        }
        // Link Table Logic: Each fact gets a deterministic composite key for bridging
        else if (isLinkTable && isFactTable) {
            const grainFields = (directive.notes || "").includes("Grain:") 
                ? directive.notes.split("Grain:")[1].split(",").map(g => g.trim())
                : [];

            if (grainFields.length > 0) {
                const hashComponents = grainFields.map(gf => `"${gf}"`).join(` & '|' & `);
                console.log(`[DEBUG] Table ${tableName} Fact Key Hash: ${hashComponents}`);
                fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS "%Key_${tableName}"`);
            } else {
                // Fallback to identifiers if grain is missing
                const ids = normalizedFields.filter(f => f.type === 'IDENTIFIER');
                if (ids.length > 0) {
                    const hashComponents = ids.map(f => `"${f.originalName}"`).join(` & '|' & `);
                    fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS "%Key_${tableName}"`);
                }
            }



            normalizedFields.forEach(f => {
                const isSharedKey = sharedKeysSet.has(f.normalizedName);
                if (isSharedKey) {
                    fieldLines.push(`    "${f.originalName}" AS "${tableName}_${f.normalizedName}"`);
                } else if (f.originalName === f.normalizedName) {
                    fieldLines.push(`    "${f.originalName}"`);
                } else {
                    fieldLines.push(`    "${f.originalName}" AS "${f.normalizedName}"`);
                }
            });
        }
        // Standard Dims / References
        else {
            normalizedFields.forEach(f => {
                if (f.originalName === f.normalizedName) {
                    fieldLines.push(`    "${f.originalName}"`);
                } else {
                    fieldLines.push(`    "${f.originalName}" AS "${f.normalizedName}"`);
                }
            });
        }

        script += fieldLines.join(',\n') + '\n';
        script += `FROM [lib://SourceData/${tableName}.csv]\n(txt, utf8, embedded labels, delimiter is ',', msq);\n`;
    });

    // --- Generate the Centralized Link Table ---
    if (isLinkTable) {
        script += `\n// --- Centralized Link Table ---\n`;
        script += `// Bridges Fact tables through shared dimension keys to prevent Synthetic Keys.\n`;

        const factTablesInBlueprint = Array.from(factTableNames);
        let isFirstFact = true;

        factTablesInBlueprint.forEach(factName => {
            const tableNorms = tableLookup[factName];
            if (!tableNorms) return;

            const hasSharedKeys = tableNorms.some(f => sharedKeysSet.has(f.normalizedName));
            if (!hasSharedKeys) return;

            if (!isFirstFact) script += `CONCATENATE([LinkTable])\n`;
            if (isFirstFact) script += `[LinkTable]:\n`;

            script += `LOAD\n`;
            const linkFieldLines = [
                `    "%Key_${factName}"`,
                `    "%Key_${factName}" AS "%DateBridgeKey"`,
                `    '${factName}' AS "%SourceTable"`
            ];

            sharedKeysSet.forEach(sharedKey => {
                const hasField = tableNorms.find(f => f.normalizedName === sharedKey);
                if (hasField) {
                    linkFieldLines.push(`    "${factName}_${sharedKey}" AS "${sharedKey}"`);
                }
            });

            script += linkFieldLines.join(',\n') + '\n';
            script += `RESIDENT [${factName}];\n\n`;

            isFirstFact = false;
        });

        // Drop the renamed shared keys from the local facts (only if they existed)
        factTablesInBlueprint.forEach(factName => {
            const tableNorms = tableLookup[factName] || [];
            
            sharedKeysSet.forEach(sharedKey => {
                const hasField = tableNorms.find(f => f.normalizedName === sharedKey);
                if (hasField) {
                    script += `DROP FIELD "${factName}_${sharedKey}" FROM [${factName}];\n`;
                }
            });
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
        factDates.forEach(d => {
            if (!isFirstDate) script += `CONCATENATE([CanonicalDateBridge])\n`;
            
            script += `LOAD\n`;
            if (isConcat || isMultiFactStar) {
                // No composite key available — use RowNo as a bridge key
                script += `    AutoNumber(RowNo() & '|' & '${d.tableName}') AS "%FactKey_${d.tableName}",\n`;
            } else {
                // LINK_TABLE mode: bridge connects to LinkTable using unified key to avoid synthetic keys
                script += `    "%Key_${d.tableName}" AS "%DateBridgeKey",\n`;
            }
            
            script += `    "${d.fieldName}" AS "CanonicalDate",\n`;
            script += `    '${d.fieldName}' AS "DateType"\n`;
            script += `RESIDENT [${isConcat ? 'Consolidated_Fact' : d.tableName}];\n\n`;
            
            isFirstDate = false;
        });

        // Add Master Calendar for the Canonical Date axis
        script += `\n// --- Master Calendar ---\n`;
        script += `[MasterCalendar]:\n`;
        script += `LOAD\n`;
        script += `    CanonicalDate,\n`;
        script += `    Year(CanonicalDate) AS "Year",\n`;
        script += `    Month(CanonicalDate) AS "Month",\n`;
        script += `    Day(CanonicalDate) AS "Day",\n`;
        script += `    'Q' & Ceil(Month(CanonicalDate)/3) AS "Quarter"\n`;
        script += `RESIDENT [CanonicalDateBridge];\n`;
    }
    return script;
}

module.exports = { generateQvsScript };

