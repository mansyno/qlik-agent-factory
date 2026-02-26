const { openSessionForApp } = require('./qlik_tools');

async function main() {
    console.log('Connecting to northwind_dan...');
    const conn = await openSessionForApp('northwind_dan');
    const sessionApp = conn.appHandle;

    const allObj = await sessionApp.getAllInfos();
    const sheets = allObj.filter(o => o.qType === 'sheet');
    console.log(`Found ${sheets.length} sheets.`);

    for (const s of sheets) {
        console.log(`\n==== SHEET: ${s.qId} ====`);
        const sheetObj = await sessionApp.getObject(s.qId);
        const props = await sheetObj.getLayout();
        console.log("CELLS ARRAY:");
        console.log(JSON.stringify(props.cells, null, 2));

        for (const cell of props.cells) {
            console.log(`\n--- CHART: ${cell.name} (${cell.type}) ---`);
            const chartObj = await sessionApp.getObject(cell.name);
            const chartProps = await chartObj.getProperties();
            console.log(JSON.stringify(chartProps, null, 2));
        }
    }

    process.exit(0);
}

main().catch(console.error);
