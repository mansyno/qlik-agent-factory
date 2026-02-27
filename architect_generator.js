const path = require('path');

/**
 * Step 8: Deterministic QVS Script Generator
 * Converts JSON structural directives into physical Qlik Load Script syntax.
 */
function generateQvsScript(directives, normalizedData, sourceDirectory, fastLoad = true) {
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

    const bridgeScripts = [];

    directives.forEach(directive => {
        const tableName = directive.tableName;
        const normalizedFields = tableLookup[tableName];

        if (!normalizedFields) {
            console.warn(`[Generator] Warning: No normalized fields found for table ${tableName}. Skipping.`);
            return;
        }

        // 1. Build the LOAD statement mapping Original -> Normalized
        script += `\n// --- Table: ${tableName} ---\n`;
        if (directive.notes) {
            script += `// Notes: ${directive.notes}\n`;
        }

        // Fast-load validation mechanism
        if (fastLoad) {
            script += `FIRST 1\n`;
        }

        script += `[${tableName}]:\nLOAD\n`;

        const fieldLines = normalizedFields.map(f => {
            // If the original and normalized name are identical, just load it, else alias it
            if (f.originalName === f.normalizedName) {
                return `    "${f.originalName}"`;
            } else {
                return `    "${f.originalName}" AS "${f.normalizedName}"`;
            }
        });

        script += fieldLines.join(',\n') + '\n';

        // Ensure source directory doesn't have a trailing slash for pure concatenation
        const safeDir = sourceDirectory.replace(/\/$/, '').replace(/\\$/, '');

        // Qlik Engine requires a predefined connection (lib://) to read from disk files.
        // We assume the host application has created a connection named 'SourceData' pointing to the target folder.
        script += `FROM [lib://SourceData/${tableName}.csv]\n(txt, utf8, embedded labels, delimiter is ',', msq);\n`;

        // 2. Handle Canonical Date Bridges
        if (directive.requiresDateBridge && directive.dateFieldsToBridge && directive.dateFieldsToBridge.length > 0) {
            // Look up the exact normalized name intended to be the 'CommonKey' (usually the primary key of this header fact)
            // Heuristic: Find a field ending in 'Key' that matches the table base name, or take the first field ending in Key.
            let commonKey = normalizedFields.find(f => f.normalizedName.toLowerCase().includes(tableName.toLowerCase().replace(/s$/, '') + 'key'))?.normalizedName;
            if (!commonKey) commonKey = normalizedFields.find(f => f.normalizedName.toLowerCase().endsWith('key'))?.normalizedName;
            if (!commonKey) commonKey = normalizedFields[0].normalizedName; // Fallback

            let bridgeCode = `\n// --- Canonical Date Bridge for ${tableName} ---\n`;
            bridgeCode += `[CanonicalDateBridge_${tableName}]:\n`;

            directive.dateFieldsToBridge.forEach((dateField, index) => {
                // Find normalized name for the date field
                const normDateObj = normalizedFields.find(f => f.originalName === dateField || f.normalizedName === dateField);
                const normDateStr = normDateObj ? normDateObj.normalizedName : dateField;

                if (index > 0) bridgeCode += `CONCATENATE([CanonicalDateBridge_${tableName}])\n`;

                // Note: Resident load does not use FIRST 1, it reads what was already loaded.
                bridgeCode += `LOAD \n`;
                // FIX: Instead of mapping to '%CanonicalKey', we MUST load the commonKey identical to the table, forcing a Qlik association
                bridgeCode += `    "${commonKey}",\n`;
                bridgeCode += `    '${dateField}' AS "DateType",\n`;

                // We must read the NORMALIZED name from the Resident table, because we just aliased it in the LOAD above.
                bridgeCode += `    "${normDateStr}" AS "CanonicalDate"\n`;
                bridgeCode += `RESIDENT [${tableName}];\n`;
            });

            bridgeScripts.push(bridgeCode);
        }
    });

    // Append bridge scripts at the end
    script += bridgeScripts.join('\n');

    return script;
}

module.exports = { generateQvsScript };
