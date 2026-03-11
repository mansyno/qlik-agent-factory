const path = require('path');

function cleanEntityName(name) {
    // Remove variations of ID, Num, Number, Key, Code, common delimiters, and numeric suffixes
    let clean = name.replace(/\b(Number|IDNum|Number|Code|Num|Key|ID|PK|FK)s?\b|[_-]?\d+$/gi, '').replace(/[_-]/g, ' ').trim();

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
                // Fuzzy matching
                else {
                    const fuzzyMatch = Object.keys(goldenKeys).find(gk =>
                        gk === fieldEntity
                    );

                    if (fuzzyMatch) {
                        normName = goldenKeys[fuzzyMatch];
                    } else if (fieldEntity.includes('type')) {
                        const entityPart = fieldEntity.replace('type', '').trim();
                        if (entityPart && goldenKeys[entityPart]) {
                            normName = `${cleanEntityName(entityPart)}TypeKey`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                        } else {
                            normName = `${fieldEntity}Key`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                        }
                    } else {
                        normName = `${fieldEntity}Key`.replace(/(^|\s)\S/g, l => l.toUpperCase()).replace(/\s+/g, '');
                    }
                }
            } else if (isDate) {
                if (isFact) {
                    normName = `${c.tableName}_${orig}`;
                    dateFieldsList.push({ tableName: c.tableName, fieldName: normName, isFactTable: true });
                } else {
                    normName = `${c.tableName}_${orig}`;
                }
            } else {
                // Regular attribute
                if (isDim) {
                    normName = (orig.startsWith(c.tableName) || isNativeLink) ? orig : `${c.tableName}_${orig}`;
                } else {
                    normName = orig; // Fact measures
                }
            }

            normFields.push({
                originalName: orig,
                normalizedName: normName.replace(/\s+/g, ''), // remove spaces
                type: c.fieldClassifications ? c.fieldClassifications[orig]?.type : undefined
            });
        });

        // Extract grain description — support both structured and legacy string grain
        let grainDescription;
        if (typeof c.grain === 'object' && c.grain !== null) {
            grainDescription = c.grain.grainDescription || c.grain.grainFields?.join(', ') || 'Unknown';
        } else {
            grainDescription = c.grain || 'Unknown';
        }

        normalizedData.push({
            tableName: c.tableName,
            originalFields: originalFields,
            normalizedFields: normFields,
            role: c.role.toLowerCase(),
            grain: grainDescription.toLowerCase()
        });
    });

    // 4. Determine Strategy
    // Default to star schema. Only use link table if the engine test later detects synthetic keys,
    // OR if we can already confirm 2+ shared conformed keys between fact pairs.
    let strategy = 'SINGLE_FACT';
    let needsDateBridge = false;

    // Detect if we have engine-level Synthetic Keys
    const engineSynKeys = (relationships && relationships.syntheticKeys) ? relationships.syntheticKeys : [];
    const hasEngineSynKeys = engineSynKeys.length > 0;

    if (hasEngineSynKeys) {
        console.log(`[Modeler] Qlik Engine detected ${engineSynKeys.length} Synthetic Keys. Forcing link table evaluation.`);
    }

    if (factTables.length > 1 || hasEngineSynKeys) {
        // Count shared conformed keys between fact table pairs
        const keyPresenceInFacts = {}; // 'CustomerKey' -> Set(['TableA', 'TableB'])
        const factToEvaluate = factTables.length > 0 ? factTables : classifications;

        factToEvaluate.forEach(f => {
            const tableNorms = normalizedData.find(n => n.tableName === f.tableName);
            if (!tableNorms) return;
            const fkList = tableNorms.normalizedFields
                .filter(nf => nf.normalizedName.endsWith('Key'))
                .map(nf => nf.normalizedName);

            fkList.forEach(k => {
                if (!keyPresenceInFacts[k]) keyPresenceInFacts[k] = new Set();
                keyPresenceInFacts[k].add(f.tableName);
            });
        });

        // Only keys shared by 2+ facts could cause synthetic keys
        const sharedKeys = Object.keys(keyPresenceInFacts).filter(k => keyPresenceInFacts[k].size > 1);
        
        if (sharedKeys.length >= 2 || hasEngineSynKeys) {
            // 2+ shared conformed keys → link table needed per spec Step 5
            strategy = 'LINK_TABLE';
            console.log(`[Modeler] ${sharedKeys.length} shared conformed keys between facts. Strategy: LINK_TABLE`);
        } else if (factTables.length > 1) {
            // Only 0-1 shared key → star schema is sufficient
            strategy = 'MULTI_FACT_STAR';
            console.log(`[Modeler] Only ${sharedKeys.length} shared key(s) between facts. Strategy: MULTI_FACT_STAR (no link table needed)`);
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

        const keyPresenceInFacts = {};
        factTables.forEach(f => {
            const tableNorms = normalizedData.find(n => n.tableName === f.tableName);
            tableNorms.normalizedFields.forEach(nf => {
                if (nf.normalizedName.endsWith('Key')) {
                    if (!keyPresenceInFacts[nf.normalizedName]) keyPresenceInFacts[nf.normalizedName] = new Set();
                    keyPresenceInFacts[nf.normalizedName].add(f.tableName);
                }
            });
        });

        // Only move keys to LinkTable if shared by 2+ Fact tables
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
            loadStatement: `LOAD * FROM[${n.tableName}]`
        };
    });

    return { normalizedData, structuralBlueprint, finalDirectives };
}

module.exports = {
    resolveArchitecture
};
