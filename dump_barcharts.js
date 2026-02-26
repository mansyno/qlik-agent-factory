const { openSessionForApp } = require('./qlik_tools');

async function main() {
    const appName = 'northwind_dan';
    console.log(`Connecting to ${appName}...`);
    const conn = await openSessionForApp(appName);
    const sessionApp = conn.appHandle;

    const listParams = {
        qInfo: { qType: 'AppPropsList' },
        qAppObjectListDef: { qType: 'barchart', qData: { title: '/title', tags: '/tags' } }
    };

    const sessionObj = await sessionApp.createSessionObject(listParams);
    const layout = await sessionObj.getLayout();

    const items = layout.qAppObjectList.qItems;
    console.log(`Found ${items.length} barchart(s).`);

    for (const item of items) {
        const objHandle = await sessionApp.getObject(item.qInfo.qId);
        const props = await objHandle.getProperties();
        console.log(`\n==== BARCHART ID: ${item.qInfo.qId} ====`);
        console.log(JSON.stringify(props, null, 2));
    }

    process.exit(0);
}

main().catch(console.error);
