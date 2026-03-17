const path = require('path');
const logger = require('./.agent/utils/logger.js');

/**
 * Step 8: Deterministic QVS Script Generator (Pre-Concatenation Refactor)
 * Converts structural directives into Qlik Load Script.
 * 
 * DESIGN PRINCIPLE:
 * No special logic for "Groups". If multiple directives share a tableName, 
 * Qlik will naturally concatenate them as long as the field structure is identical.
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

    const tableLookup = {};
    normalizedData.forEach(t => {
        tableLookup[t.tableName] = t;
    });

    const isLinkTable = structuralBlueprint && structuralBlueprint.strategy === 'LINK_TABLE';
    const sharedKeysSet = new Set();
    const linkBlueprint = structuralBlueprint && structuralBlueprint.linkTableBlueprint;
    if (isLinkTable && linkBlueprint && linkBlueprint.sharedKeys) {
        linkBlueprint.sharedKeys.forEach(k => sharedKeysSet.add(k));
    }

    const factTableNames = new Set();
    if (structuralBlueprint && structuralBlueprint.factTables) {
        structuralBlueprint.factTables.forEach(ft => factTableNames.add(ft.tableName));
    }

    directives.forEach(directive => {
        const targetTableName = directive.tableName;
        const tableInfo = tableLookup[targetTableName];
        
        if (!tableInfo) {
            logger.warn('Generator', `No metadata found for table ${targetTableName}. Skipping.`);
            return;
        }
        
        const canonicalFields = tableInfo.normalizedFields;
        const physicalFields = new Set(directive.originalFields || tableInfo.originalFields || []);
        const originalFileName = directive.originalFileName || tableInfo.originalFileName || `${targetTableName}.csv`;
        const physicalSource = directive.sourceTableName || targetTableName;
        const isFactTable = factTableNames.has(targetTableName);

        script += `\n// --- Table: ${targetTableName} ---\n`;
        if (directive.notes) script += `// Notes: ${directive.notes}\n`;
        if (fastLoad) script += `FIRST 1\n`;

        // 1. Label Table
        script += `[${targetTableName}]:\nLOAD\n`;
        
        const fieldLines = [];
        if (directive.isConcatenated) {
            fieldLines.push(`    '${physicalSource}' AS [%${targetTableName}_SourceTable]`);
        }

        // 2. Link Table Key Logic
        if (isLinkTable && isFactTable) {
            const keyName = `%Key_${targetTableName}`;
            const grainFields = (directive.notes || "").includes("Grain:") 
                ? directive.notes.split("Grain:")[1].split(",").map(g => g.trim())
                : [];

            if (grainFields.length > 0) {
                const hashComponents = grainFields.map(gf => `[${gf}]`).join(` & '|' & `);
                fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS [${keyName}]`);
            } else {
                const ids = canonicalFields.filter(f => f.type === 'IDENTIFIER');
                if (ids.length > 0) {
                    const hashComponents = ids.map(f => `[${f.originalName}]`).join(` & '|' & `);
                    fieldLines.push(`    AutoNumber(Hash128(${hashComponents})) AS [${keyName}]`);
                }
            }
        }

        // 3. Universal Field Mapping (Canonical vs Physical)
        canonicalFields.forEach(cf => {
            const hasLocal = physicalFields.has(cf.originalName);
            
            if (hasLocal) {
                if (cf.originalName === cf.normalizedName) {
                    fieldLines.push(`    [${cf.originalName}]`);
                } else {
                    fieldLines.push(`    [${cf.originalName}] AS [${cf.normalizedName}]`);
                }
            } else {
                // Null padding for fields present in other table members but not this file
                fieldLines.push(`    Null() AS [${cf.normalizedName}]`);
            }
        });

        script += fieldLines.join(',\n');
        script += `\nFROM [lib://SourceData/${originalFileName}]\n(txt, utf8, embedded labels, delimiter is ',', msq);\n`;
    });

    // --- Generate Centralized Link Table ---
    if (isLinkTable) {
        script += `\n// --- Centralized Link Table ---\n`;
        script += `[LinkTable]:\n`;

        let isFirstFact = true;
        factTableNames.forEach(factName => {
            const tableInfo = tableLookup[factName];
            if (!tableInfo) return;

            const tableNorms = tableInfo.normalizedFields;
            const hasSharedKeys = tableNorms.some(f => sharedKeysSet.has(f.normalizedName));
            if (!hasSharedKeys) return;

            if (!isFirstFact) script += `CONCATENATE([LinkTable])\n`;
            
            script += `LOAD\n`;
            const linkFieldLines = [
                `    '${factName}' AS [%LinkTable_SourceTable]`,
                `    [%Key_${factName}] AS [%Key_${factName}]`,
                `    [%Key_${factName}] AS [%DateBridgeKey]`
            ];

            sharedKeysSet.forEach(sharedKey => {
                const fieldInfo = tableNorms.find(f => f.normalizedName === sharedKey);
                if (fieldInfo) {
                    linkFieldLines.push(`    [${sharedKey}] AS [${sharedKey}]`);
                }
            });

            script += linkFieldLines.join(',\n') + '\n';
            script += `RESIDENT [${factName}];\n\n`;

            isFirstFact = false;
        });

        // Drop the shared keys from the original facts
        factTableNames.forEach(factName => {
            const tableInfo = tableLookup[factName];
            if (!tableInfo) return;
            tableInfo.normalizedFields.forEach(f => {
                if (sharedKeysSet.has(f.normalizedName)) {
                    script += `DROP FIELD [${f.normalizedName}] FROM [${factName}];\n`;
                }
            });
        });
    }

    // --- Canonical Date Bridge & Master Calendar ---
    const factDates = structuralBlueprint && structuralBlueprint.dates 
        ? structuralBlueprint.dates.filter(d => d.isFactTable) 
        : [];

    if (structuralBlueprint && structuralBlueprint.dateBridgeRequired && factDates.length > 0) {
        script += `\n// --- Canonical Date Bridge ---\n`;
        script += `[CanonicalDateBridge]:\n`;

        let isFirstDate = true;
        factDates.forEach(d => {
            if (!isFirstDate) script += `CONCATENATE([CanonicalDateBridge])\n`;
            script += `LOAD\n`;
            script += `    '${d.tableName}' AS [%CanonicalDateBridge_SourceTable],\n`;
            script += `    [%Key_${d.tableName}] AS [%DateBridgeKey],\n`;
            script += `    [${d.fieldName}] AS [CanonicalDate],\n`;
            script += `    '${d.fieldName}' AS [DateType]\n`;
            script += `RESIDENT [LinkTable]\nWHERE NOT IsNull([%Key_${d.tableName}]);\n\n`;
            isFirstDate = false;
        });

        script += `\n// --- Master Calendar ---\n`;
        script += `[MasterCalendar]:\n`;
        script += `LOAD\n`;
        script += `    [CanonicalDate],\n`;
        script += `    Year([CanonicalDate]) AS [Year],\n`;
        script += `    'Q' & Ceil(Month([CanonicalDate])/3) AS [Quarter],\n`;
        script += `    Month([CanonicalDate]) AS [Month],\n`;
        script += `    Date(MonthStart([CanonicalDate]), 'MMM-YYYY') AS [MonthYear],\n`;
        script += `    Week([CanonicalDate]) AS [Week],\n`;
        script += `    Day([CanonicalDate]) AS [Day],\n`;
        script += `    WeekDay([CanonicalDate]) AS [WeekDay],\n`;
        script += `    // --- Relative Time Deltas (Added for Set Analysis) ---\n`;
        script += `    [CanonicalDate] - Today() AS [Date Diff],\n`;
        script += `    ((Year([CanonicalDate]) - Year(Today())) * 52) + (If(Num(Month([CanonicalDate])) = '1' And Week([CanonicalDate]) > 5, 0, Week([CanonicalDate])) - If(Num(Month(Today())) = '1' And Week(Today()) > 5, 0, Week(Today()))) AS [Week Diff],\n`;
        script += `    ((Year([CanonicalDate]) - Year(Today())) * 12) + (Month([CanonicalDate]) - Month(Today())) AS [Month Diff],\n`;
        script += `    ((Year([CanonicalDate]) - Year(Today())) * 4) + (Ceil(Num(Month([CanonicalDate])) / 3) - Ceil(Num(Month(Today())) / 3)) AS [Qtr Diff],\n`;
        script += `    Year([CanonicalDate]) - Year(Today()) AS [Year Diff]\n`;
        script += `RESIDENT [CanonicalDateBridge];\n`;
    }

    return script;
}

module.exports = { generateQvsScript };
