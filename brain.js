const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();
const { throttle } = require('./.agent/utils/throttle');
const logger = require('./.agent/utils/logger.js');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    logger.error('Brain', "GEMINI_API_KEY is not set in .env file.");
}

const genAI = new GoogleGenerativeAI(API_KEY);

const MODELS = {
    primary: "gemini-3-flash-preview",
    secondary: "gemini-2.5-flash",
    fallback: "gemini-1.5-flash"
};

let activeModel = MODELS.primary;

function getActiveModel() {
    return activeModel;
}

function setActiveModel(modelKeyOrName) {
    if (MODELS[modelKeyOrName]) {
        activeModel = MODELS[modelKeyOrName];
    } else {
        activeModel = modelKeyOrName;
    }
    logger.info('Brain', `Active model set to: ${activeModel}`);
}

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
            const isFetchFailed = msg.includes('fetch failed') || msg.includes('UND_ERR_CONNECT_TIMEOUT') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');

            if (is503 || isFetchFailed) {
                if (attempt < maxRetries) {
                    logger.info(callerName, `503 Service Unavailable. Waiting 15s before retry ${attempt + 1}/${maxRetries}...`);
                    await new Promise(r => setTimeout(r, 15000));
                    continue;
                }
            } else if (is429) {
                if (attempt < maxRetries) {
                    logger.info(callerName, `429 Quota Error. Waiting 60s before retry ${attempt + 1}/${maxRetries}...`);
                    await new Promise(r => setTimeout(r, 60000));
                    continue;
                } else if (activeModel === MODELS.primary) {
                    // Quota persists — fall back to secondary model
                    logger.warn(callerName, `Quota exhausted on '${activeModel}'. Switching to fallback model '${MODELS.fallback}'.`);
                    activeModel = MODELS.fallback;
                    return await fn(activeModel);
                }
            }

            throw err; // Non-retryable error
        }
    }
}

// ─── AI Engine Configuration ─────────────────────────────────────────────────
let activeEngine = 'gemini'; // 'gemini' or 'lmstudio'
let lmstudioModel = null;

function setAiEngineConfig(engine, model) {
    activeEngine = engine || 'gemini';
    lmstudioModel = model || null;
    logger.info('Brain', `AI Engine configured to use ${activeEngine} ${model ? `(${model})` : ''}`);
}

/**
 * Generic LLM call exported for use by other agent modules.
 */
async function generateContent(prompt, systemInstruction = null, options = {}) {
    if (activeEngine === 'lmstudio') {
        const lmstudio = require('./llm/lmstudio');
        return await lmstudio.generateContent(lmstudioModel, prompt, systemInstruction, options);
    }

    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('LLM_General');

    return await callWithRetry(async (modelName) => {
        const modelInfo = { model: modelName };
        if (systemInstruction) modelInfo.systemInstruction = systemInstruction;

        if (options.runFolder) {
            const fs = require('fs');
            const path = require('path');
            fs.writeFileSync(path.join(options.runFolder, '.debug_gemini_prompt.txt'), `SYSTEM:\n${systemInstruction}\n\nUSER:\n${prompt}`);
        }

        const model = genAI.getGenerativeModel(modelInfo);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        if (options.runFolder) {
            const fs = require('fs');
            const path = require('path');
            fs.writeFileSync(path.join(options.runFolder, '.debug_gemini_response.txt'), text);
        }

        return text;
    }, 'LLM_General');
}

/**
 * Structured JSON LLM call with retry logic.
 */
async function generateJsonContent(prompt, schema, systemInstruction = null, options = {}) {
    if (activeEngine === 'lmstudio') {
        const lmstudio = require('./llm/lmstudio');
        return await lmstudio.generateJsonContent(lmstudioModel, prompt, schema, systemInstruction, options);
    }

    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('LLM_General');

    return await callWithRetry(async (modelName) => {
        const modelInfo = { 
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        };
        if (systemInstruction) modelInfo.systemInstruction = systemInstruction;

        if (options.runFolder) {
            const fs = require('fs');
            const path = require('path');
            fs.writeFileSync(path.join(options.runFolder, '.debug_gemini_json_prompt.txt'), `SYSTEM:\n${systemInstruction}\n\nUSER:\n${prompt}\n\nSCHEMA:\n${JSON.stringify(schema, null, 2)}`);
        }

        const model = genAI.getGenerativeModel(modelInfo);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        if (options.runFolder) {
            const fs = require('fs');
            const path = require('path');
            fs.writeFileSync(path.join(options.runFolder, '.debug_gemini_json_response_raw.txt'), text);
        }

        try {
            return JSON.parse(text);
        } catch (e) {
            logger.error('Brain', `JSON Parse Error at pos ${e.message.match(/position (\d+)/)?.[1] || 'unknown'}`, { fragment: text.substring(Math.max(0, text.length - 500)) });
            // If it's too big, it might have been cut off or repeated
            if (text.length > 50000) {
                logger.warn('Brain', `Extremely large response detected (${text.length} chars). Possible AI loop.`);
            }
            throw e;
        }
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

/**
 * Step 1: Classify Tables by Role and Grain
 * Evaluates the Step 0 Statistical Profile to determine Candidate Keys, Grain, and Role.
 */
async function classifyTablesAndFields(profileData) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('ArchitectBrain');

    const schema = {
        type: "object",
        description: "The classification result or an explicit error if the data is incomprehensible.",
        properties: {
            error: {
                type: "string",
                description: "ESCAPE HATCH: If the data is completely ambiguous or incomprehensible, return a concise message starting with 'This is not clear, cannot continue.' and explain why. If the data is fine, leave this null."
            },
            classifications: {
                type: "array",
                description: "List of analyzed tables with their classifications. Provide this ONLY if error is null.",
                items: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        role: { type: "string", description: "Must be 'Fact', 'Dimension', or 'Reference'." },
                        candidateKeys: { type: "array", items: { type: "string" }, description: "Primary/Foreign keys identified." },
                        grain: { type: "string", description: "Must be 'Header', 'Detail', or 'Reference'." },
                        reasoning: { type: "string" }
                    },
                    required: ["tableName", "role", "candidateKeys", "grain", "reasoning"]
                }
            }
        }
    };

    const prompt = `
You are an expert Qlik Data Modeling Architect.
You must analyze the provided statistical metadata AND native engine relationships for a set of raw database tables.

Your task is to classify EACH table without writing any Qлик code.
For each table, determine:
1. **Candidate Keys**: Which fields are Primary Keys or Foreign Keys? 
   - **CRITICAL HINT**: Consult the "relationships.nativeLinks" section below. Any field listed there is ALREADY associated by the Qlik Engine across multiple tables. You MUST include these fields as candidateKeys for the respective tables.
   - Look for fields with 0% Nulls and Cardinality close to the rowCount for Primary Keys.
2. **Role**: Is this a 'Fact' (additive measures, multiple foreign keys), a 'Dimension' (descriptive string attributes, mostly 1 primary key), or 'Reference'?
3. **Grain**: Is this a 'Header' table (1 row per transaction), a 'Detail' table (multiple rows per transaction), or 'Reference'?

Strict Rules:
- ESCAPE HATCH: If you cannot understand the data or it is hopelessly ambiguous, you MUST fail gracefully by populating the 'error' field with "This is not clear, cannot continue." and a brief explanation.
- Return the exact JSON object structure specified.
- prioritize the "nativeLinks" provided by the engine; they are ground truth for associations.

DATA PROFILE & ENGINE HINTS (Native Relationships):
${JSON.stringify(profileData, null, 2)}
    `;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return JSON.parse(response.text());
    }, 'ArchitectBrain');
}

/**
 * Step 2: Normalize Field Names
 * Evaluates the Step 0 Profile and Step 1 Classifications to enforce strict naming
 * conventions and explicitly resolve identical cross-table field names (Hard Stop).
 */
async function normalizeFields(profileData, classifications, compilationErrorContext = null) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('ArchitectBrain');

    const schema = {
        type: "array",
        description: "List of normalized tables and their field mappings.",
        items: {
            type: "object",
            properties: {
                tableName: {
                    type: "string",
                    description: "The name of the table being normalized."
                },
                originalFields: {
                    type: "array",
                    description: "List of original physical field names as found in the data.",
                    items: { type: "string" }
                },
                normalizedFields: {
                    type: "array",
                    description: "Mapping of original to new normalized names.",
                    items: {
                        type: "object",
                        properties: {
                            originalName: { type: "string" },
                            normalizedName: { type: "string" }
                        },
                        required: ["originalName", "normalizedName"]
                    }
                },
                compositeKeys: {
                    type: "array",
                    description: "Any synthetic/composite keys that must be created to resolve field collisions.",
                    items: {
                        type: "object",
                        properties: {
                            newKeyName: { type: "string" },
                            hashedFields: { type: "array", items: { type: "string" } },
                            reasoning: { type: "string" }
                        },
                        required: ["newKeyName", "hashedFields", "reasoning"]
                    }
                }
            },
            required: ["tableName", "originalFields", "normalizedFields"]
        }
    };

    const prompt = `
You are an expert Qlik Data Modeling Architect.
Your task is to normalize field names across the provided tables to prepare for Association (Step 3).

CRITICAL "HARD STOP" RULES:
1. No two tables may share 2 or more identically-named normalized fields. If they do, Qlik will generate a memory-crashing Synthetic Key.
   If you detect that two tables share 2+ identical key fields, you MUST:
   a. Suggest a single new Composite Key under the 'compositeKeys' array for those tables.
   b. The 'hashedFields' array must list the component fields.
   c. Rename or distinctify the individual original fields so they no longer formally associate.

2. ISLAND PREVENTION (CRITICAL):
   Foreign Keys in Fact tables MUST be normalized to match the EXACT SAME 'normalizedName' as the Primary Key in the corresponding Dimension table.
   Do NOT prefix Foreign Keys with the Fact table name (e.g. do NOT use 'Order_CustomerKey', use 'CustomerKey'). This allows the Associative Engine to link them natively.

NORMALIZATION GOALS:
1. Standardize Primary/Foreign Keys (e.g. 'Customer_ID' -> 'CustomerKey').
2. Rename generic fields contextually (e.g. 'Date' -> 'OrderDate', 'Name' -> 'CustomerName') to prevent accidental associations.
3. Ensure the exact intended Header/Detail grain relationships are structurally sound based on the classifications provided.

DATA PROFILE (Step 0):
${JSON.stringify(profileData, null, 2)}

TABLE CLASSIFICATIONS (Step 1):
${JSON.stringify(classifications, null, 2)}

${compilationErrorContext ? `PREVIOUS QLIK COMPILATION FAILED:\n${compilationErrorContext}\nCRITICAL INSTRUCTION: Analyze the tables mentioned in the error above. Ensure they DO NOT share 2 or more keys. Rename intersecting fields to prevent the loop or synthetic key.` : ''}
    `;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return JSON.parse(response.text());
    }, 'ArchitectBrain');
}

/**
 * Step 3: Build Conceptual Association Graph
 * Evaluates the normalized field names to identify structural edges (associations).
 * Specifically detects and flags Circular Reference loops (Hard Stop).
 */
async function buildAssociationGraph(normalizedData) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('ArchitectBrain');

    const schema = {
        type: "object",
        description: "The conceptual association graph and validation report.",
        properties: {
            edges: {
                type: "array",
                description: "List of all connections formed by identical normalized field names.",
                items: {
                    type: "object",
                    properties: {
                        fromTable: { type: "string" },
                        toTable: { type: "string" },
                        sharedKey: { type: "string" }
                    },
                    required: ["fromTable", "toTable", "sharedKey"]
                }
            },
            circularReferenceDetected: {
                type: "boolean",
                description: "True if the LLM detects a cycle in the edges (e.g., A -> B -> C -> A)."
            },
            resolutionPlan: {
                type: "string",
                description: "If a circular reference is detected, provide the reasoning and specify which connection should be broken/renamed to resolve it. Null otherwise."
            }
        },
        required: ["edges", "circularReferenceDetected"]
    };

    const prompt = `
You are an expert Qlik Data Modeling Architect.
Your task is to review the provided Normalized Tables mapping and build the "Conceptual Association Graph".

RULES FOR QLIK ASSOCIATIONS:
In Qlik, associations (edges) are formed natively and strictly whenever two or more tables share a field with the EXACT SAME NAME.

TASK:
1. Examine the 'normalizedName' values for all fields across all provided tables.
2. Identify every instance where Table A and Table B share an identical 'normalizedName'. 
3. Record each connection in the 'edges' array ({ fromTable, toTable, sharedKey }).
4. CRITICAL "HARD STOP": Analyze the resulting graph for Circular References (loops).
   - A cycle exists if you can start at Table A, traverse through associations to other tables, and end up back at Table A.
   - If a cycle is detected, set 'circularReferenceDetected' to true and provide a 'resolutionPlan' explaining briefly which key should be distinctified/renamed to break the loop.

NORMALIZED TABLES DATA (Step 2):
${JSON.stringify(normalizedData, null, 2)}
    `;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return JSON.parse(response.text());
    }, 'ArchitectBrain');
}

/**
 * Steps 4 & 5 (Phase A): Resolve Model Structure
 * Determines Header/Detail separation and Central Link Table requirements.
 */
async function resolveModelStructure(profileData, classifications, normalizedData, graph) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('ArchitectBrain');

    const schema = {
        type: "object",
        description: "The macro-architectural blueprint defining tables and link tables.",
        properties: {
            factTables: {
                type: "array",
                description: "List of tables acting as Facts (Headers or Details).",
                items: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        grain: { type: "string" },
                        keys: { type: "array", items: { type: "string" } }
                    },
                    required: ["tableName", "grain", "keys"]
                }
            },
            dimensionTables: {
                type: "array",
                description: "List of tables acting as Reference/Dimensions.",
                items: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        keys: { type: "array", items: { type: "string" } }
                    },
                    required: ["tableName", "keys"]
                }
            },
            linkTableRequired: {
                type: "boolean",
                description: "True if 2+ Fact tables share 2+ conformed dimension keys."
            },
            linkTableBlueprint: {
                type: "object",
                description: "Details for the Central Link Table if requested. Null otherwise.",
                properties: {
                    tableName: { type: "string", description: "Must be 'LinkTable'" },
                    sharedKeys: { type: "array", items: { type: "string" }, description: "Keys to move into the Link Table." },
                    compositeKeysToGenerate: { type: "array", items: { type: "string" }, description: "New composite keys needed to link facts to the link table." }
                }
            }
        },
        required: ["factTables", "dimensionTables", "linkTableRequired"]
    };

    const prompt = `
You are an expert Qlik Data Modeling Architect.
We are converting normalized data tables into a final Qlik Schema Blueprint.

PHASE A GOALS (MACRO-ARCHITECTURE):
1. Review the Classifications to definitively separate 'Fact' tables from 'Dimension' tables.
2. Ensure Header and Detail Facts remain separate entities (Do not merge them).
3. Evaluate the relationships between Fact tables. If 2 or more Fact tables share exactly ONE dimension key, keep them separate; the Associative Engine will link them naturally. If they share TWO OR MORE conformed dimension keys (e.g., both share CustomerKey AND DateKey), you MUST resolve the loop by either creating a centralized [LinkTable] containing those shared keys OR by Concatenating the facts if they share >80% granularity.
4. If a Link Table is required, populate the linkTableBlueprint detailing which keys move to the center.

DATA PROFILE (Step 0):
${JSON.stringify(profileData, null, 2)}

CLASSIFICATIONS (Step 1):
${JSON.stringify(classifications, null, 2)}

NORMALIZED FIELDS (Step 2):
${JSON.stringify(normalizedData, null, 2)}

ASSOCIATION GRAPH (Step 3):
${JSON.stringify(graph, null, 2)}
    `;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return JSON.parse(response.text());
    }, 'ArchitectBrain');
}

/**
 * Steps 6 & 7 (Phase B): Resolve Temporal & Joins
 * Determines Date Bridges and specific Load/Join instructions based on Phase A's blueprint.
 */
async function resolveTemporalAndJoins(structuralBlueprint, profileData) {
    if (!API_KEY) throw new Error("GEMINI_API_KEY not configured.");
    await throttle('ArchitectBrain');

    const schema = {
        type: "array",
        description: "List of absolute script generation directives for the final code generator.",
        items: {
            type: "object",
            properties: {
                tableName: { type: "string" },
                action: {
                    type: "string",
                    description: "Strictly 'LOAD', 'JOIN', or 'KEEP'."
                },
                requiresDateBridge: {
                    type: "boolean",
                    description: "True if 2+ date fields exist in the same Fact table."
                },
                dateFieldsToBridge: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of date fields to bridge. Empty if requiresDateBridge is false."
                },
                notes: {
                    type: "string",
                    description: "Brief reasoning for the action and bridge choices."
                }
            },
            required: ["tableName", "action", "requiresDateBridge", "dateFieldsToBridge", "notes"]
        }
    };

    const prompt = `
You are an expert Qlik Data Modeling Architect.
You must take the Macro-Architectural Blueprint (Phase A) and the Profile Data, and output final Script Directives (Phase B) for the code generator.

PHASE B GOALS (MICRO-ARCHITECTURE):
1. Evaluate every Fact table in the Blueprint against the Profile Data.
2. If a Fact table contains 2 or more distinct Date fields (e.g., OrderDate and ShippedDate), you MUST set requiresDateBridge: true and list them in dateFieldsToBridge.
3. CRITICAL MULTI-GRANULARITY RULE: If you have a Header Fact and a Detail Fact (e.g. Orders and OrderDetails), and dates exist in BOTH tables (or just multiple dates in one), you MUST consolidate ALL dates into a single Canonical Date Bridge attached to the HIGHEST level grain (the Header). Do NOT attach a date bridge to the Detail table if a Header exists.
4. Determine the load 'action'. The default is ALWAYS 'LOAD' (Associative model). 
5. Rarely use 'JOIN' only if mapping a strict 1:1 dimension extension that will not multiply rows.

STRUCTURAL BLUEPRINT (Phase A Output):
${JSON.stringify(structuralBlueprint, null, 2)}

DATA PROFILE (Step 0):
${JSON.stringify(profileData, null, 2)}
    `;

    return await callWithRetry(async (modelName) => {
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return JSON.parse(response.text());
    }, 'ArchitectBrain');
}

module.exports = { 
    generateScript, 
    generateContent, 
    generateJsonContent,
    classifyTablesAndFields, 
    normalizeFields, 
    buildAssociationGraph, 
    resolveModelStructure, 
    resolveTemporalAndJoins,
    getActiveModel,
    setActiveModel,
    setAiEngineConfig,
    MODELS
};
