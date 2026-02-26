const fs = require('fs');
const enigma = require('enigma.js');
const WebSocket = require('ws');
const schema = require('enigma.js/schemas/12.170.2.json');

async function run() {
    console.log("Connecting to northwind_dan...");
    const session = enigma.create({
        schema,
        url: 'ws://localhost:9076/app/engineData',
        createSocket: url => new WebSocket(url)
    });

    const qix = await session.open();
    const doc = await qix.openDoc('northwind_dan');

    // Get list of all sheets to find the charts
    const listDef = {
        qInfo: { qType: 'SheetList' },
        qAppObjectListDef: { qType: 'sheet', qData: { cells: '/cells' } }
    };
    const listObj = await doc.createSessionObject(listDef);
    const layout = await listObj.getLayout();
    const sheets = layout.qAppObjectList.qItems;

    if (sheets.length === 0) {
        console.log("No sheets found!");
        process.exit(1);
    }

    const cells = sheets[0].qData.cells;
    console.log(`Found ${cells.length} objects on the sheet.`);

    let originalProps = null;
    let copiedProps = null;

    for (const cell of cells) {
        try {
            const obj = await doc.getObject(cell.name);
            const props = await obj.getProperties();

            if (props.title === 'Sales by Category') {
                console.log(`Found Original Chart! ID: ${cell.name}`);
                originalProps = props;
            } else if (props.title === 'daniel') {
                console.log(`Found Copied Chart 'daniel'! ID: ${cell.name}`);
                copiedProps = props;
            }
        } catch (e) {
            console.log(`Could not get object ${cell.name}:`, e.message);
        }
    }

    if (originalProps) {
        fs.writeFileSync('original_chart.json', JSON.stringify(originalProps, null, 2));
        console.log("Saved original_chart.json");
    }
    if (copiedProps) {
        fs.writeFileSync('copied_chart_daniel.json', JSON.stringify(copiedProps, null, 2));
        console.log("Saved copied_chart_daniel.json");
    }

    console.log('Done mapping.');
    process.exit(0);
}

run();
