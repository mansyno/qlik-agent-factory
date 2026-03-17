const logger = require('./.agent/utils/logger.js');

function collapseFactGroups(metadata, classifications, factGroups) {
    if (!factGroups || factGroups.length === 0) return { metadata, classifications };

    const newMetadata = JSON.parse(JSON.stringify(metadata));
    const newClassifications = JSON.parse(JSON.stringify(classifications));

    factGroups.forEach(group => {
        const consolidatedName = group.join('_');
        logger.info('Collapser', `Unifying fact group [${group.join(', ')}] into virtual table [${consolidatedName}]...`);

        // 1. Get member info for reconstruction in the generator
        const constituents = group.map(tableName => {
            const c = classifications.find(item => item.tableName === tableName);
            const m = metadata.tables[tableName];
            return {
                tableName: tableName,
                originalFileName: c?.originalFileName,
                originalFields: m ? Object.keys(m.fields) : []
            };
        });

        // Find the most complete metadata from any member (Grain/CandidateKeys)
        const bestMember = group.reduce((prev, curr) => {
            const currentC = newClassifications.find(item => item.tableName === curr);
            const prevC = newClassifications.find(item => item.tableName === prev);
            // Prefer structured grain objects or non-empty string grains
            const currentHasGrain = currentC?.grain && (typeof currentC.grain === 'object' ? currentC.grain.grainFields?.length > 0 : currentC.grain.length > 0);
            return currentHasGrain ? curr : prev;
        }, group[0]);

        const firstMemberData = newClassifications.find(item => item.tableName === bestMember);

        const virtualClassification = {
            tableName: consolidatedName,
            role: 'FACT',
            fieldClassifications: {},
            constituentTables: constituents,
            grain: firstMemberData?.grain || null,
            candidateKeys: firstMemberData?.candidateKeys || []
        };

        const virtualMetadataTable = {
            tableName: consolidatedName,
            rowCount: 0,
            fields: {},
            isVirtual: true,
            sourceTables: group
        };

        group.forEach(tableName => {
            const c = newClassifications.find(item => item.tableName === tableName);
            const m = newMetadata.tables[tableName];

            if (!c || !m) return;

            virtualMetadataTable.rowCount = Math.max(virtualMetadataTable.rowCount, m.rowCount);

            Object.keys(m.fields).forEach(col => {
                if (!virtualMetadataTable.fields[col]) {
                    virtualMetadataTable.fields[col] = JSON.parse(JSON.stringify(m.fields[col]));
                    virtualClassification.fieldClassifications[col] = JSON.parse(JSON.stringify(c.fieldClassifications[col]));
                } else {
                    const f = virtualMetadataTable.fields[col];
                    f.nullCount = (f.nullCount || 0) + (m.fields[col].nullCount || 0);
                    f.distinctCount = Math.max(f.distinctCount || 0, m.fields[col].distinctCount || 0);
                }
            });

            // Remove original tables
            const idx = newClassifications.findIndex(item => item.tableName === tableName);
            if (idx !== -1) newClassifications.splice(idx, 1);
            delete newMetadata.tables[tableName];
        });

        newClassifications.push(virtualClassification);
        newMetadata.tables[consolidatedName] = virtualMetadataTable;

        // 3. Re-map Relationships
        newMetadata.relationships.overlap.forEach(rel => {
            const lastDotA = rel.fieldA.lastIndexOf('.');
            const tableA = rel.fieldA.substring(0, lastDotA);
            const colA = rel.fieldA.substring(lastDotA + 1);

            const lastDotB = rel.fieldB.lastIndexOf('.');
            const tableB = rel.fieldB.substring(0, lastDotB);
            const colB = rel.fieldB.substring(lastDotB + 1);

            if (group.includes(tableA)) rel.fieldA = `${consolidatedName}.${colA}`;
            if (group.includes(tableB)) rel.fieldB = `${consolidatedName}.${colB}`;
        });

        const dedupedOverlap = [];
        const seenOverlap = new Set();

        newMetadata.relationships.overlap.forEach(rel => {
            const lastDotA = rel.fieldA.lastIndexOf('.');
            const tableA = rel.fieldA.substring(0, lastDotA);
            const lastDotB = rel.fieldB.lastIndexOf('.');
            const tableB = rel.fieldB.substring(0, lastDotB);
            
            if (tableA === tableB) return;

            const key = `${rel.fieldA}<->${rel.fieldB}`;
            const altKey = `${rel.fieldB}<->${rel.fieldA}`;

            if (!seenOverlap.has(key) && !seenOverlap.has(altKey)) {
                dedupedOverlap.push(rel);
                seenOverlap.add(key);
            } else {
                const existing = dedupedOverlap.find(r => 
                    (r.fieldA === rel.fieldA && r.fieldB === rel.fieldB) || 
                    (r.fieldA === rel.fieldB && r.fieldB === rel.fieldA)
                );
                if (existing) {
                    existing.overlapRatioA = Math.max(existing.overlapRatioA, rel.overlapRatioA);
                    existing.overlapRatioB = Math.max(existing.overlapRatioB, rel.overlapRatioB);
                    existing.intersectionCount = Math.max(existing.intersectionCount, rel.intersectionCount);
                }
            }
        });
        newMetadata.relationships.overlap = dedupedOverlap;
    });

    return { metadata: newMetadata, classifications: newClassifications };
}

module.exports = {
    collapseFactGroups
};
