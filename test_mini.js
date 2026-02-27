const { openSession, validateScript, closeSession } = require('./qlik_tools');

async function testMini() {
    let sessionData = await openSession();
    try {
        const sessionApp = await sessionData.global.createSessionApp();
        const testScript = `
        FIRST 5
        [categories]:
        LOAD * FROM [d:\\A_i\\qlik\\poc architect agent\\northwind\\categories.csv]
        (txt, utf8, embedded labels, delimiter is ',', msq);
        `;
        const res = await validateScript(sessionData.global, testScript, sessionApp);
        console.log("Mini Test Result:", res);

        // Also let's try with forward slashes
        const testScript2 = `
        FIRST 5
        [categories]:
        LOAD * FROM [d:/A_i/qlik/poc architect agent/northwind/categories.csv]
        (txt, utf8, embedded labels, delimiter is ',', msq);
        `;
        const res2 = await validateScript(sessionData.global, testScript2, sessionApp);
        console.log("Mini Test 2 Result:", res2);

    } finally {
        await closeSession(sessionData.session);
    }
}

testMini().catch(console.error);
