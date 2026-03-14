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
function findFactGroups(normalizedData) {
    const factTables = normalizedData.filter(t => t.role === 'FACT');
    const groups = [];
    const processed = new Set();

    const normalizeField = (f) => f.toLowerCase().replace(/[\s_-]/g, '').trim();

    for (let i = 0; i < factTables.length; i++) {
        if (processed.has(factTables[i].tableName)) continue;
        const group = [factTables[i].tableName];
        processed.add(factTables[i].tableName);

        // Similarity check should use ORIGINAL fields (normalized for delimiters/casing)
        // to detect structural identity before any table-specific aliasing occurs.
        const fieldsI = new Set(factTables[i].originalFields.map(normalizeField));

        for (let j = i + 1; j < factTables.length; j++) {
            if (processed.has(factTables[j].tableName)) continue;
            const fieldsJ = factTables[j].originalFields.map(normalizeField);
            
            let matchCount = 0;
            fieldsJ.forEach(f => { if (fieldsI.has(f)) matchCount++; });

            const similarity = matchCount / Math.max(fieldsI.size, fieldsJ.length);
            // Re-relax to 0.7 to ensure HistorySales and Sales concatenate
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
    
    // 1. Identify Fact Groups for Concatenation
    const factGroups = findFactGroups(normalizedData);
    const hasConcatenation = factGroups.length > 0;

    // 2. Conformance Stage: Unify names for concatenated fields
    if (hasConcatenation) {
        conformGroupFields(factGroups, normalizedData);
    }
    
    if (hasConcatenation) {
        strategy = 'CONCATENATE';
        console.log(`[StructuralTester] Detected ${factGroups.length} groups of concatenatable fact tables.`);
    }

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

    // Treat each concatenated group as a single logical fact table
    const virtualFactTables = allFactTables.filter(ft => !factGroups.flat().includes(ft));
    factGroups.forEach(g => virtualFactTables.push(g.join('_')));

    const sharedKeysSet = new Set();
    const keyPresenceInFacts = {};

    if (virtualFactTables.length > 1) {
        normalizedData.forEach(t => {
            const isFact = t.role === 'FACT';
            const groupIdx = factGroups.findIndex(g => g.includes(t.tableName));
            
            if (isFact || groupIdx !== -1) {
                const virtualName = groupIdx !== -1 ? factGroups[groupIdx].join('_') : t.tableName;
                
                t.normalizedFields.forEach(nf => {
                    // BROADENED KEY DETECTION: Any field that isn't a measure and exists in 2+ fact clusters
                    // must be moved to the LinkTable to prevent synthetic keys between measures/attributes.
                    // IMPORTANT: We now include DATE fields because if two facts share a date AND both link 
                    // to a LinkTable, keeping the date in the facts creates a loop (synthetic key).
                    if (nf.type !== 'MEASURE' && nf.normalizedName !== '%FactID') {
                        if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                        keyPresenceInFacts[nf.normalizedName].add(virtualName);
                    }
                });
            }
        });

        Object.keys(keyPresenceInFacts).forEach(k => {
            if (keyPresenceInFacts[k].size > 1) {
                sharedKeysSet.add(k);
            }
        });

        // FORCE DATE INCLUSION: If needsDateBridge is true, all fact date fields MUST be in sharedKeysSet
        // to ensure they are hubbed in the LinkTable.
        if (needsDateBridge) {
            dateFieldsList.forEach(df => {
                if (df.isFactTable) {
                    sharedKeysSet.add(df.fieldName);
                }
            });
        }

        // Apply the 2+ shared key guard per spec Step 5
        if (sharedKeysSet.size >= 2) {
            strategy = 'LINK_TABLE';
            console.log(`[StructuralTester] ${sharedKeysSet.size} shared conformed keys among virtual facts. Strategy: LINK_TABLE`);
        } else if (strategy !== 'CONCATENATE') {
            // 0-1 shared keys: star schema handles this fine, no link table needed
            strategy = 'MULTI_FACT_STAR';
            console.log(`[StructuralTester] Only ${sharedKeysSet.size} shared key(s). Strategy: MULTI_FACT_STAR (no link table)`);
        }
    }

    const structuralBlueprint = {
        strategy: strategy,
        factTables: allFactTables.map(f => ({ tableName: f })),
        factGroups: factGroups,
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

    // Prepare final directives for QVS generation
    const finalDirectives = normalizedData.map(n => {
        // Support both structured grain and legacy string grain
        let grainStr;
        if (typeof n.grain === 'object' && n.grain !== null) {
            grainStr = n.grain.grainDescription || n.grain.grainFields?.join(', ') || '';
        } else {
            grainStr = n.grain || '';
        }

        return {
            tableName: n.tableName,
            notes: `Role: ${n.role}, Grain: ${grainStr} `,
            loadStatement: `LOAD * FROM [${n.tableName}]`
        };
    });

    return { structuralBlueprint, finalDirectives };
}

module.exports = {
    generateBlueprint
};
