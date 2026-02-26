const { openSessionForApp } = require('./qlik_tools');

async function testChart(sessionApp, name, qDimensions, qMeasures) {
    console.log(`\nTesting: ${name}`);
    const props = {
        qInfo: { qType: 'barchart' },
        qHyperCubeDef: {
            qDimensions,
            qMeasures,
            qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: 2, qHeight: 100 }]
        }
    };
    try {
        const obj = await sessionApp.createSessionObject(props);
        const layout = await obj.getLayout();
        const data = layout.qHyperCube.qDataPages[0]?.qMatrix || [];
        console.log(`✅ Success! Data rows returned: ${data.length}`);
    } catch (err) {
        console.log(`❌ Failed: ${err.message}`);
    }
}

async function main() {
    console.log('Connecting to northwind_dan...');
    const conn = await openSessionForApp('northwind_dan');
    const sessionApp = conn.appHandle;

    await testChart(sessionApp, "1. Just qLibraryId",
        [{ qLibraryId: "Dim_Category" }],
        [{ qLibraryId: "Sum_Sales" }]
    );

    await testChart(sessionApp, "2. qLibraryId + empty qDef",
        [{ qLibraryId: "Dim_Category", qDef: {} }],
        [{ qLibraryId: "Sum_Sales", qDef: {} }]
    );

    await testChart(sessionApp, "3. qLibraryId + qDef with qSortCriterias",
        [{
            qLibraryId: "Dim_Category",
            qDef: { qSortCriterias: [{ qSortByNumeric: 1 }] }
        }],
        [{ qLibraryId: "Sum_Sales" }]
    );

    process.exit(0);
}

main().catch(console.error);
