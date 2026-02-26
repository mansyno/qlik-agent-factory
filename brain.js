const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();
const { throttle } = require('./.agent/utils/throttle');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY is not set in .env file.");
}

const genAI = new GoogleGenerativeAI(API_KEY);

const MODELS = {
    primary: "gemini-3-flash-preview",
    fallback: "gemini-2.0-flash"
};

let activeModel = MODELS.primary;

/**
 * Wraps an async LLM call with retry logic for 503 and 429 errors.
 * Falls back to a secondary model on sustained quota errors.
 * @param {Function} fn - Async function to call (receives modelName as arg)
 * @param {string} callerName - Label for logging
 * @param {number} maxRetries - Maximum retry attempts
 */
async function callWithRetry(fn, callerName = 'ArchitectBrain', maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn(activeModel);
        } catch (err) {
            const msg = err.message || '';
            const is503 = msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand');
            const is429 = msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('quota');

            if (is503) {
                if (attempt < maxRetries) {
                    console.log(`[${callerName}] 503 Service Unavailable. Waiting 15s before retry ${attempt + 1}/${maxRetries}...`);
                    await new Promise(r => setTimeout(r, 15000));
                    continue;
                }
            } else if (is429) {
                if (attempt < maxRetries) {
                    console.log(`[${callerName}] 429 Quota Error. Waiting 60s before retry ${attempt + 1}/${maxRetries}...`);
                    await new Promise(r => setTimeout(r, 60000));
                    continue;
                } else if (activeModel === MODELS.primary) {
                    // Quota persists — fall back to secondary model
                    console.warn(`[${callerName}] Quota exhausted on '${activeModel}'. Switching to fallback model '${MODELS.fallback}'.`);
                    activeModel = MODELS.fallback;
                    return await fn(activeModel);
                }
            }

            throw err; // Non-retryable error
        }
    }
}

/**
 * Generic LLM call exported for use by other agent modules.
 */
async function generateContent(prompt, systemInstruction = null) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('LLM_General');

    return await callWithRetry(async (modelName) => {
        const modelInfo = { model: modelName };
        if (systemInstruction) modelInfo.systemInstruction = systemInstruction;

        const model = genAI.getGenerativeModel(modelInfo);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    }, 'LLM_General');
}

async function generateScript({ profiles, feedback, previousScript }) {
    if (!API_KEY) {
        throw new Error("GEMINI_API_KEY not configured.");
    }

    await throttle('ArchitectBrain');

    let prompt = `
You are an expert Qlik Data Architect.

Your task is to generate a Qlik Load Script based on the provided data profiles.

STRATEGIC GOALS:

1. Create a Star Schema with a clear Fact-to-Dimension relationship.  
2. Avoid Synthetic Keys ($Syn). Ensure the Data Model Viewer shows a clean "Switchboard" or "Star" structure, NOT clusters or multi-table junctions.  
3. Handle naming collisions using ALIAS (AS) manually. Do NOT use QUALIFY *.  
4. AutoNumber all link keys. For composite keys, use AutoNumber(Hash128(Field1 & '|' & Field2)).

TABLE NAMING RULES (CRITICAL):

* ALL table names MUST be derived directly from the source filename. Strip the file extension and apply a standard prefix: fact tables become Fact_<Name>, dimension tables become Dim_<Name>.
* Example: orders.csv → Fact_Orders, order_details.csv → Fact_OrderDetails, customers.csv → Dim_Customers.
* Do NOT invent semantic names (e.g., do NOT rename 'order_details.csv' to 'Sales' or 'Transactions'). The names must be traceable back to the source file at a glance.
* Exception: the centralized link table is always named exactly [LinkTable].

AUTONUMBER RULES (CRITICAL):

* NEVER apply AutoNumber() to date fields (e.g. Date_ID, OrderDate, ShipDate). Date fields must remain as their original numeric date serial values so the Enhancer can build a Master Calendar. AutoNumber converts dates to meaningless row indexes.  
* ONLY apply AutoNumber() to surrogate/foreign key fields such as Customer_ID, Product_ID, SalesMgr_ID, and composite hash keys.

TABLE RELATIONSHIP HEURISTICS (CRITICAL):

* CONCATENATION: If multiple tables share >80% of the same fields and represent the same business entity (e.g., 'Sales', 'Sales History', and 'Sales Archive'), CONCATENATE them into a single Fact table.  
* LINKING (CENTRALIZED LINK TABLE): If tables represent different business processes (e.g., 'Sales', 'Orders', and 'Shipments') but share common dimensions, keep them separate.  
  * Identify the lowest common grain across ALL facts.  
  * Create ONE centralized Link Table. It MUST be named exactly [LinkTable] — no underscores, no variations. This name is mandatory.
  * UNIQUE KEYS: Each Fact table must have its own UNIQUE Link Key name (e.g., %Key_Sales, %Key_Shipments).  
  * The Link Table must contain ALL of these unique keys to act as the bridge between facts.  
  * SHARED DIMENSIONS: Move all shared dimensions (Date, CustomerID, ProductID) into the Link Table. Remove or rename them in the Fact tables to prevent direct Fact-to-Dimension association.  
* HEADER-DETAIL PATTERN (CRITICAL): When a header table (e.g., Orders) has a 1-to-many relationship with a detail table (e.g., OrderDetails), treat them as follows:
  * The DETAIL table is the lowest-grain fact. It carries the composite link key (e.g., %Key_OrderDetails) into the LinkTable.
  * The HEADER table connects to the LinkTable via its OWN dimension key ONLY (e.g., %Key_Orders). It must NEVER contain the detail table's composite key.
  * The header's shared dimension IDs (CustomerID, EmployeeID, ShipperID, OrderDate, etc.) are promoted as columns into the LinkTable.
  * The header table itself retains only its own dimension key and any non-shared descriptive fields (e.g., shipping address, freight).
* LEFT JOIN: Only join tables if you can prove a strict 1:1 relationship based on cardinality and primary keys.

LOAD SPECIFICATIONS:

* Load all data from 'lib://SourceData/'.  
* Example: FROM [lib://SourceData/filename.csv] (txt, utf8, embedded labels, delimiter is ',', msq).  
* Do NOT use (csv). Use: (txt, utf8, embedded labels, delimiter is ',', msq).  
* Do NOT attempt to DROP MAPPING TABLES.
* Do NOT apply AutoNumber() to date fields. See AUTONUMBER RULES above.

DATA PROFILES:

${JSON.stringify(profiles, null, 2)}
`;

    if (previousScript) {
        prompt += `\nPREVIOUS SCRIPT ATTEMPT:\n${previousScript}\n`;
    }

    if (feedback) {
        prompt += `\nFEEDBACK FROM ENGINE (Fix these issues):\n${JSON.stringify(feedback, null, 2)}\n`;
    }

    prompt += `\nOUTPUT FORMAT:\nReturn ONLY the raw Qlik Load Script code. Do not include markdown formatting like \`\`\`qlik. Just the code.\n`;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        text = text.replace(/^```qlik\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
        return text.trim();
    }, 'ArchitectBrain');
}

module.exports = { generateScript, generateContent };
