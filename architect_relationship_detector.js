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

/**
 * Calculates the intersection count between two Sets.
 */
function calculateSetIntersection(setA, setB) {
    if (!setA || !setB) return 0;
    let count = 0;
    const smaller = setA.size < setB.size ? setA : setB;
    const larger = setA.size < setB.size ? setB : setA;
    for (const val of smaller) {
        if (larger.has(val)) count++;
    }
    return count;
}

function determineRelationships(metadata, classifications, globalFieldValues = {}) {
    const relationships = metadata.relationships;
    const allLinks = [];
    const normalizedData = [];

    // --- PHASE 0: LATE-BINDING SEMANTIC DISCOVERY ---
    // If the AI nominated two fields as semantically equivalent (same semanticAlias)
    // but the deterministic profiler skipped them (due to name filters), 
    // we calculate the overlap now on-the-fly.
    if (globalFieldValues && Object.keys(globalFieldValues).length > 0) {
        const semanticFields = [];
        classifications.forEach(table => {
            Object.keys(table.fieldClassifications).forEach(col => {
                const f = table.fieldClassifications[col];
                if (['IDENTIFIER', 'ATTRIBUTE'].includes(f.type) && f.semanticAlias) {
                    semanticFields.push({
                        qualifiedName: `${table.tableName}.${col}`,
                        alias: f.semanticAlias,
                        set: globalFieldValues[`${table.tableName}.${col}`]
                    });
                }
            });
        });

        // Compare all AI-nominated semantic fields
        for (let i = 0; i < semanticFields.length; i++) {
            for (let j = i + 1; j < semanticFields.length; j++) {
                const fa = semanticFields[i];
                const fb = semanticFields[j];

                if (fa.alias === fb.alias && fa.qualifiedName.split('.')[0] !== fb.qualifiedName.split('.')[0]) {
                    // Check if this relationship is already in the metadata
                    const exists = relationships.overlap.some(r => 
                        (r.fieldA === fa.qualifiedName && r.fieldB === fb.qualifiedName) ||
                        (r.fieldA === fb.qualifiedName && r.fieldB === fa.qualifiedName)
                    );

                    if (!exists && fa.set && fb.set) {
                        const intersection = calculateSetIntersection(fa.set, fb.set);
                        if (intersection > 0) {
                            relationships.overlap.push({
                                fieldA: fa.qualifiedName,
                                fieldB: fb.qualifiedName,
                                intersectionCount: intersection,
                                overlapRatioA: intersection / fa.set.size,
                                overlapRatioB: intersection / fb.set.size,
                                discoveredBy: 'AI_INTENT'
                            });
                        }
                    }
                }
            }
        }
    }

    // Phase 1: Build robust link dictionary from exact subsets and high overlaps
    relationships.overlap.forEach(rel => {
        let confidence = 0;
        
        const lastDotA = rel.fieldA.lastIndexOf('.');
        const lastDotB = rel.fieldB.lastIndexOf('.');
        const tableA = rel.fieldA.substring(0, lastDotA);
        const colA = rel.fieldA.substring(lastDotA + 1);
        const tableB = rel.fieldB.substring(0, lastDotB);
        const colB = rel.fieldB.substring(lastDotB + 1);
        
        const fieldA = classifications.find(c => c.tableName === tableA)?.fieldClassifications[colA];
        const fieldB = classifications.find(c => c.tableName === tableB)?.fieldClassifications[colB];
        const classA = fieldA?.type;
        const classB = fieldB?.type;
        const aliasA = fieldA?.semanticAlias;
        const aliasB = fieldB?.semanticAlias;

        if (tableA === tableB) return;

        // Exact same name gets high confidence boost
        const tokensA = tokenize(colA);
        const tokensB = tokenize(colB);
        const tableTokensA = tokenize(tableA);
        const tableTokensB = tokenize(tableB);

        const areIdentical = tokensA.length === tokensB.length && tokensA.every((t, i) => t === tokensB[i]);

        if (colA.toLowerCase() === colB.toLowerCase()) {
            confidence += 0.4;
        } else if (areIdentical) {
            confidence += 0.35;
        } else if (isTokenSubset(tokensA, tokensB)) {
            // Only boost partial matches if they aren't both significant identifiers
            // e.g., allow "Lorry" -> "Lorry_Code", but be wary of "Product" -> "Product Group"
            confidence += 0.05; 
        }

        // --- ENTITY COMPOSITION BOOST ---
        const combinedA = new Set([...tokensA, ...tableTokensA]);
        const combinedB = new Set([...tokensB, ...tableTokensB]);

        const isPerfectEntityA = tokensB.every(t => combinedA.has(t)) && tokensA.every(t => new Set(tokensB).has(t));
        const isPerfectEntityB = tokensA.every(t => combinedB.has(t)) && tokensB.every(t => new Set(tokensA).has(t));

        if (isPerfectEntityA || isPerfectEntityB) {
            confidence += 0.45;
        }

        // High overlap ratio is necessary but not sufficient for linkage
        if (rel.overlapRatioA > 0.8 || rel.overlapRatioB > 0.8) {
            confidence += 0.5;
        }

        // --- IDENTIFIER GUARD ---
        const isIdA = classA === 'IDENTIFIER';
        const isIdB = classB === 'IDENTIFIER';
        
        if (isIdA && isIdB) {
            confidence += 0.1;

            const isAIgnorable = /^(id|key|code|num|number)$/i.test(colA);
            const isBIgnorable = /^(id|key|code|num|number)$/i.test(colB);

            // CASE 1: Table.ID matches OtherTable.Table_ID
            const aMatchesB = tableTokensA.length > 0 && (isAIgnorable && isTokenSubset(tableTokensA, tokensB) && tableTokensA.length === tokensB.length);
            const bMatchesA = tableTokensB.length > 0 && (isBIgnorable && isTokenSubset(tableTokensB, tokensA) && tableTokensB.length === tokensA.length);

            if (aMatchesB || bMatchesA) {
                confidence += 0.4;
            } else {
                // If they are both IDs but names/entities don't match (and NOT a perfect entity match), PENALIZE overlap confidence
                if (!areIdentical && (colA.toLowerCase() !== colB.toLowerCase()) && !isPerfectEntityA && !isPerfectEntityB) {
                    confidence -= 0.5; 
                }
            }

            // --- SEMANTIC ALIAS BOOST (Intent-First) ---
            // If the LLM assigned the same semantic entity (e.g. "Shipper"), boost if there's any data proof.
            if (aliasA && aliasB && aliasA === aliasB && (rel.intersectionCount > 0)) {
                confidence += 0.8;
            }
        }

        // --- STRICT MEASURE/DIMENSION LOCKDOWN ---
        // Measures and non-identifier attributes should NEVER link automatically.
        // They must stay isolated to their respective tables to prevent circulars and 'salad' associations.
        if (classA === 'MEASURE' || classB === 'MEASURE' || (classA !== 'IDENTIFIER' && classB !== 'IDENTIFIER')) {
            confidence = 0;
        }

        if (confidence >= 0.7) {
            allLinks.push({ fieldA: rel.fieldA, fieldB: rel.fieldB, confidence });
        }
    });

    // Phase 2: Apply normalization mapping
    const normalizationMap = {}; // original qualified name -> normalized logical name
    
    classifications.forEach(c => {
        const cleanTableName = (c.tableName || "").replace(/[\[\]]/g, '');

        Object.keys(c.fieldClassifications || {}).forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            const isId = c.fieldClassifications[col].type === 'IDENTIFIER';
            
            // IDENTIFIERS: Use original name to allow automatic linking
            // ALL OTHER FIELDS: Prefix with table name to isolate and prevent unintended associations/circulars
            if (isId) {
                normalizationMap[qualifiedName] = col;
            } else {
                // Fix: Ensure % prefix stays at the very beginning for Qlik hidden fields
                if (col.startsWith('%')) {
                    normalizationMap[qualifiedName] = `%${cleanTableName}_${col.substring(1)}`;
                } else {
                    normalizationMap[qualifiedName] = `${cleanTableName}_${col}`;
                }
            }
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
            const table = qualifiedName.substring(0, qualifiedName.lastIndexOf('.'));
            const col = qualifiedName.substring(qualifiedName.lastIndexOf('.') + 1);
            const fieldInfo = classifications.find(c => c.tableName === table)?.fieldClassifications[col];
            const alias = fieldInfo?.semanticAlias;
            
            const isGeneric = /^(id|key|code|num|number)$/i.test(col);
            const currentIsGeneric = /^(id|key|code|num|number)$/i.test(bestName);
            
            // Priority 1: Semantic Alias (if it's not the same as a generic original col)
            if (alias && alias.toLowerCase() !== col.toLowerCase() && alias.length > 2) {
                bestName = alias;
            } 
            // Priority 2: Not generic name
            else if (!isGeneric && (currentIsGeneric || col.length > bestName.length)) {
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
            
            // Specifically handling dates: Always prefix dates to ensure they can be bridged uniquely
            // and don't create unintended links.
            if (isDate) {
                if (col.startsWith('%')) {
                    normalizedName = `%${tableName}_${col.substring(1)}`;
                } else {
                    normalizedName = `${tableName}_${col}`;
                }
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
            grain: grainStr,
            constituentTables: c.constituentTables // PASS THROUGH
        });
    });

    return { success: true, normalizedData, relationshipScores: allLinks };
}

module.exports = {
    determineRelationships
};
