/**
 * Phase 4: Structural Tester
 * Decides Multi-Fact Modeling Strategies based on the normalized data model constraints.
 * 
 * Rules:
 * - LINK_TABLE: Only when 2+ conformed keys are shared between fact pairs (spec Step 5)
 * - MULTI_FACT_STAR: Multiple facts with 0-1 shared keys (star schema is sufficient)
 * - SINGLE_FACT: Only one fact table
 * - CONCATENATE: Multiple facts with identical FK sets (same grain pattern)
 */

/**
 * Identify fact tables that are highly similar and should be concatenated.
 */
/**
 * Identify fact tables that are highly similar and should be concatenated.
 * Refactored to work on raw classifications and metadata before normalization.
 */
function findFactGroups(metadata, classifications) {
    const factTables = classifications.filter(c => c.role === 'FACT');
    const groups = [];
    const processed = new Set();

    const normalizeField = (f) => f.toLowerCase().replace(/[\s_-]/g, '').trim();

    for (let i = 0; i < factTables.length; i++) {
        if (processed.has(factTables[i].tableName)) continue;
        const group = [factTables[i].tableName];
        processed.add(factTables[i].tableName);

        // Get original fields from profile metadata
        const tableMetadataI = metadata.tables[factTables[i].tableName];
        if (!tableMetadataI) continue;

        const fieldsI = new Set(Object.keys(tableMetadataI.fields).map(normalizeField));

        for (let j = i + 1; j < factTables.length; j++) {
            if (processed.has(factTables[j].tableName)) continue;
            
            const tableMetadataJ = metadata.tables[factTables[j].tableName];
            if (!tableMetadataJ) continue;

            const fieldsJ = Object.keys(tableMetadataJ.fields).map(normalizeField);
            
            let matchCount = 0;
            fieldsJ.forEach(f => { if (fieldsI.has(f)) matchCount++; });

            const similarity = matchCount / Math.max(fieldsI.size, fieldsJ.length);
            // 0.7 threshold for concatenation
            if (similarity > 0.7) {
                group.push(factTables[j].tableName);
                processed.add(factTables[j].tableName);
            }
        }

        if (group.length > 1) {
            groups.push(group);
        }
    }
    return groups;
}

/**
 * Ensures that all fields within a fact group sharing the same footprint (original name)
 * use the exact same normalized name. This prevents divergent columns in concatenated tables.
 */
function conformGroupFields(factGroups, normalizedData) {
    const normalizeOriginal = (f) => f.toLowerCase().replace(/[\s_-]/g, '').trim();

    factGroups.forEach(group => {
        const fieldNameMap = {}; // footprint -> normalizedName

        // Pass 1: Collect preferred names
        group.forEach(tableName => {
            const table = normalizedData.find(t => t.tableName === tableName);
            if (!table) return;
            table.normalizedFields.forEach(f => {
                const footprint = normalizeOriginal(f.originalName);
                // Use the first one we find as the "Source of Truth" for this group
                if (!fieldNameMap[footprint]) {
                    fieldNameMap[footprint] = f.normalizedName;
                }
            });
        });

        // Pass 2: Apply preferred names
        group.forEach(tableName => {
            const table = normalizedData.find(t => t.tableName === tableName);
            if (!table) return;
            table.normalizedFields.forEach(f => {
                const footprint = normalizeOriginal(f.originalName);
                if (fieldNameMap[footprint]) {
                    f.normalizedName = fieldNameMap[footprint];
                }
            });
        });
    });
}

function generateBlueprint(normalizedData) {
    let strategy = 'SINGLE_FACT';
    let needsDateBridge = false;
    
    const allFactTables = normalizedData.filter(t => t.role === 'FACT').map(t => t.tableName);
    const dateFieldsList = [];
    
    normalizedData.forEach(t => {
        t.normalizedFields.forEach(f => {
            if (f.type === 'DATE') {
                const pk = t.grain ? (typeof t.grain === 'string' ? t.grain.split(',')[0].trim() : t.grain) : '';
                dateFieldsList.push({ 
                    tableName: t.tableName, 
                    fieldName: f.normalizedName,
                    isFactTable: t.role === 'FACT',
                    primaryKey: pk
                });
            }
        });
    });
    
    if (dateFieldsList.length > 1) {
        needsDateBridge = true;
    }

    const sharedKeysSet = new Set();
    const keyPresenceInFacts = {};

    if (allFactTables.length > 1) {
        normalizedData.forEach(t => {
            const isFact = t.role === 'FACT';
            if (isFact) {
                t.normalizedFields.forEach(nf => {
                    if (nf.type !== 'MEASURE' && nf.normalizedName !== '%FactID') {
                        if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                        keyPresenceInFacts[nf.normalizedName].add(t.tableName);
                    }
                });
            }
        });

        Object.keys(keyPresenceInFacts).forEach(k => {
            if (keyPresenceInFacts[k].size > 1) {
                sharedKeysSet.add(k);
            }
        });

        if (needsDateBridge) {
            dateFieldsList.forEach(df => {
                if (df.isFactTable) sharedKeysSet.add(df.fieldName);
            });
        }

        if (sharedKeysSet.size >= 2) {
            strategy = 'LINK_TABLE';
        } else {
            strategy = 'MULTI_FACT_STAR';
        }
    }

    const structuralBlueprint = {
        strategy: strategy,
        factTables: allFactTables.map(f => ({ tableName: f })),
        dateBridgeRequired: needsDateBridge,
        dates: dateFieldsList
    };

    if (strategy === 'LINK_TABLE') {
        structuralBlueprint.linkTableRequired = true;
        structuralBlueprint.linkTableBlueprint = {
            linkTableName: 'LinkTable',
            sharedKeys: Array.from(sharedKeysSet)
        };
    }

    const finalDirectives = [];
    normalizedData.forEach(n => {
        const baseDirective = {
            tableName: n.tableName,
            notes: `Role: ${n.role}, Grain: ${n.grain} `,
            loadStatement: `LOAD * FROM [${n.tableName}]`
        };

        if (n.constituentTables && n.constituentTables.length > 0) {
            n.constituentTables.forEach(constituent => {
                finalDirectives.push({
                    ...baseDirective,
                    isConcatenated: true,
                    originalFileName: constituent.originalFileName,
                    sourceTableName: constituent.tableName,
                    originalFields: constituent.originalFields // Passed from Collapser
                });
            });
        } else {
            finalDirectives.push(baseDirective);
        }
    });

    return {
        directives: finalDirectives,
        structuralBlueprint
    };
}

function escalateToLinkTableStrategy(structuralBlueprint, normalizedData) {
    structuralBlueprint.strategy = 'LINK_TABLE';
    const sharedKeysSet = new Set();
    const factTables = structuralBlueprint.factTables.map(f => f.tableName);
    const keyPresenceInFacts = {}; 
    
    factTables.forEach(fName => {
        const tableNorms = normalizedData.find(n => n.tableName === fName);
        if (tableNorms && tableNorms.normalizedFields) {
            tableNorms.normalizedFields.forEach(nf => {
                if (nf.type === 'IDENTIFIER') {
                    if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                    keyPresenceInFacts[nf.normalizedName].add(fName);
                }
            });
        }
    });

    Object.keys(keyPresenceInFacts).forEach(k => {
        if (keyPresenceInFacts[k].size > 1) sharedKeysSet.add(k);
    });

    structuralBlueprint.linkTableRequired = true;
    structuralBlueprint.linkTableBlueprint = {
        linkTableName: 'LinkTable',
        sharedKeys: Array.from(sharedKeysSet)
    };

    return structuralBlueprint;
}

module.exports = {
    generateBlueprint,
    findFactGroups,
    escalateToLinkTableStrategy
};
