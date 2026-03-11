/**
 * Phase 2: Classification Module
 * Uses deterministic metrics from the Profiler to categorize schema elements.
 * 
 * Rules:
 * - IDENTIFIER: Only fields with explicit key-naming conventions (ends with ID, KEY, CODE, NUMBER, NUM)
 * - MEASURE: Numeric fields with measure-like names, BUT only promoted to MEASURE if the table
 *   has a transactional profile (contains foreign keys referencing other entities)
 * - DATE: Fields with date/time naming patterns
 * - ATTRIBUTE: Everything else (including statistically unique descriptive fields like City, Region)
 * 
 * Table classification:
 * - FACT: Has confirmed MEASURE fields (post context-guard) AND foreign keys, OR very high row count with FKs
 * - DIMENSION: Everything else
 * 
 * Grain output:
 * - Structured object with primaryKey[], foreignKeys[], grainFields[] 
 */

/**
 * Checks if a field name matches identifier naming conventions.
 * This is purely name-based — no statistical fallback.
 */
function isIdentifierByName(nameUpper) {
    // Match key-naming suffixes with word boundaries to avoid false positives.
    // e.g., "PART ID" matches, "BARCODE" does NOT match (CODE is not a standalone word).
    // Word boundary: start-of-string, space, or underscore before the suffix.
    // We check for common key suffixes: ID, KEY, CODE, NUMBER, NUM
    // Note: \bID\b won't work reliably because ID can be at end of string.
    // Instead, we check that the suffix is preceded by a separator or is the whole name.
    return /(?:^|[\s_])ID$/i.test(nameUpper) ||
           /(?:^|[\s_])KEY$/i.test(nameUpper) ||
           /(?:^|[\s_])CODE$/i.test(nameUpper) ||
           /(?:^|[\s_])NUMBER$/i.test(nameUpper) ||
           /(?:^|[\s_])NUM$/i.test(nameUpper);
}

/**
 * Checks if a field name matches date/time naming conventions.
 */
function isDateByName(nameUpper) {
    return (
        nameUpper.includes('DATE') ||
        nameUpper.includes('TIME') ||
        nameUpper.includes('CREATED') ||
        nameUpper.includes('UPDATED') ||
        nameUpper.includes('MODIFIED') ||
        nameUpper.includes('TIMESTAMP')
    );
}

/**
 * Checks if a field name matches measure naming conventions.
 */
function isMeasureByName(nameUpper) {
    return (
        nameUpper.includes('AMOUNT') ||
        nameUpper.includes('TOTAL') ||
        nameUpper.includes('QTY') ||
        nameUpper.includes('QUANTITY') ||
        nameUpper.includes('VALUE') ||
        nameUpper.includes('PRICE') ||
        nameUpper.includes('COST') ||
        nameUpper.includes('FREIGHT') ||
        nameUpper.includes('TAX') ||
        nameUpper.includes('DISCOUNT') ||
        nameUpper.includes('RATE') ||
        nameUpper.includes('FEE') ||
        nameUpper.includes('REVENUE') ||
        nameUpper.includes('PROFIT') ||
        nameUpper.includes('WEIGHT') ||
        nameUpper.includes('BALANCE')
    );
}

function classifyData(profileMetadata) {
    const classifications = [];

    const tables = profileMetadata.tables;
    const tableNames = Object.keys(tables);

    tableNames.forEach(tableName => {
        const tableStats = tables[tableName];
        
        let identifierCount = 0;
        let dateCount = 0;
        let measureCandidateCount = 0;
        let attributeCount = 0;
        
        const fieldClassifications = {};
        
        // === Pass 1: Classify Fields ===
        Object.keys(tableStats.fields).forEach(fieldName => {
            const fieldProps = tableStats.fields[fieldName];
            const nameUpper = fieldName.toUpperCase();
            
            let fieldType = 'ATTRIBUTE'; // default
            
            // System/Metadata rules — highest priority
            if (nameUpper === 'ROW_ID' || nameUpper === 'REC_ID' || nameUpper.includes('ETL_') || nameUpper === 'LOAD_TIMESTAMP') {
                fieldType = 'SYSTEM_METADATA';
            }
            // Date rules
            else if (isDateByName(nameUpper)) {
                fieldType = 'DATE';
                dateCount++;
            }
            // Identifier rules — NAME-BASED ONLY, no statistical fallback
            else if (isIdentifierByName(nameUpper)) {
                fieldType = 'IDENTIFIER';
                identifierCount++;
            }
            // Measure candidate — tentative, needs context confirmation in Pass 2
            else if (fieldProps.isNumeric && isMeasureByName(nameUpper)) {
                fieldType = 'MEASURE_CANDIDATE';
                measureCandidateCount++;
            }
            // Fallback: Attribute
            else {
                fieldType = 'ATTRIBUTE';
                attributeCount++;
            }
            
            fieldClassifications[fieldName] = {
                type: fieldType,
                ...fieldProps
            };
        });

        // === Pass 2: Context Guard for Measures ===
        // A MEASURE_CANDIDATE is promoted to MEASURE only if the table has a transactional profile:
        // It must contain at least one IDENTIFIER that looks like a foreign key 
        // (i.e., an identifier whose uniqueness ratio is significantly below 1.0, meaning
        //  multiple rows share the same value — characteristic of FKs in fact tables)
        const identifierFields = Object.entries(fieldClassifications)
            .filter(([, v]) => v.type === 'IDENTIFIER');
        
        const hasForeignKeyPattern = identifierFields.some(([, props]) => 
            props.uniquenessRatio < 0.9 // FK: same ID value appears in many rows
        );
        
        // Also check: does the table have enough rows to be transactional?
        // A 4-row lookup table with a "Cost" field is not a fact table.
        const hasTransactionalVolume = tableStats.rowCount > 100;

        let confirmedMeasureCount = 0;

        Object.keys(fieldClassifications).forEach(fieldName => {
            if (fieldClassifications[fieldName].type === 'MEASURE_CANDIDATE') {
                if (hasForeignKeyPattern && hasTransactionalVolume) {
                    // Promote: this table has FKs and volume — it's transactional
                    fieldClassifications[fieldName].type = 'MEASURE';
                    confirmedMeasureCount++;
                } else {
                    // Demote: no FK pattern or too few rows — this is a descriptive attribute
                    fieldClassifications[fieldName].type = 'ATTRIBUTE';
                    attributeCount++;
                }
            }
        });

        // === Pass 3: Grain Detection (Structured) ===
        // Primary key: IDENTIFIER fields with uniquenessRatio ~1.0 (unique per row)
        // Foreign keys: IDENTIFIER fields with uniquenessRatio << 1.0 (many rows share same value)
        // Grain fields: the minimal set of fields that define row-level uniqueness
        
        const allIdentifiers = Object.entries(fieldClassifications)
            .filter(([, v]) => v.type === 'IDENTIFIER')
            .map(([name, props]) => ({ name, uniquenessRatio: props.uniquenessRatio }));
        
        // Primary keys: identifiers that are unique or near-unique within this table
        const primaryKeyFields = allIdentifiers
            .filter(f => f.uniquenessRatio >= 0.95)
            .map(f => f.name);
        
        // Foreign keys: identifiers with low uniqueness (same value repeated across rows)
        const foreignKeyFields = allIdentifiers
            .filter(f => f.uniquenessRatio < 0.95)
            .map(f => f.name);
        
        // Grain fields: all identifiers contribute to composite grain.
        // In a fact table, the grain is typically the combination of FKs + any degenerate dimensions.
        // In a dimension, the grain is typically the PK alone.
        const grainFields = allIdentifiers.map(f => f.name);
        const grainDescription = grainFields.length > 0 ? grainFields.join(' + ') : 'Unknown';

        // === Table Role Classification ===
        // FACT: has confirmed measures AND has foreign key patterns
        // Also FACT: very high row count (>50k) with multiple FKs (even without explicit measures —
        //   e.g., a transaction log with just IDs and dates)
        let role = 'DIMENSION';
        
        if (confirmedMeasureCount > 0 && hasForeignKeyPattern) {
            role = 'FACT';
        } else if (tableStats.rowCount > 50000 && foreignKeyFields.length >= 2) {
            // High volume + multiple FKs = likely transactional even without named measures
            role = 'FACT';
        }

        classifications.push({
            tableName: tableName,
            role: role,
            grain: {
                primaryKey: primaryKeyFields,
                foreignKeys: foreignKeyFields,
                grainFields: grainFields,
                grainDescription: grainDescription
            },
            rowCount: tableStats.rowCount,
            candidateKeys: grainFields, // backward compat: all identifiers
            fieldClassifications: fieldClassifications
        });
    });

    return { success: true, classifications };
}

module.exports = {
    classifyData
};
