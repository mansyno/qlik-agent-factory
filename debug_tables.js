const { openSessionForApp } = require('./qlik_tools');

async function test() {
    console.log("Opening app...");
    const { session, appHandle } = await openSessionForApp('northwind3');
    console.log("Fetching tables...");
    const tableList = await appHandle.getTablesAndKeys({ qWindowSize: { qcx: 100, qcy: 100 }, qNullSize: { qcx: 0, qcy: 0 }, qCellHeight: 0, qSyntheticMode: false, qIncludeSysVars: false });

    console.log(JSON.stringify(tableList, null, 2));

    await session.close();
}

test().catch(console.error);
