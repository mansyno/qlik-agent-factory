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
    return name
        .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase split
        .replace(/[_\s-]+/g, '_')               // normalize separators
        .toLowerCase()
        .split('_')
        .filter(t => t.length > 0 && !['id', 'key', 'code', 'num', 'number'].includes(t)); // Ignore suffixes for entity matching
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
        
        const [tableA, colA] = rel.fieldA.split('.');
        const [tableB, colB] = rel.fieldB.split('.');
        
        // Exact same name gets high confidence boost
        if (colA.toLowerCase() === colB.toLowerCase()) {
            confidence += 0.4;
        }
        // Fuzzy token matching: if one field name's tokens are a subset of the other
        // e.g., "Lorry_Type" tokens ['lorry', 'type'] vs "Type" tokens ['type']
        // ['type'] is a subset of ['lorry', 'type'] → fuzzy match
        else {
            const tokensA = tokenize(colA);
            const tokensB = tokenize(colB);
            if (isTokenSubset(tokensA, tokensB)) {
                confidence += 0.3; // Slightly less than exact match
            }
        }

        // High overlap ratio gets massive boost
        if (rel.overlapRatioA > 0.8 || rel.overlapRatioB > 0.8) {
            confidence += 0.5;
        }

        // Is it classified as an IDENTIFIER?
        const classA = classifications.find(c => c.tableName === tableA)?.fieldClassifications[colA]?.type;
        const classB = classifications.find(c => c.tableName === tableB)?.fieldClassifications[colB]?.type;
        
        if (classA === 'IDENTIFIER' && classB === 'IDENTIFIER') {
            confidence += 0.1;
        }

        // Relaxed gate: require at least ONE side to be IDENTIFIER.
        // If neither is IDENTIFIER, apply a penalty but don't zero out entirely —
        // allow high-overlap ATTRIBUTE matches (like Type ↔ Lorry_Type) if overlap is very strong.
        if (classA !== 'IDENTIFIER' && classB !== 'IDENTIFIER') {
            if (rel.overlapRatioA > 0.95 && rel.overlapRatioB > 0.95) {
                // Both sides have near-perfect overlap — likely a legitimate join despite both being ATTRIBUTE
                confidence -= 0.1; // Penalty, making max score 0.7 if exact name + high overlap
            } else {
                confidence = 0; // Prevent linking purely on loose ATTRIBUTES
            }
        }

        if (confidence >= 0.7) {
            allLinks.push({ fieldA: rel.fieldA, fieldB: rel.fieldB, confidence });
        }
    });

    // Phase 2: Apply normalization mapping
    const normalizationMap = {}; // original qualified name -> normalized logical name
    
    // Default: aliasing everything to prevent accidental synthetic keys
    classifications.forEach(c => {
        Object.keys(c.fieldClassifications).forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            normalizationMap[qualifiedName] = `${c.tableName}_${col}`;
        });
    });

    // Unify linked fields
    const unifiedGroups = [];
    
    allLinks.forEach(link => {
        let foundGroup = null;
        for (const group of unifiedGroups) {
            if (group.has(link.fieldA) || group.has(link.fieldB)) {
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
        const firstColName = arr[0].split('.')[1];
        
        arr.forEach(qualifiedName => {
            normalizationMap[qualifiedName] = firstColName; // Unified key
        });
    });

    // Phase 3: Construct Output for the Generator
    classifications.forEach(c => {
        const normFields = [];
        const originalFields = Object.keys(c.fieldClassifications);
        
        originalFields.forEach(col => {
            const qualifiedName = `${c.tableName}.${col}`;
            const isDate = c.fieldClassifications[col].type === 'DATE';
            
            let normalizedName = normalizationMap[qualifiedName];
            
            // Specifically handling dates: Always prefix dates
            if (isDate) {
                normalizedName = `${c.tableName}_${col}`;
            }

            normFields.push({
                originalName: col,
                normalizedName: normalizedName,
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
            tableName: c.tableName,
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
