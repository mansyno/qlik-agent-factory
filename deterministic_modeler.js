const path = require('path');

function cleanEntityName(name) {
    // Remove variations of ID, Num, Number, Key, Code, common delimiters, and numeric suffixes
    // We sort by length descending to ensure 'Number' is matched before 'Num'
    // We use \b to ensure word boundaries (so 'Number' doesn't leave 'ber' if 'Num' matches)
    let clean = name.replace(/\b(Number|IDNum|Number|Code|Num|Key|ID|PK|FK)s?\b|[_-]?\d+$/gi, '').replace(/[_-]/g, ' ').trim();

    // Special case: if it ends with Type but that's not the ONLY thing left
    if (clean.toLowerCase().endsWith('type') && clean.length > 4) {
        // Keep Type
    } else if (clean.toLowerCase() === 'type') {
        // Keep Type
    }

    // Handle camelCase or PascalCase
    if (!clean.includes(' ')) {
        clean = clean.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    // Standard singularization
    if (clean.toLowerCase().endsWith('ies') && clean.length > 4) {
        clean = clean.slice(0, -3) + 'y';
    } else if (clean.toLowerCase().endsWith('s') && clean.length > 3 && !clean.toLowerCase().endsWith('ss')) {
        clean = clean.slice(0, -1);
    }

    return clean.toLowerCase().trim() || name.toLowerCase().trim();
}

function resolveArchitecture(profileData, classifications) {
    const { tables, relationships } = profileData;
    const nativeLinks = (relationships && relationships.nativeLinks) ? relationships.nativeLinks : {};

    // 0. Pre-process Classifications: Physical Validation & Native Link Injection
    classifications.forEach(c => {
        const physicalFields = tables[c.tableName].fields.map(f => f.name);

        // Filter out hallucinated keys: candidate keys MUST exist in the table
        c.candidateKeys = c.candidateKeys.filter(k => {
            const exists = physicalFields.includes(k);
            if (!exists) console.log(`[Modeler] Ignoring hallucinated candidate key: ${c.tableName}.${k}`);
            return exists;
        });

        // Inject missed Native Links
        physicalFields.forEach(f => {
            if (nativeLinks[f] && nativeLinks[f].includes(c.tableName)) {
                if (!c.candidateKeys.includes(f)) {
                    console.log(`[Modeler] Injecting missed Native Link as Candidate Key: ${c.tableName}.${f}`);
                    c.candidateKeys.push(f);
                }
            }
        });
    });

    let normalizedData = [];
    const factTables = [];
    const dimTables = [];

    // 1. Separate Facts and Dims
    classifications.forEach(c => {
        if (c.role.toLowerCase() === 'fact') factTables.push(c);
        else dimTables.push(c);
    });

    // 2. Build Dimension Key Mappings
    // Map Dims to their primary keys to establish the "Golden" keys
    const goldenKeys = {}; // 'customer' -> 'CustomerKey'

    dimTables.forEach(dim => {
        const entityName = cleanEntityName(dim.tableName);
        const pk = `${entityName} Key`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, ''); // PascalCase
        goldenKeys[entityName] = pk;
    });

    // 3. Normalize all fields
    const dateFieldsList = [];

    classifications.forEach(c => {
        const originalFields = tables[c.tableName].fields.map(f => f.name);
        const isFact = c.role.toLowerCase() === 'fact';
        const isDim = c.role.toLowerCase() === 'dimension';

        const normFields = [];
        const tableEntity = cleanEntityName(c.tableName);

        originalFields.forEach(orig => {
            let normName = orig;

            const fieldEntity = cleanEntityName(orig);

            // Is it a candidate key or an engine-identified link?
            const isCandidate = c.candidateKeys.includes(orig);
            const isNativeLink = nativeLinks[orig];

            // Check if it's a date field
            const isDate = /date|time|year|month|day/i.test(orig);

            if (isCandidate || isNativeLink) {
                // If it's a dimension primary key
                if (isDim && (fieldEntity === tableEntity || fieldEntity === '')) {
                    normName = goldenKeys[tableEntity] || `${tableEntity} Key`;
                }
                // If it's a foreign key looking at a dimension (exact match)
                else if (goldenKeys[fieldEntity]) {
                    normName = goldenKeys[fieldEntity];
                }
                // Fuzzy matching: Avoid matching 'type' to the primary key of the entity!
                else {
                    const fuzzyMatch = Object.keys(goldenKeys).find(gk =>
                        gk === fieldEntity // Exact match after cleaning
                    );

                    if (fuzzyMatch) {
                        normName = goldenKeys[fuzzyMatch];
                    } else if (fieldEntity.includes('type')) {
                        // Special handling for Type joins (e.g., LorryTypeKey)
                        const entityPart = fieldEntity.replace('type', '').trim();
                        if (entityPart && goldenKeys[entityPart]) {
                            normName = `${cleanEntityName(entityPart)}TypeKey`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                        } else {
                            normName = `${fieldEntity}Key`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                        }
                    } else {
                        // Fallback for unidentified keys
                        normName = `${fieldEntity}Key`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                    }
                }
            } else if (isDate) {
                if (isFact) {
                    normName = `${c.tableName}_${orig}`; // Prefix fact dates uniquely
                    dateFieldsList.push({ tableName: c.tableName, fieldName: normName });
                } else {
                    normName = `${c.tableName}_${orig}`; // Prefix dim dates
                }
            } else {
                // Regular attribute
                if (isDim) {
                    // Prefix dim attributes UNLESS it was a native link
                    normName = (orig.startsWith(c.tableName) || isNativeLink) ? orig : `${c.tableName}_${orig}`;
                } else {
                    normName = orig; // Fact measures
                }
            }

            normFields.push({
                originalName: orig,
                normalizedName: normName.replace(/\s+/g, '') // remove spaces
            });
        });

        normalizedData.push({
            tableName: c.tableName,
            originalFields: originalFields,
            normalizedFields: normFields,
            role: c.role.toLowerCase(),
            grain: c.grain.toLowerCase()
        });
    });

    // 4. Determine Strategy (Concat vs Link vs Star)
    let strategy = 'SINGLE_FACT';
    let needsDateBridge = false;

    // Detect if we have engine-level Synthetic Keys
    const engineSynKeys = (relationships && relationships.syntheticKeys) ? relationships.syntheticKeys : [];
    const hasEngineSynKeys = engineSynKeys.length > 0;

    if (hasEngineSynKeys) {
        console.log(`[Modeler] Qlik Engine detected ${engineSynKeys.length} Synthetic Keys.Forcing multi - table strategy.`);
    }

    // Treat header/detail as a single logical fact if they share a pure 1:M relationship
    if (factTables.length > 1 || hasEngineSynKeys) {
        // Collect normalized keys for each fact
        const factKeys = {};
        let allIdentical = true;
        let referenceKeys = null;

        const factToEvaluate = factTables.length > 0 ? factTables : classifications;

        factToEvaluate.forEach(f => {
            const tableNorms = normalizedData.find(n => n.tableName === f.tableName);
            if (!tableNorms) return;
            const fkList = tableNorms.normalizedFields
                .filter(nf => nf.normalizedName.endsWith('Key'))
                .map(nf => nf.normalizedName).sort();

            factKeys[f.tableName] = fkList;

            if (!referenceKeys) {
                referenceKeys = fkList;
            } else {
                if (JSON.stringify(referenceKeys) !== JSON.stringify(fkList)) {
                    allIdentical = false;
                }
            }
        });

        if (allIdentical && factTables.length > 1) {
            strategy = 'CONCATENATE';
        } else {
            // Need a link table if they share *some* dimensions but not all, or have Synthetic Keys
            strategy = 'LINK_TABLE';
        }
    }

    if (dateFieldsList.length > 1) {
        needsDateBridge = true;
    }

    // 5. Generate Blueprint
    const structuralBlueprint = {
        strategy: strategy,
        factTables: factTables.map(f => ({ tableName: f.tableName })),
        dateBridgeRequired: needsDateBridge,
        dates: dateFieldsList
    };

    if (strategy === 'LINK_TABLE') {
        const sharedKeysSet = new Set();

        // --- Minimalist Link Table Logic ---
        // Identify keys present in MORE THAN ONE Fact table.
        // Dimension-to-Dimension or single-Fact-to-Dimension links stay as Star/Snowflake.

        const keyPresenceInFacts = {}; // 'CustomerKey' -> Set(['TableA', 'TableB'])
        factTables.forEach(f => {
            const tableNorms = normalizedData.find(n => n.tableName === f.tableName);
            tableNorms.normalizedFields.forEach(nf => {
                if (nf.normalizedName.endsWith('Key')) {
                    if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                    keyPresenceInFacts[nf.normalizedName].add(f.tableName);
                }
            });
        });

        // Only move keys to LinkTable if they are shared by at least 2 Fact tables
        Object.keys(keyPresenceInFacts).forEach(k => {
            if (keyPresenceInFacts[k].size > 1) {
                sharedKeysSet.add(k);
            }
        });

        structuralBlueprint.linkTableRequired = true;
        structuralBlueprint.linkTableBlueprint = {
            linkTableName: 'LinkTable',
            sharedKeys: Array.from(sharedKeysSet)
        };
    }

    // Directives format for architect_generator.js
    const finalDirectives = normalizedData.map(n => {
        return {
            tableName: n.tableName,
            notes: `Role: ${n.role}, Grain: ${n.grain} `,
            loadStatement: `LOAD * FROM[${n.tableName}]` // Simplified, generator reconstructs it
        };
    });

    return { normalizedData, structuralBlueprint, finalDirectives };
}

module.exports = {
    resolveArchitecture
};
