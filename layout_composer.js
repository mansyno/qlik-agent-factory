const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger');

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

async function findMasterItem(sessionApp, type, id) {
    const listDef = {
        qInfo: { qType: type === 'measure' ? 'MeasureList' : 'DimensionList' },
        [type === 'measure' ? 'qMeasureListDef' : 'qDimensionListDef']: {
            qType: type,
            qData: { description: '/qMetaDef/description' }
        }
    };
    const sessionObj = await sessionApp.createSessionObject(listDef);
    const layout = await sessionObj.getLayout();
    const items = type === 'measure' ? layout.qMeasureList.qItems : layout.qDimensionList.qItems;
    await sessionApp.destroySessionObject(layout.qInfo.qId);

    for (const item of items) {
        const desc = (item.qData && item.qData.description) || (item.qMeta && item.qMeta.description);
        if (desc === `Agent generated ${type}: ${id}`) {
            return item.qInfo.qId;
        }
    }
    return null;
}

async function createMasterItem(sessionApp, type, id, title, expression) {
    const existingId = await findMasterItem(sessionApp, type, id);
    if (existingId) {
        logger.log('LayoutComposer', `Master ${type} '${id}' already exists as ${existingId}. Reusing.`);
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

    // String Replacement Strategy (JSON Vaccine)
    let injected = rawTemplate
        .replace(/\{\{MEASURE_1\}\}/g, widgetDef.masterMeasureId || '')
        .replace(/\{\{MEASURE_1_CID\}\}/g, widgetDef.masterMeasureCid || '')
        .replace(/\{\{DIMENSION_1\}\}/g, widgetDef.masterDimensionId || '')
        .replace(/\{\{DIMENSION_1_CID\}\}/g, widgetDef.masterDimensionCid || '')
        .replace(/\{\{TITLE\}\}/g, widgetDef.title || 'Untitled');

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
}

async function composeLayout(sessionApp, layoutPlan) {
    if (!layoutPlan || !layoutPlan.blueprint) {
        logger.error('LayoutComposer', 'Invalid or missing layout plan form LayoutBrain');
        return false;
    }

    try {
        // Step 1: Create Master Items and capture their true Engine IDs
        logger.log('LayoutComposer', '--- Phase 1: Creating Master Items ---');
        const idMap = {};
        const cidMap = {};

        // Helper function scoped if needed or assuming it exists
        const generateCid = () => Math.random().toString(36).substring(2, 8);

        for (const dim of layoutPlan.masterItems?.dimensions || []) {
            const realId = await createMasterItem(sessionApp, 'dimension', dim.id, dim.title, dim.expression);
            idMap[dim.id] = realId;
            cidMap[dim.id] = generateCid(); // Generate a CID for each master dimension 
        }
        for (const msr of layoutPlan.masterItems?.measures || []) {
            const realId = await createMasterItem(sessionApp, 'measure', msr.id, msr.title, msr.expression);
            idMap[msr.id] = realId;
            cidMap[msr.id] = generateCid(); // Generate a CID for each master item
        }

        // Setup fallbacks in case the LLM unlinks a chart or hallucinated an array
        const fallbackDimId = layoutPlan.masterItems?.dimensions?.[0]?.id || null;
        const fallbackMsrId = layoutPlan.masterItems?.measures?.[0]?.id || null;

        // Apply true IDs and CIDs to blueprint
        for (const widget of layoutPlan.blueprint) {
            let dimId = widget.masterDimensionId || (widget.dimensions && widget.dimensions[0]) || fallbackDimId;
            let msrId = widget.masterMeasureId || (widget.measures && widget.measures[0]) || fallbackMsrId;

            if (dimId && idMap[dimId]) {
                widget.masterDimensionId = idMap[dimId];
                widget.masterDimensionCid = cidMap[dimId];
            }
            if (msrId && idMap[msrId]) {
                widget.masterMeasureId = idMap[msrId];
                widget.masterMeasureCid = cidMap[msrId];
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
        console.error("DEBUG LayoutComposer Error:", e);
        logger.error('LayoutComposer', 'Critical failure during Layout Assembly', e);
        return false;
    }
}

module.exports = { composeLayout };
