const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-3-flash-preview';

async function classifyWithLLM(systemPrompt, userPrompt) {
    let retries = 3;
    let lastError = null;

    while (retries > 0) {
        try {
            console.log(`[CLASSIFIER] Requesting classification from ${MODEL_NAME} (Attempts remaining: ${retries})...`);
            
            const response = await ai.models.generateContent({
                model: MODEL_NAME,
                contents: userPrompt,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.1 // very strict deterministic response
                }
            });

            let text = response.text;
            
            // Clean up backticks in case LLM ignores "no markdown" instruction
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(text);
            return parsedJson;

        } catch (error) {
            console.error(`[CLASSIFIER] Attempt failed: ${error.message}`);
            lastError = error;
            retries--;
        }
    }

    throw new Error(`[CLASSIFIER] FATAL: Failed to classify fields with LLM after 3 attempts. Last Error: ${lastError.message}`);
}

async function classifyData(profileMetadata) {
    console.log("[CLASSIFIER] Preparing LLM Classification Prompt...");

    // 1. Load the semantic rules from the user's strategy document
    let strategyRules = '';
    const strategyPath = path.join(__dirname, 'docs', 'field_classification_strategy.md');
    try {
        strategyRules = fs.readFileSync(strategyPath, 'utf8');
    } catch (e) {
        console.warn("[WARNING] Could not read docs/field_classification_strategy.md");
        strategyRules = "Classify fields logically as IDENTIFIER, MEASURE, DATE, ATTRIBUTE, or SYSTEM_METADATA.";
    }

    // 2. Format the input data (metadata) into a concise JSON structure to save tokens
    const tablesToClassify = {};
    Object.keys(profileMetadata.tables).forEach(tableName => {
        const tableStats = profileMetadata.tables[tableName];
        const fields = {};
        Object.keys(tableStats.fields).forEach(fieldName => {
            const f = tableStats.fields[fieldName];
            fields[fieldName] = {
                distinctCount: f.distinctCount,
                subsetRatio: f.uniquenessRatio, 
                informationDensity: f.informationDensity,
                type: f.type, // 'numeric' or 'text'
                sampleValues: Array.isArray(f.sampleValues) ? f.sampleValues.slice(0, 3) : [] // Give LLM a taste of the data type
            };
        });
        tablesToClassify[tableName] = {
            rowCount: tableStats.rowCount,
            fields: fields
        };
    });

    // 3. Construct Prompts
    const systemPrompt = `You are a strict Qlik Data Architect agent.
Your task is to classify fields in a data model as IDENTIFIER, MEASURE, DATE, ATTRIBUTE, or SYSTEM_METADATA, following the rules provided.

### RULES
${strategyRules}

### INSTRUCTIONS
1. Analyze the provided JSON metadata containing Table configurations, Row Counts, and Field profiles (including distinct count, information density, subset ratio, type, and samples).
2. Classify each Field into EXACTLY ONE of the allowed classifications.
3. Pay special attention to the "Traps" in the rules. Fields like "Carton - Qnt" or "Units per Carton" are static attribute identifiers requiring multiplication. They MUST be classified as ATTRIBUTE, not MEASURE. "Cost" on dimension tables is also an ATTRIBUTE.
4. Return the results in strict JSON format.

### OUTPUT FORMAT
Your output MUST be valid JSON mapping each Table to its Fields and their determined classification strings. Example:
{
  "Customers.csv": {
    "CustomerID": "IDENTIFIER",
    "CustomerName": "ATTRIBUTE"
  },
  "Orders.csv": {
    "OrderID": "IDENTIFIER",
    "CustomerID": "IDENTIFIER",
    "OrderDate": "DATE",
    "Amount": "MEASURE"
  }
}
DO NOT RETURN MARKDOWN CODE BLOCKS. RETURN RAW JSON ONLY.`;

    const userPrompt = `Classify the following schema:\n\n${JSON.stringify(tablesToClassify, null, 2)}`;

    // 4. API Request Let's go!
    const llmClassifications = await classifyWithLLM(systemPrompt, userPrompt);
    
    // Write out the raw JSON for debugging purposes
    fs.writeFileSync(
        path.join(__dirname, 'docs', 'llm_classification_prompt.txt'),
        `=== SYSTEM PROMPT ===\n${systemPrompt}\n\n=== USER PROMPT ===\n${userPrompt}\n`
    );

    // 5. Build Internal Metadata Formats
    // Reconstruct the pipeline's expected object format with Primary Keys, Foreign Keys, etc.
    const finalClassifications = [];

    Object.keys(profileMetadata.tables).forEach(tableName => {
        const tableStats = profileMetadata.tables[tableName];
        const llmTableData = llmClassifications[tableName];

        if (!llmTableData) {
            throw new Error(`LLM failed to return classification data for table: ${tableName}`);
        }

        const fieldClassifications = {};
        
        let identifierCount = 0;
        let dateCount = 0;
        let measureCount = 0;
        let attributeCount = 0;

        Object.keys(tableStats.fields).forEach(fieldName => {
            const llmType = llmTableData[fieldName] || 'ATTRIBUTE';
            fieldClassifications[fieldName] = {
                type: llmType,
                ...tableStats.fields[fieldName]
            };

            if (llmType === 'IDENTIFIER') identifierCount++;
            else if (llmType === 'MEASURE') measureCount++;
            else if (llmType === 'ATTRIBUTE') attributeCount++;
            else if (llmType === 'DATE') dateCount++;
        });

        // Grain Detection (Structured)
        const allIdentifiers = Object.entries(fieldClassifications)
            .filter(([, v]) => v.type === 'IDENTIFIER')
            .map(([name, props]) => ({ name, uniquenessRatio: props.uniquenessRatio }));
        
        const primaryKeyFields = allIdentifiers
            .filter(f => f.uniquenessRatio >= 0.95)
            .map(f => f.name);
        
        const foreignKeyFields = allIdentifiers
            .filter(f => f.uniquenessRatio < 0.95)
            .map(f => f.name);
        
        const grainFields = allIdentifiers.map(f => f.name);
        const grainDescription = grainFields.length > 0 ? grainFields.join(' + ') : 'Unknown';

        // Table Role Classification (Simplified logic since the LLM handled Field level)
        // If it has Measures OR lots of Foreign Keys, it's a Fact
        let role = 'DIMENSION';
        if (measureCount > 0 && foreignKeyFields.length > 0) {
            role = 'FACT';
        } else if (tableStats.rowCount > 50000 && foreignKeyFields.length >= 2) {
            role = 'FACT';
        }

        finalClassifications.push({
            tableName: tableName,
            originalFileName: tableStats.originalFileName,
            role: role,
            grain: {
                primaryKey: primaryKeyFields,
                foreignKeys: foreignKeyFields,
                grainFields: grainFields,
                grainDescription: grainDescription
            },
            rowCount: tableStats.rowCount,
            candidateKeys: grainFields, 
            fieldClassifications: fieldClassifications
        });
    });

    console.log("[CLASSIFIER] LLM Classification successfully merged into internal schema.");
    return { success: true, classifications: finalClassifications };
}

module.exports = {
    classifyData
};
