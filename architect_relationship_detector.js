/**
 * Phase 3: Relationship Detection & Normalization
 * Determines which tables should link and normalizes field names to enforce the Qlik associative model.
 * Uses Confidence Scoring based on overlap, naming similarity, and fuzzy token matching.
 */

/**
 * Tokenize a field name by splitting on underscores, spaces, and camelCase boundaries.
 * Returns lowercase tokens.
 * e.g. "Lorry_Type" -> ['lorry', 'type'], "CustomerID" -> ['customer', 'id']
 */
function tokenize(name) {
    const tokens = name
        .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase split
        .replace(/[_\s-]+/g, '_')               // normalize separators
        .toLowerCase()
        .split('_')
        .filter(t => t.length > 0);
    
    // Singularize each token to improve matching (e.g. "Customers" -> "customer")
    const singularized = tokens.map(t => {
        if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
        if (t.endsWith('s') && t.length > 3 && !t.endsWith('ss')) return t.slice(0, -1);
        return t;
    });

    // Only strip generic suffixes if there's other meaning left in the name
    // (e.g. "CustomerID" -> ["customer"], but "ID" -> ["id"])
    const filtered = singularized.filter(t => !['id', 'key', 'code', 'num', 'number'].includes(t));
    return filtered.length > 0 ? filtered : singularized;
}

/**
 * Check if one token set is a subset of the other (fuzzy field name matching).
 * Returns true if the smaller set is fully contained in the larger set.
 */
function isTokenSubset(tokensA, tokensB) {
    if (tokensA.length === 0 || tokensB.length === 0) return false;
    const [smaller, larger] = tokensA.length <= tokensB.length 
        ? [tokensA, tokensB] 
        : [tokensB, tokensA];
    return smaller.every(t => larger.includes(t));
}

function determineRelationships(metadata, classifications) {
    const relationships = metadata.relationships;
    const allLinks = [];
    const normalizedData = [];

    // Phase 1: Build robust link dictionary from exact subsets and high overlaps
    relationships.overlap.forEach(rel => {
        let confidence = 0;
        
        const lastDotA = rel.fieldA.lastIndexOf('.');
        const lastDotB = rel.fieldB.lastIndexOf('.');
        const tableA = rel.fieldA.substring(0, lastDotA);
        const colA = rel.fieldA.substring(lastDotA + 1);
        const tableB = rel.fieldB.substring(0, lastDotB);
        const colB = rel.fieldB.substring(lastDotB + 1);
        
        // Exact same name gets high confidence boost
        const tokensA = tokenize(colA);
        const tokensB = tokenize(colB);

        const areIdentical = tokensA.length === tokensB.length && tokensA.every((t, i) => t === tokensB[i]);

        if (colA.toLowerCase() === colB.toLowerCase()) {
            confidence += 0.4;
        } else if (areIdentical) {
            confidence += 0.35;
        } else if (isTokenSubset(tokensA, tokensB)) {
            // Only boost partial matches if they aren't both significant identifiers
            // e.g., allow "Lorry" -> "Lorry_Code", but be wary of "Product" -> "Product Group"
            confidence += 0.1; 
        }

        // High overlap ratio is necessary but not sufficient for linkage
        if (rel.overlapRatioA > 0.8 || rel.overlapRatioB > 0.8) {
            confidence += 0.5;
        }

        // --- IDENTIFIER GUARD ---
        const classA = classifications.find(c => c.tableName === tableA)?.fieldClassifications[colA]?.type;
        const classB = classifications.find(c => c.tableName === tableB)?.fieldClassifications[colB]?.type;
        const isIdA = classA === 'IDENTIFIER';
        const isIdB = classB === 'IDENTIFIER';
        
        if (isIdA && isIdB) {
            confidence += 0.1;

            const tableTokensA = tokenize(tableA);
            const tableTokensB = tokenize(tableB);
            const isAIgnorable = /^(id|key|code|num|number)$/i.test(colA);
            const isBIgnorable = /^(id|key|code|num|number)$/i.test(colB);

            // CASE 1: Table.ID matches OtherTable.Table_ID
            // e.g., Customers.ID (tokens: ['id']) and Sales.Customer_ID (tokens: ['customer'])
            // tableTokensA: ['customer']
            const aMatchesB = tableTokensA.length > 0 && (areIdentical || (isAIgnorable && isTokenSubset(tableTokensA, tokensB) && tableTokensA.length === tokensB.length));
            const bMatchesA = tableTokensB.length > 0 && (areIdentical || (isBIgnorable && isTokenSubset(tableTokensB, tokensA) && tableTokensB.length === tokensA.length));

            if (aMatchesB || bMatchesA) {
                confidence += 0.4;
            } else {
                // If they are both IDs but names/entities don't match, PENALIZE overlap confidence
                // This prevents Order_ID (1-70k) from linking to SalesMgr_ID (1-8) purely on overlap.
                if (!areIdentical) confidence -= 0.4;
            }
        }

        // --- MEASURE GUARD ---
        if (classA !== 'IDENTIFIER' && classB !== 'IDENTIFIER') {
            confidence = 0; // Prevent linking purely on non-identifiers
        }

        if (confidence >= 0.7) {
            allLinks.push({ fieldA: rel.fieldA, fieldB: rel.fieldB, confidence });
        }
    });

    // Phase 2: Apply normalization mapping
    const normalizationMap = {}; // original qualified name -> normalized logical name
    
    // Default: aliasing non-keys to include table names to prevent accidental synthetic keys
    // We only want fields to have the same name if they are EXPLICITLY linked.
    classifications.forEach(c => {
        const cleanTableName = (c.tableName || "").replace(/[\[\]]/g, '');
        Object.keys(c.fieldClassifications || {}).forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            const type = c.fieldClassifications[col].type;
            
            // By default, every field is unique to its table to prevent "Measure Hijacking"
            // (e.g. Parts.Cost and Lorries.Cost should stay separate)
            // unless they are later explicitly unified.
            normalizationMap[qualifiedName] = `${cleanTableName}_${col}`;
            
            // However, common descriptive attributes (Name, Desc) that aren't keys
            // should usually keep their names if there's no collision, but we'll be safe
            // and let the unification logic handle the "Global Name" decision.
        });
    });

    // Unify linked fields
    const unifiedGroups = [];
    
    allLinks.forEach(link => {
        let foundGroup = null;
        for (const group of unifiedGroups) {
            if (group.has(link.fieldA) || group.has(link.fieldB)) {
                const lastDotA = link.fieldA.lastIndexOf('.');
                const lastDotB = link.fieldB.lastIndexOf('.');
                const tableA = link.fieldA.substring(0, lastDotA);
                const tableB = link.fieldB.substring(0, lastDotB);
                
                const tablesInGroup = new Set(Array.from(group).map(f => f.substring(0, f.lastIndexOf('.'))));
                
                if (tablesInGroup.has(tableA) && !group.has(link.fieldA)) continue;
                if (tablesInGroup.has(tableB) && !group.has(link.fieldB)) continue;
                
                foundGroup = group;
                break;
            }
        }
        
        if (foundGroup) {
            foundGroup.add(link.fieldA);
            foundGroup.add(link.fieldB);
        } else {
            unifiedGroups.push(new Set([link.fieldA, link.fieldB]));
        }
    });

    unifiedGroups.forEach(group => {
        const arr = Array.from(group);
        // Pick the most descriptive name in the group (e.g. "Customer_ID" over "ID")
        let bestName = arr[0].split('.')[1];
        
        // Priority: Descriptive Name > Length > Generic
        arr.forEach(qualifiedName => {
            const col = qualifiedName.split('.')[1];
            const isGeneric = /^(id|key|code|num|number)$/i.test(col);
            const currentIsGeneric = /^(id|key|code|num|number)$/i.test(bestName);
            
            if (!isGeneric && (currentIsGeneric || col.length > bestName.length)) {
                bestName = col;
            }
        });
        
        arr.forEach(qualifiedName => {
            normalizationMap[qualifiedName] = bestName; // Unified name
        });
    });

    // Special Case: Allow single-table fields to use their original names if they don't collide
    // with any other field's final name. This keeps dimensions "clean" (CityName vs Cities_CityName).
    const allFinalNames = Object.values(normalizationMap);
    const nameUsageCount = {};
    allFinalNames.forEach(n => nameUsageCount[n] = (nameUsageCount[n] || 0) + 1);

    classifications.forEach(c => {
        const cleanTableName = (c.tableName || "").replace(/[\[\]]/g, '');
        Object.keys(c.fieldClassifications).forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            const currentNorm = normalizationMap[qualifiedName];
            
            // If the field wasn't part of a unified group (it's still Table_Field)
            // check if the original name 'col' is "safe" (not used by any other mapping)
            if (currentNorm === `${cleanTableName}_${col}`) {
                const isMeasure = c.fieldClassifications[col].type === 'MEASURE';
                const isId = c.fieldClassifications[col].type === 'IDENTIFIER';
                
                // We keep IDs prefixed if they were already prefixed (safety)
                // We keep Measures prefixed to prevent any accidental dynamic linking
                if (!isMeasure && !isId && (!nameUsageCount[col])) {
                    normalizationMap[qualifiedName] = col;
                    nameUsageCount[col] = 1;
                }
            }
        });
    });

    // Phase 3: Construct Output for the Generator
    // Tracks assigned names PER TABLE to prevent collisions
    const tableNamespace = {}; 

    classifications.forEach(c => {
        const normFields = [];
        const originalFields = Object.keys(c.fieldClassifications);
        const tableName = c.tableName.replace(/[\[\]]/g, '');
        tableNamespace[tableName] = new Set();
        
        originalFields.forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            const isDate = c.fieldClassifications[col].type === 'DATE';
            
            let normalizedName = normalizationMap[qualifiedName];
            
            // Specifically handling dates: Always prefix dates
            if (isDate) {
                normalizedName = `${tableName}_${col}`;
            }

            // COLLISION PREVENTION: Ensure the name is unique within this table
            let finalName = normalizedName;
            let counter = 1;
            // Check lowercase for robustness bit keep the original casing if possible
            while (tableNamespace[tableName].has(finalName.toLowerCase())) {
                finalName = `${normalizedName}_${counter++}`;
            }
            tableNamespace[tableName].add(finalName.toLowerCase());

            normFields.push({
                originalName: col,
                normalizedName: finalName,
                type: c.fieldClassifications[col].type
            });
        });

        // Support both structured and legacy grain
        let grainStr;
        if (typeof c.grain === 'object' && c.grain !== null) {
            grainStr = c.grain.grainFields?.join(', ') || c.candidateKeys?.join(', ') || '';
        } else {
            grainStr = c.candidateKeys?.join(', ') || '';
        }

        normalizedData.push({
            tableName: tableName,
            originalFileName: c.originalFileName,
            originalFields: originalFields,
            normalizedFields: normFields,
            role: c.role,
            grain: grainStr
        });
    });

    return { success: true, normalizedData, relationshipScores: allLinks };
}

module.exports = {
    determineRelationships
};
