const enigma = require('enigma.js');
const WebSocket = require('ws');
const schema = require('enigma.js/schemas/12.170.2.json');
const path = require('path');
const fs = require('fs');

async function openSession(appId = 'engineData') {
    const session = enigma.create({
        schema,
        url: `ws://localhost:4848/app/${encodeURIComponent(appId)}`,
        createSocket: url => new WebSocket(url),
    });
    const global = await session.open();
    return { session, global };
}

async function closeSession(session) {
    if (session) {
        await session.close();
    }
}

async function profileData(global, targetPath, app = null) {
    let sessionApp = app;
    try {
        if (!sessionApp) {
            sessionApp = await global.createSessionApp();
        }

        const dir = path.dirname(targetPath);
        const filename = path.basename(targetPath);
        const connectionName = 'TempData_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        // Create a folder connection to the directory
        await sessionApp.createConnection({
            qName: connectionName,
            qConnectionString: dir,
            qType: 'folder'
        });

        const loadScript = `
            FIRST 50
            LOAD *
            FROM [lib://${connectionName}/${filename}]
            (txt, utf8, embedded labels, delimiter is ',', msq);
        `;

        // console.log(`Debug: Load Script:\n${loadScript}`);

        await sessionApp.setScript(loadScript);
        const reloadResult = await sessionApp.doReload();

        if (!reloadResult) {
            // console.error('Debug: Reload Failed. Check if Qlik Sense Desktop supports folder creation via API or if path is accessible.');
            return { error: 'Reload failed (No data or invalid format)' };
        }

        const sessionObj = await sessionApp.createSessionObject({
            qInfo: { qType: 'FieldList' },
            qFieldListDef: {}
        });

        const layout = await sessionObj.getLayout();
        const fieldList = layout.qFieldList.qItems;

        const fields = [];
        for (const field of fieldList) {
            const fieldData = await sessionApp.getField(field.qName);
            const card = await fieldData.getCardinal();
            fields.push({
                name: field.qName,
                distinctCount: card
            });
        }

        return { fields };

    } catch (err) {
        return { error: err.message };
    }
}

async function validateScript(global, scriptContent, app = null) {
    let sessionApp = app;
    try {
        if (!sessionApp) {
            sessionApp = await global.createSessionApp();
        }
        await sessionApp.setScript(scriptContent);

        const syntaxCheck = await sessionApp.checkScriptSyntax();
        if (syntaxCheck.length > 0) {
            return {
                success: false,
                synKeys: 0,
                errors: syntaxCheck.map(e => e.qErrorString || 'Syntax Error')
            };
        }

        const reloadResult = await sessionApp.doReload();

        if (!reloadResult) {
            return {
                success: false,
                synKeys: 0,
                errors: ['Reload failed (Runtime error)']
            };
        }

        const tables = await sessionApp.getTablesAndKeys({}, {}, 0, true, false);
        const synTables = tables.qtr.filter(t => t.qName.startsWith('$Syn'));
        const synKeys = synTables.length;

        return {
            success: true,
            synKeys: synKeys,
            errors: []
        };

    } catch (err) {
        return {
            success: false,
            synKeys: 0,
            errors: [err.message]
        };
    }
}

async function createConnection(app, name, pathStr) {
    try {
        await app.createConnection({
            qName: name,
            qConnectionString: pathStr,
            qType: 'folder'
        });
        return true;
    } catch (err) {
        // Ignore if already exists (error 20002 or similar? logic needed if strict)
        // console.log("Connection might already exist: " + err.message);
        return false;
    }
}

async function createPersistentApp(global, appName) {
    try {
        console.log(`Creating persistent app: ${appName}...`);
        const newApp = await global.createApp(appName);

        // Open the app to get the handle
        const appHandle = await global.openDoc(newApp.qAppId);
        console.log(`App created and opened. ID: ${newApp.qAppId}`);
        return appHandle;
    } catch (err) {
        // If app already exists, we might want to open it instead or delete/recreate
        if (err.message.includes('already exists') || err.message.includes('App already open')) {
            console.log(`App '${appName}' already exists/open. attempting to attach...`);
            try {
                const appHandle = await global.openDoc(appName);
                return appHandle;
            } catch (openErr) {
                // If openDoc fails with "App already open", it usually means we need to getActiveDoc or it's open in another session?
                // Actually, if openDoc fails, let's try getActiveDoc if we were in a browser, but here we are in a raw socket.
                // In Qlik Sense Desktop, openDoc works even if open in Hub.
                // But let's log specifically.
                console.log("Could not open existing app: " + openErr.message);
                throw openErr;
            }
        }
        throw err;
    }
}

module.exports = {
    openSession,
    closeSession,
    profileData,
    validateScript,
    createConnection,
    createPersistentApp
};
