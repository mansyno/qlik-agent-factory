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

function generateBlueprint(normalizedData) {
    let strategy = 'SINGLE_FACT';
    let needsDateBridge = false;
    
    const factTables = normalizedData.filter(t => t.role === 'FACT').map(t => t.tableName);
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

    // Count shared conformed keys between fact table pairs
    const sharedKeysSet = new Set();
    const keyPresenceInFacts = {};

    if (factTables.length > 1) {
        factTables.forEach(fName => {
            const tableNorms = normalizedData.find(n => n.tableName === fName);
            tableNorms.normalizedFields.forEach(nf => {
                if (nf.type === 'IDENTIFIER') {
                    if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                    keyPresenceInFacts[nf.normalizedName].add(fName);
                }
            });
        });

        Object.keys(keyPresenceInFacts).forEach(k => {
            if (keyPresenceInFacts[k].size > 1) {
                sharedKeysSet.add(k);
            }
        });

        // Apply the 2+ shared key guard per spec Step 5
        if (sharedKeysSet.size >= 2) {
            strategy = 'LINK_TABLE';
            console.log(`[StructuralTester] ${sharedKeysSet.size} shared conformed keys. Strategy: LINK_TABLE`);
        } else {
            // 0-1 shared keys: star schema handles this fine, no link table needed
            strategy = 'MULTI_FACT_STAR';
            console.log(`[StructuralTester] Only ${sharedKeysSet.size} shared key(s). Strategy: MULTI_FACT_STAR (no link table)`);
        }
    }

    const structuralBlueprint = {
        strategy: strategy,
        factTables: factTables.map(f => ({ tableName: f })),
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
            loadStatement: `LOAD * FROM[${n.tableName}]`
        };
    });

    return { structuralBlueprint, finalDirectives };
}

module.exports = {
    generateBlueprint
};
