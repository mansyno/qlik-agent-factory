const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY is not set in .env file.");
    // We don't exit here to allow the module to be loaded, but methods will fail.
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Use a model that supports JSON mode if possible, or standard text.
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

async function generateScript({ profiles, feedback, previousScript }) {
    if (!API_KEY) {
        throw new Error("GEMINI_API_KEY not configured.");
    }

    let prompt = `
You are an expert Qlik Data Architect.

Your task is to generate a Qlik Load Script based on the provided data profiles.

STRATEGIC GOALS:

1. Create a Star Schema with a clear Fact-to-Dimension relationship.  
2. Avoid Synthetic Keys ($Syn). Ensure the Data Model Viewer shows a clean "Switchboard" or "Star" structure, NOT clusters or multi-table junctions.  
3. Handle naming collisions using ALIAS (AS) manually. Do NOT use QUALIFY *.  
4. AutoNumber all link keys. For composite keys, use AutoNumber(Hash128(Field1 & '|' & Field2)).

TABLE RELATIONSHIP HEURISTICS (CRITICAL):

* CONCATENATION: If multiple tables share >80% of the same fields and represent the same business entity (e.g., 'Sales', 'Sales History', and 'Sales Archive'), CONCATENATE them into a single Fact table.  
* LINKING (CENTRALIZED LINK TABLE): If tables represent different business processes (e.g., 'Sales', 'Orders', and 'Shipments') but share common dimensions, keep them separate.  
  * Identify the lowest common grain across ALL facts.  
  * Create ONE centralized Link Table.  
  * UNIQUE KEYS: Each Fact table must have its own UNIQUE Link Key name (e.g., %Key_Sales, %Key_Shipments).  
  * The Link Table must contain ALL of these unique keys to act as the bridge between facts.  
  * SHARED DIMENSIONS: Move all shared dimensions (Date, CustomerID, ProductID) into the Link Table. Remove or rename them in the Fact tables to prevent direct Fact-to-Dimension association.  
* LEFT JOIN: Only join tables if you can prove a strict 1:1 relationship based on cardinality and primary keys.

LOAD SPECIFICATIONS:

* Load all data from 'lib://SourceData/'.  
* Example: FROM [lib://SourceData/filename.csv] (txt, utf8, embedded labels, delimiter is ',', msq).  
* Do NOT use (csv). Use: (txt, utf8, embedded labels, delimiter is ',', msq).  
* Do NOT attempt to DROP MAPPING TABLES.

DATA PROFILES:

${JSON.stringify(profiles, null, 2)}
`;

    if (previousScript) {
        prompt += `
\nPREVIOUS SCRIPT ATTEMPT:
${previousScript}
`;
    }

    if (feedback) {
        prompt += `
\nFEEDBACK FROM ENGINE (Fix these issues):
${JSON.stringify(feedback, null, 2)}
`;
    }

    prompt += `
\nOUTPUT FORMAT:
Return ONLY the raw Qlik Load Script code. Do not include markdown formatting like \`\`\`qlik. 
Just the code.
`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Clean up markdown if present
        text = text.replace(/^```qlik\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');

        return text.trim();
    } catch (error) {
        console.error("Error generating script:", error);
        throw error;
    }
}

module.exports = { generateScript };
