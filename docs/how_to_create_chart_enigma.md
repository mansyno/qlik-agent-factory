📌 AI Agent Instructions — Build & Add a Chart in Qlik Sense Desktop Using Enigma.js
1. Set Up Your Environment

Install Dependencies

Ensure enigma.js and a WebSocket library (e.g., ws) are installed:

npm install enigma.js ws

Import Required Modules

Import Enigma and the appropriate QIX schema (matching your Sense Desktop version).

2. Connect to Qlik Sense Desktop

Create an Enigma Session

Provide the correct WebSocket URL to Qlik Sense Desktop’s engine (typically ws://localhost:9076/app/ or similar depending on your setup).

Open the Qlik App

Await session.open() and then call global.openDoc(appId) to open the application you want to query.

3. Define the Chart (Hypercube)

The chart will be powered by a Hypercube definition which tells the Qlik engine what data to return.

Prepare a Hypercube Definition Object

Use a JavaScript object with a qHyperCubeDef property.

Include dimensions and measures:

Dimension – Field you want to group by (e.g., "Region").

Measure – Expression to calculate (e.g., =Sum([Sales])).

Provide a qInitialDataFetch section with qWidth equal to number of columns (dimensions + measures) and a qHeight for max rows to fetch.

Example definition for a pie chart showing revenue by region:

const chartDef = {
  qInfo: { qType: "chart" },
  qHyperCubeDef: {
    qDimensions: [{
      qDef: { qFieldDefs: ["Region"] },
      qNullSuppression: true
    }],
    qMeasures: [{
      qDef: { qDef: "=Sum([Sales Quantity]*[Sales Price])" }
    }],
    qInitialDataFetch: [{
      qLeft: 0,
      qWidth: 2,
      qTop: 0,
      qHeight: 1000
    }]
  }
};

4. Create the Session Object & Fetch Data

Create the Chart Object

const chartObj = await app.createSessionObject(chartDef);

Get the Layout

const chartLayout = await chartObj.getLayout();

Extract Data

Within chartLayout.qHyperCube.qDataPages[0].qMatrix, each row has cells for your dimension and measure.

Map this into an array you can use for chart rendering:

const data = chartLayout.qHyperCube.qDataPages[0].qMatrix.map(row => {
  return [row[0].qText, row[1].qNum];
});
5. Render the Chart in the Browser

Enigma.js does not render visualizations by itself — it returns the data; you must use a client library to display the chart.

Pick a visualization tool (e.g., C3.js, D3.js, Chart.js, or any other library).

Bind your chart to a DOM element and pass the data from step 4.

Example with C3.js:

c3.generate({
  bindTo: "#chart",
  data: {
    columns: data,
    type: 'donut'
  },
  donut: {
    title: "Revenue by Region"
  }
});

6. (Optional) Handle Selections & Updates

If you need filtering interactions (like clicking a legend item and applying a selection), you can:

Listen to user events.

Call genericObject.selectHyperCubeValues(pathToHyperCube, [elemNumbers], toggle) to trigger selections.

Re-fetch data and re-render the chart whenever selections change.

⚠️ Notes / Best Practices

✔ Hypercubes are just data queries — you must visualize the results yourself as Enigma.js doesn’t embed Qlik UI charts.
✔ Session objects are transient and not saved to the Qlik app unless explicitly created as persistent objects.

If you want, I can also generate a complete starter code template (HTML + JavaScript) that implements these steps end-to-end.

no no i mean to have this chart inside an exisintg sheet in an app on qlik sense desktop

Below are clear, structured instructions for an AI agent to correctly create a chart and add it to an existing sheet in Qlik Sense Desktop (by Qlik) using the Engine API via enigma.js.

This process creates a persistent visualization object (not a session object) and attaches it to an existing sheet.

✅ Objective

Create a chart object and programmatically insert it into an existing sheet inside a Qlik Sense Desktop app using enigma.js.

🔷 High-Level Process

Connect to Qlik Engine (Desktop)

Open the target app

Locate the existing sheet

Create a persistent visualization object

Add the object to the sheet

Save the app

🔷 Step-by-Step AI Agent Instructions
1️⃣ Connect to Qlik Sense Desktop Engine

Open a WebSocket session to:

ws://localhost:9076/app/

Use the correct schema matching the installed Qlik Sense Desktop version.

Open the app using:

global.openDoc(appId)

The returned handle is your app object.

2️⃣ Locate the Existing Sheet

You must obtain the sheet’s object ID.

Option A – If Sheet ID Is Known

Use:

app.getObject(sheetId)
Option B – If Sheet ID Is Unknown

Retrieve sheet list:

app.getAppObjectList('sheet')

From the returned list:

Identify the correct sheet by title (qMeta.title)

Extract its qInfo.qId

Store this as:

sheetId
3️⃣ Create a Persistent Chart Object (NOT Session Object)

⚠️ Important:
Use createObject() — NOT createSessionObject()
Session objects are temporary and will NOT appear in the sheet.

Example: Create a Bar Chart

Define properties:

const chartProperties = {
  qInfo: {
    qType: "barchart"
  },
  qMetaDef: {
    title: "Sales by Region"
  },
  qHyperCubeDef: {
    qDimensions: [
      {
        qDef: {
          qFieldDefs: ["Region"]
        }
      }
    ],
    qMeasures: [
      {
        qDef: {
          qDef: "=Sum(Sales)"
        }
      }
    ],
    qInitialDataFetch: [
      {
        qLeft: 0,
        qTop: 0,
        qWidth: 2,
        qHeight: 1000
      }
    ]
  }
};

Create persistent object:

const chart = await app.createObject(chartProperties);

After creation:

const chartId = chart.id;

This object is now saved in the app — but not yet on a sheet.

4️⃣ Add the Chart to the Existing Sheet

Now attach the object to the sheet.

Get the Sheet Object
const sheet = await app.getObject(sheetId);
Add the Object to the Sheet

Use:

await sheet.addObject(chartId);

This inserts the visualization into the sheet layout.

5️⃣ (Recommended) Define Layout Position

By default, placement may be automatic.

To control layout:

Modify the sheet layout structure

Or define positioning via qChildListDef manipulation

If layout control is required, update sheet properties using:

sheet.getProperties()
sheet.setProperties(updatedProps)
6️⃣ Save the App

Persist changes:

await app.doSave();

Without this step, changes may not be permanently stored.

🔷 Critical Rules for the AI Agent

✔ Use createObject() for persistent visualizations
✔ Do NOT use createSessionObject()
✔ Always call sheet.addObject(objectId)
✔ Always call app.doSave() after modification
✔ Ensure dimension and measure fields exist in the data model
✔ Match qType to a valid visualization type (barchart, piechart, linechart, etc.)

🔷 Minimal Correct Sequence (Execution Order)

Connect

openDoc(appId)

Get sheet ID

createObject(chartProperties)

sheet.addObject(chartId)

app.doSave()