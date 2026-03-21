const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger');
const Handlebars = require('handlebars');

function loadTemplate(templateId) {
    try {
        const tplPath = path.join(__dirname, 'templates', 'layout', `${templateId}.json`);
        const content = fs.readFileSync(tplPath, 'utf8');
        return content;
    } catch (e) {
        logger.error('LayoutComposer', `Failed to load template '${templateId}'`, e);
        return null; // Signals template missing
    }
}

/**
 * Creates a "Logic Fingerprint" of a Qlik expression by stripping all 
 * syntax noise (brackets, spaces, casing) to compare mathematical intent.
 */
function normalizeExpression(expr) {
    if (!expr) return '';
    return expr
        .replace(/[\[\]]/g, '')      // Remove brackets: [Sales] -> Sales
        .replace(/\s+/g, '')         // Remove all spaces
        .replace(/["']/g, '')        // Remove quotes
        .trim()
        .toLowerCase();
}

async function findMasterItem(sessionApp, type, id, title, expression) {
    const listDef = {
        qInfo: { qType: type === 'measure' ? 'MeasureList' : 'DimensionList' },
        [type === 'measure' ? 'qMeasureListDef' : 'qDimensionListDef']: {
            qType: type,
            qData: { 
                description: '/qMetaDef/description',
                title: '/qMetaDef/title'
            }
        }
    };
    const sessionObj = await sessionApp.createSessionObject(listDef);
    const layout = await sessionObj.getLayout();
    const items = type === 'measure' ? layout.qMeasureList.qItems : layout.qDimensionList.qItems;
    await sessionApp.destroySessionObject(layout.qInfo.qId);

    const targetFingerprint = normalizeExpression(expression);

    // Stage 1: ID Match (Legacy/Consistency support)
    for (const item of items) {
        const desc = (item.qData && item.qData.description) || (item.qMeta && item.qMeta.description);
        if (desc === `Agent generated ${type}: ${id}`) {
            logger.log('LayoutComposer', `Found item by ID match: ${item.qInfo.qId}`);
            return item.qInfo.qId;
        }
    }

    // Stage 2: Logic First (Expression Match)
    // If the math is the same, reuse it, regardless of the Title or virtual ID.
    for (const item of items) {
        try {
            const handle = await (type === 'measure' ? sessionApp.getMeasure(item.qInfo.qId) : sessionApp.getDimension(item.qInfo.qId));
            const props = await handle.getProperties();
            const existingExpr = type === 'measure' ? props.qMeasure.qDef : props.qDim.qFieldDefs[0];
            
            if (normalizeExpression(existingExpr) === targetFingerprint) {
                const existingTitle = (item.qData && item.qData.title) || (item.qMeta && item.qMeta.title);
                logger.log('LayoutComposer', `Expression Match! Reusing '${existingTitle}' (${item.qInfo.qId}) for logic: ${expression}`);
                return item.qInfo.qId;
            }
        } catch (err) {
            logger.debug('LayoutComposer', `Skipping unreadable item ${item.qInfo.qId}`);
        }
    }

    return null;
}

async function createMasterItem(sessionApp, type, id, title, expression) {
    const existingId = await findMasterItem(sessionApp, type, id, title, expression);
    if (existingId) {
        logger.log('LayoutComposer', `Master ${type} '${id}' (${title}) resolved to ${existingId}. Reusing.`);
        return existingId;
    }

    logger.log('LayoutComposer', `Creating Master ${type} '${id}' -> ${expression}`);
    const qInfo = { qType: type }; // Let Qlik generate the UUID

    if (type === 'measure') {
        const props = {
            qInfo,
            qMeasure: { qLabel: title, qDef: expression },
            qMetaDef: { title, description: `Agent generated measure: ${id}` }
        };
        const handle = await sessionApp.createMeasure(props);
        const layout = await handle.getLayout();
        return layout.qInfo.qId;
    } else if (type === 'dimension') {
        const props = {
            qInfo,
            qDim: {
                qGrouping: "N",
                qFieldDefs: [expression],
                qFieldLabels: [title]
            },
            qMetaDef: { title, description: `Agent generated dimension: ${id}` }
        };
        const handle = await sessionApp.createDimension(props);
        const layout = await handle.getLayout();
        return layout.qInfo.qId;
    }
}

async function injectAndCreateObject(sessionApp, sheetObj, widgetDef) {
    const rawTemplate = loadTemplate(widgetDef.templateId);
    if (!rawTemplate) return null;

    // Ensure backwards compatibility properties exist for legacy templates
    const templateData = {
        ...widgetDef,
        MEASURE_1: (widgetDef.resolvedMeasures && widgetDef.resolvedMeasures.length > 0 ? widgetDef.resolvedMeasures[0].id : ''),
        MEASURE_1_CID: (widgetDef.resolvedMeasures && widgetDef.resolvedMeasures.length > 0 ? widgetDef.resolvedMeasures[0].cid : ''),
        DIMENSION_1: (widgetDef.resolvedDimensions && widgetDef.resolvedDimensions.length > 0 ? widgetDef.resolvedDimensions[0].id : ''),
        DIMENSION_1_CID: (widgetDef.resolvedDimensions && widgetDef.resolvedDimensions.length > 0 ? widgetDef.resolvedDimensions[0].cid : ''),
        TITLE: widgetDef.title || 'Untitled'
    };

    const template = Handlebars.compile(rawTemplate);
    let injected = template(templateData);

    try {
        const jsonProps = JSON.parse(injected);
        // DO NOT interact with Engine API yet! Just generate a random ID and return the raw properties.
        const uniqueId = 'AgentObj_' + Math.random().toString(36).substring(2, 8);
        jsonProps.qInfo.qId = uniqueId;

        logger.log('LayoutComposer', `Prepared ${widgetDef.templateId} chart properties: ${uniqueId}`);

        return {
            id: uniqueId,
            properties: jsonProps,
            grid: widgetDef.grid
        };
    } catch (parseErr) {
        logger.error('LayoutComposer', `Failed to parse injected JSON for ${widgetDef.templateId}: ${parseErr.message}`);
        logger.debug('LayoutComposer', `Injected content: ${injected}`);
        throw parseErr;
    }
}

async function composeLayout(sessionApp, layoutPlan, existingItems = null) {
    if (!layoutPlan || !layoutPlan.blueprint) {
        logger.error('LayoutComposer', 'Invalid or missing layout plan form LayoutBrain');
        return false;
    }

    try {
        // Step 1: Create Master Items and capture their true Engine IDs
        logger.log('LayoutComposer', '--- Phase 1: Resolving Master Items ---');
        const idMap = {};
        const cidMap = {};

        // Helper function to generate stable visual IDs
        const generateCid = () => Math.random().toString(36).substring(2, 8);

        // Pre-populate Map with existing items so AI can refer to them by Title or GUID
        if (existingItems) {
            [...existingItems.dimensions, ...existingItems.measures].forEach(item => {
                idMap[item.title] = item.id;
                idMap[item.id] = item.id; // GUID fallback
                if (!cidMap[item.id]) cidMap[item.id] = generateCid();
            });
        }

        for (const dim of layoutPlan.masterItems?.dimensions || []) {
            const realId = await createMasterItem(sessionApp, 'dimension', dim.id, dim.title, dim.expression);
            idMap[dim.id] = realId;
            idMap[dim.title] = realId;
            if (!cidMap[realId]) cidMap[realId] = generateCid();
        }
        for (const msr of layoutPlan.masterItems?.measures || []) {
            const realId = await createMasterItem(sessionApp, 'measure', msr.id, msr.title, msr.expression);
            idMap[msr.id] = realId;
            idMap[msr.title] = realId;
            if (!cidMap[realId]) cidMap[realId] = generateCid();
        }

        // Setup fallbacks in case the LLM unlinks a chart or hallucinated an array
        const fallbackDimId = layoutPlan.masterItems?.dimensions?.[0]?.id || null;
        const fallbackMsrId = layoutPlan.masterItems?.measures?.[0]?.id || null;

        // Apply true IDs and CIDs to blueprint
        for (const widget of layoutPlan.blueprint) {
            // Support both old and new formats by forcing into arrays
            const rawDims = widget.dimensions || (widget.masterDimensionId ? [widget.masterDimensionId] : (fallbackDimId ? [fallbackDimId] : []));
            const rawMsrs = widget.measures || (widget.masterMeasureId ? [widget.masterMeasureId] : (fallbackMsrId ? [fallbackMsrId] : []));

            widget.resolvedDimensions = rawDims.filter(id => idMap[id]).map(id => ({
                id: idMap[id],
                cid: cidMap[id]
            }));

            widget.resolvedMeasures = rawMsrs.filter(id => idMap[id]).map(id => ({
                id: idMap[id],
                cid: cidMap[id]
            }));

            // Generate order arrays for table, linechart, and barchart templates dynamically
            if (['table', 'linechart', 'barchart'].includes(widget.templateId)) {
                const totalColumns = widget.resolvedDimensions.length + widget.resolvedMeasures.length;
                const seq = Array.from({length: totalColumns}, (_, i) => i);
                widget.qInterColumnSortOrder = JSON.stringify(seq);
                widget.qColumnOrder = JSON.stringify(seq);
                
                if (widget.templateId === 'table') {
                    const widths = Array.from({length: totalColumns}, () => -1);
                    widget.columnWidths = JSON.stringify(widths);
                }
            }
        }

        // Step 2: Create Base Sheet
        logger.log('LayoutComposer', '--- Phase 2: Creating Executive Dashboard Sheet ---');
        const sheetProps = {
            qInfo: { qType: 'sheet' },
            qMetaDef: { title: 'Executive Dashboard (Agent Generated)', description: 'Auto-generated by Agent 4' },
            columns: 24,
            rows: 24,
            gridResolution: 'small',
            cells: [],
            qChildListDef: {
                qData: { title: '/title' }
            }
        };
        const sheetObj = await sessionApp.createObject(sheetProps);
        const sheetLayout = await sheetObj.getLayout();
        const sheetId = sheetLayout.qInfo.qId;
        logger.log('LayoutComposer', `Base sheet created with ID: ${sheetId}`);

        // Step 3: Inject & Prepare Chart Properties
        logger.log('LayoutComposer', '--- Phase 3: Building & Mounting Charts ---');
        const createdCells = [];
        const qChildren = []; // <--- The massive Engine API fix

        for (const widget of layoutPlan.blueprint) {
            const chartData = await injectAndCreateObject(sessionApp, sheetObj, widget);
            if (chartData) {
                // Add the raw properties to the Sheet's physical children hierarchy
                qChildren.push({
                    qProperty: chartData.properties,
                    qChildren: []
                });

                // Map the LLM's virtual coordinate grid to Qlik's internal visual schema
                createdCells.push({
                    name: chartData.id,
                    type: widget.templateId,
                    col: chartData.grid.x,
                    row: chartData.grid.y,
                    colspan: chartData.grid.width,
                    rowspan: chartData.grid.height,
                    bounds: {
                        y: (chartData.grid.y * 100) / 24,
                        x: (chartData.grid.x * 100) / 24,
                        width: (chartData.grid.width * 100) / 24,
                        height: (chartData.grid.height * 100) / 24
                    }
                });
            }
        }

        // Step 4: Mount Charts to Sheet via Full Property Tree
        const finalSheetProps = await sheetObj.getProperties();
        finalSheetProps.cells = createdCells;

        // This is exactly how the Drag-and-Drop React UI performs physical mounts
        const fullTree = {
            qProperty: finalSheetProps,
            qChildren: qChildren
        };

        await sheetObj.setFullPropertyTree(fullTree);
        logger.log('LayoutComposer', `Successfully mounted ${qChildren.length} native child objects to Dashboard.`);

        return true;
    } catch (e) {
        logger.error('LayoutComposer', 'Critical failure during Layout Assembly', e);
        return false;
    }
}

async function getExistingMasterItems(sessionApp) {
    const listDef = {
        qInfo: { qType: 'MasterItemList' },
        qMeasureListDef: { qType: 'measure', qData: { title: '/qMetaDef/title' } },
        qDimensionListDef: { qType: 'dimension', qData: { title: '/qMetaDef/title' } }
    };
    const sessionObj = await sessionApp.createSessionObject(listDef);
    const layout = await sessionObj.getLayout();
    await sessionApp.destroySessionObject(layout.qInfo.qId);

    const results = { dimensions: [], measures: [] };

    for (const item of layout.qDimensionList.qItems) {
        try {
            const handle = await sessionApp.getDimension(item.qInfo.qId);
            const props = await handle.getProperties();
            results.dimensions.push({
                id: item.qInfo.qId,
                title: props.qMetaDef.title,
                expression: props.qDim.qFieldDefs[0]
            });
        } catch (e) {}
    }

    for (const item of layout.qMeasureList.qItems) {
        try {
            const handle = await sessionApp.getMeasure(item.qInfo.qId);
            const props = await handle.getProperties();
            results.measures.push({
                id: item.qInfo.qId,
                title: props.qMetaDef.title,
                expression: props.qMeasure.qDef
            });
        } catch (e) {}
    }

    return results;
}

module.exports = { composeLayout, getExistingMasterItems };
