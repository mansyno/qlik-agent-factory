/**
 * enhancer_heuristics.js
 * Contains deterministic rules and pre-flight inspection hints 
 * previously embedded within the orchestrator.
 */

function runDeterministicChecks(metadata, broadcast) {
    const deterministicPlan = [];
    
    // 1. Check for as_of_table
    let hasDate = false;
    let dateField = 'CanonicalDate';
    let sourceTable = 'MasterCalendar'; // Default fallback
    
    // First pass: look for CanonicalDate (preferred)
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        if (table.fields.some(f => f.name === 'CanonicalDate')) {
            hasDate = true;
            dateField = 'CanonicalDate';
            sourceTable = tableName;
            break;
        }
    }
    
    // Second pass: if no CanonicalDate, find ANY date field
    if (!hasDate) {
        for (const [tableName, table] of Object.entries(metadata.tables)) {
            const dateF = table.fields.find(f => f.tags && (f.tags.includes('$date') || f.tags.includes('$timestamp')));
            if (dateF) {
                hasDate = true;
                dateField = dateF.name;
                sourceTable = tableName;
                break;
            }
        }
    }
    
    if (hasDate) {
        broadcast('Enhancer', `Deterministic Match: Added [as_of_table] for ${dateField} in ${sourceTable}`, 'info');
        deterministicPlan.push({
            tier: 'catalog',
            toolId: 'as_of_table',
            parameters: { 
                dateField,
                sourceTable
            }
        });
    }
    
    // 2. Check for dual_flag_injector
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        for (const field of table.fields) {
            // Exclude % fields (hidden/keys)
            if (field.name.startsWith('%')) continue;

            // Exclude fields that are JUST metadata like 'SourceTable_XXXX' unless they are actual flags
            if (field.name.includes('SourceTable') && !field.name.toLowerCase().includes('flag')) continue;

            // Exclude numeric/measure fields — dual flags are for text/categorical fields only
            const isNumeric = field.tags && (field.tags.includes('$numeric') || field.tags.includes('$integer'));
            if (isNumeric) continue;
            
            const isCalendar = /^(Year|Month|Quarter|Week|Day|WeekDay|MonthYear|Date_Diff|Month_Diff|Year_Diff|Date|Time|Timestamp)$/i.test(field.name) || (field.tags && (field.tags.includes('$date') || field.tags.includes('$timestamp')));
            if (isCalendar) continue;

            const isKnownFlagName = /flag|status|yes|no|active|valid|binary|imported|return/i.test(field.name);
            const hasTwoValues = field.distinctCount === 2 && field.sampleValues && field.sampleValues.length === 2;
            
            if (hasTwoValues) {
                const valStr = field.sampleValues.map(v => String(v).toLowerCase());
                const isFlagContent = valStr.some(v => 
                    ['yes', 'no', 'y', 'n', '1', '0', 'true', 'false', 'active', 'inactive'].includes(v)
                );

                // HIGH CONFIDENCE -> Deterministic Plan
                if (isKnownFlagName || isFlagContent) {
                    broadcast('Enhancer', `Deterministic Match: Added [dual_flag_injector] for ${tableName}.${field.name}`, 'info');
                    const mappingPairs = field.sampleValues.map(v => `'${v}'`).join(', ');
                    deterministicPlan.push({
                        tier: 'catalog',
                        toolId: 'dual_flag_injector',
                        parameters: { 
                            targetTable: tableName, 
                            fieldName: field.name,
                            mappingPairs
                        }
                    });
                }
            }
        }
    }
    
    return deterministicPlan;
}

/**
 * Stage A2: Pre-Flight Inspection
 * Scans metadata for patterns like Pareto and Market Basket to provide hints to the LLM.
 */
function runPreFlightInspection(metadata) {
    const hints = [];
    const factTables = [];
    const linkTable = metadata.tables['LinkTable'] || metadata.tables['Link Table'];

    // Identify Facts and Potential Flags
    for (const [tableName, table] of Object.entries(metadata.tables)) {
        if (tableName === 'LinkTable' || tableName === 'MasterCalendar' || tableName === 'CanonicalDateBridge') continue;
        
        const hasMeasure = table.fields.some(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'));
        if (hasMeasure) factTables.push(tableName);

        // Ambiguous 2-value fields -> Hint for LLM to decide
        table.fields.forEach(field => {
            if (field.name.startsWith('%')) return;
            // Exclude numeric fields — dual flags only apply to text/categorical fields
            const isNumeric = field.tags && (field.tags.includes('$numeric') || field.tags.includes('$integer'));
            if (isNumeric) return;
            const isCalendar = /^(Year|Month|Quarter|Week|Day|WeekDay|MonthYear|Date_Diff|Month_Diff|Year_Diff|Date|Time|Timestamp)$/i.test(field.name) || (field.tags && (field.tags.includes('$date') || field.tags.includes('$timestamp')));
            if (isCalendar) return;

            if (field.distinctCount === 2 && field.sampleValues && field.sampleValues.length === 2) {
                const isKnownFlagName = /flag|status|yes|no|active|valid|binary|imported|return/i.test(field.name);
                const valStr = field.sampleValues.map(v => String(v).toLowerCase());
                const isFlagContent = valStr.some(v => ['yes', 'no', 'y', 'n', '1', '0', 'true', 'false'].includes(v));

                // If NOT high confidence (deterministic), pass as a hint for LLM evaluation
                if (!isKnownFlagName && !isFlagContent) {
                    const values = field.sampleValues.join(', ');
                    hints.push(`Dual Injection Candidate: table='${tableName}', field='${field.name}', values='${values}' (LLM: evaluate if this should be a toggleable dual flag)`);
                }
            }
        });
    }

    // Pareto Hints (Fact + LinkTable/Direct + Dimension)
    if (factTables.length > 0) {
        factTables.forEach(fact => {
            const table = metadata.tables[fact];
            const measure = table.fields.find(f => f.tags && f.tags.includes('$numeric') && !f.name.startsWith('%') && !f.tags.includes('$key'))?.name;
            const key = `%Key_${fact}`;
            
            // If LinkTable exists, use it
            if (linkTable) {
                const linkFields = linkTable.fields.map(f => f.name);
                const dimensions = linkFields.filter(f => !f.startsWith('%') && f !== 'OrderID');
                if (measure && linkFields.includes(key) && dimensions.length > 0) {
                    const bestDim = dimensions.find(d => !d.toLowerCase().includes('source') && !d.toLowerCase().includes('id')) || dimensions[0];
                    hints.push(`Pareto Candidate: factTable='${fact}', linkTable='${linkTable.tableName || 'LinkTable'}', keyField='${key}', dimensionField='${bestDim}', measureField='${measure}'`);
                }
            } else {
                // Star Schema: Dimensions might be directly in the fact table or separate tables
                // For now, look for high-cardinality attributes in the fact table itself as Pareto candidates
                const dimensions = table.fields.filter(f => f.type === 'ATTRIBUTE' && f.distinctCount > 10 && !f.name.toLowerCase().includes('date') && !f.name.toLowerCase().includes('id'));
                if (measure && dimensions.length > 0) {
                    hints.push(`Pareto Candidate: factTable='${fact}', dimensionField='${dimensions[0].name}', measureField='${measure}' (Self-contained Pareto)`);
                }
            }
        });
    }

    // Market Basket Hints (1-to-many on LinkTable or Fact)
    const basketTarget = linkTable || metadata.tables[factTables[0]];
    if (basketTarget) {
        const fields = basketTarget.fields;
        const orderIdField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('order') || n.includes('trans') || n.includes('basket') || n.includes('header');
        })?.name;
        
        const itemField = fields.find(f => {
            const n = f.name.toLowerCase();
            return n.includes('product') || n.includes('item') || n.includes('article');
        })?.name;
        
        if (orderIdField && itemField) {
            hints.push(`Market Basket Candidate: factTable='${basketTarget.tableName || 'LinkTable'}', idField='${orderIdField}', itemField='${itemField}'`);
        }
    }

    return hints;
}

/**
 * Deduplicates the LLM plan against the deterministic plan.
 */
function deduplicatePlans(llmPlanRaw, deterministicPlan, logger) {
    return (llmPlanRaw || []).filter(llmTool => {
        // Filter out tools with empty parameters immediately to prevent rejection logs
        if (!llmTool.parameters || Object.keys(llmTool.parameters).length === 0) {
            logger.warn('Enhancer', `LLM proposed ${llmTool.toolId} with EMPTY parameters. Filtering out.`);
            return false;
        }

        // Sanitize mappingPairs if present (LLM often misses quotes or uses semicolons)
        if (llmTool.toolId === 'dual_flag_injector' && llmTool.parameters.mappingPairs) {
            let mp = String(llmTool.parameters.mappingPairs);
            // If it doesn't look like it has quotes, try to wrap the labels
            if (!mp.includes("'")) {
                // Replace semicolon with comma, then split by comma and try to quote strings
                mp = mp.replace(/;/g, ',');
                const parts = mp.split(',').map(p => {
                    p = p.trim();
                    return (isNaN(p) && !p.startsWith("'")) ? `'${p}'` : p;
                });
                llmTool.parameters.mappingPairs = parts.join(', ');
                logger.debug('Enhancer', `Sanitized mappingPairs for ${llmTool.parameters.fieldName}`);
            }
        }

        return !deterministicPlan.some(detTool => {
            if (detTool.toolId !== llmTool.toolId) return false;
            
            // Check if parameters match the key target fields
            if (detTool.toolId === 'as_of_table') {
                // For as_of_table, we consider it a duplicate if the target table is the same
                // or if the LLM proposes an as_of for a LinkTable when one is already deterministically planned.
                const detTarget = detTool.parameters.targetTable;
                const llmTarget = llmTool.parameters.targetTable;
                if (detTarget === llmTarget) return true;
                // If deterministic plan has an as_of for 'LinkTable' and LLM also proposes one, it's a duplicate.
                if (detTarget === 'LinkTable' && llmTarget === 'LinkTable') return true;
                return false;
            }
            if (detTool.toolId === 'dual_flag_injector') {
                return detTool.parameters.fieldName === llmTool.parameters.fieldName &&
                       detTool.parameters.targetTable === llmTool.parameters.targetTable;
            }
            return false; 
        });
    });
}

module.exports = {
    runDeterministicChecks,
    runPreFlightInspection,
    deduplicatePlans
};