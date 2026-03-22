const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger');
const { throttle } = require('./.agent/utils/throttle');
const { generateContent, generateJsonContent, getActiveModel } = require('./brain');

// Models and retries are managed by brain.js

/**
 * Builds the system prompt including the Toolbox Manifest
 */
function buildSystemPrompt() {
  const catalogPath = path.join(__dirname, 'templates', 'catalog.json');
  let catalog = [];
  try {
    const catalogJson = fs.readFileSync(catalogPath, 'utf8');
    catalog = JSON.parse(catalogJson);
  } catch (e) {
    logger.error('EnhancerBrain', 'Failed to read or parse catalog.json', e);
  }
  const catalogStr = catalog.map(t => `- [${t.id}]: ${t.description}\n  REQUIRED PARAMETERS: ${t.parameters.join(', ')}`).join('\n');

  return `
You are the "Senior Qlik Architect" Intelligence for the Enhancer Phase (Agent 3).
Your job is to analyze the metadata of a Qlik Sense application and decide how to enrich it with advanced analytical infrastructure.

## **1. The Decision Logic (Pick and Match)**
- **Analyze Metadata:** Review field names, cardinality, and sample data.
- **Formulate Optimal Selections**:
  - **[pareto_linked]**: Use this for ANY table with a Measure (e.g. Sales, Amount, Qty) and a significant Dimension (e.g. Customer, Product).
  - **[market_basket]**: Use this if you find a 1-to-many relationship (e.g. OrderID -> ProductID).
- **Candidate Adoption**: If "Pre-Flight Inspection Hints" provide a "Candidate", incorporate its parameters into your plan.
- **Standard Requirement**: Use 'CanonicalDate' and 'LinkTable' as your anchors whenever possible.

## **2. The Toolbox Manifest (Catalog - Tier 1)**
Prioritize these for reliability. Match the 'id' exactly and provide ALL required parameters.
${catalogStr}

## **3. The Output Contract (MANDATORY)**
- Each Catalog tool in the plan should have a "toolId" and a matching "parameters" object.
- **EXAMPLE [as_of_table]**: { "toolId": "as_of_table", "parameters": { "dateField": "CanonicalDate" } }
- **EXAMPLE [pareto_linked]**: { "toolId": "pareto_linked", "parameters": { "factTable": "Sales", "linkTable": "LinkTable", "keyField": "%Key_Sales", "dimensionField": "Customer", "measureField": "TotalSales" } }
- **EXAMPLE [dual_flag_injector]**: { "toolId": "dual_flag_injector", "parameters": { "targetTable": "Sales", "fieldName": "Status", "mappingPairs": "'Active', 1, 'Inactive', 0" } }
  - **CRITICAL**: The "mappingPairs" parameter MUST be a comma-separated list where all string values are enclosed in SINGLE QUOTES (e.g., "'Direct', 1, 'Partner', 0").

## **4. ABSOLUTE FIELD NAME RULE (NEVER VIOLATE)**
- **ONLY use table names and field names that appear VERBATIM in the metadata table below.**
- **DO NOT invent, guess, abbreviate, or generalize field names.** If you cannot find a field in the metadata, do NOT include that tool in the plan.
- If a "Pre-Flight Hint" provides exact field names, use those names EXACTLY as given.
- A tool with a field name that does not exist in the metadata WILL FAIL. It is better to skip the tool than to hallucinate a field name.

## **Output Format (Raw JSON Only)**
Return a JSON object matching this schema.
{
  "plan": [ { "tier": "catalog", "toolId": "as_of_table", "parameters": { "dateField": "CanonicalDate" } } ]
}
`;
}

/**
 * Sends metadata to Gemini to formulate an Enrichment Plan
 */
async function generateEnrichmentPlan(markdownMetadata, baseScript, hints = [], runFolder = null) {
  logger.log('EnhancerBrain', `Generating Enrichment Plan with model: ${getActiveModel()}`);

  const instructions = buildSystemPrompt();
  
  const hintsStr = hints.length > 0 
    ? `\n## **Pre-Flight Inspection Hints**\n${hints.map(h => `- ${h}`).join('\n')}`
    : "";

  const userPrompt = `
Formulate the enrichment plan for this application metadata. 

## **Pre-Flight Inspection Hints**
${hintsStr}

--- START OF ANALYTICAL METADATA ---
${markdownMetadata}
--- END OF ANALYTICAL METADATA ---

### **Process Instructions**:
1. **Think**: Analyze the metadata and candidates provided. Identify which Catalog tools are most appropriate.
2. **Plan**: Formulate the parameters for each tool (e.g. which measure, which dimension).
3. **Response**: Return your result in the following JSON format:

\`\`\`json
{
  "thought": "Briefly explains your architectural choices for this run",
  "plan": [
    { "tier": "catalog", "toolId": "...", "parameters": { ... } }
  ]
}
\`\`\`

Ensure all parameters identified in the Pre-Flight hints are included. Provide the final plan now.
    `;

  // Debug: Log the EXACT prompt to see what the AI sees
  try {
    const debugPath = runFolder || process.cwd();
    fs.writeFileSync(path.join(debugPath, '.debug_enhancer_prompt.txt'), `SYSTEM:\n${instructions}\n\nUSER:\n${userPrompt}`);
  } catch (err) {
    logger.warn('EnhancerBrain', 'Failed to write debug prompt file');
  }

  try {
    // Switching to raw generateContent to allow for Chain of Thought and avoid schema-induced "laziness"
    const rawResponse = await generateContent(userPrompt, instructions, { runFolder });
    
    // Extract JSON from potential markdown blocks
    let cleanedResponse = rawResponse.trim();
    const jsonMatch = cleanedResponse.match(/```json\n([\s\S]*?)\n```/) || cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedResponse = jsonMatch[1] || jsonMatch[0];
    }

    const plan = JSON.parse(cleanedResponse);
    
    // Debug: Log the RESPONSE
    try {
      const debugPath = runFolder || process.cwd();
      fs.writeFileSync(path.join(debugPath, '.debug_enhancer_response.json'), JSON.stringify(plan, null, 2));
    } catch (err) {
      logger.warn('EnhancerBrain', 'Failed to write debug response file');
    }

    if (plan.thought) {
      logger.log('EnhancerBrain', `AI Thought: ${plan.thought}`);
    }

    logger.log('EnhancerBrain', 'Enrichment Plan Formulation Complete');
    return plan;
  } catch (err) {
    logger.error('EnhancerBrain', 'Failed to generate Enrichment Plan or Parse JSON');
    if (err instanceof SyntaxError) {
        logger.error('EnhancerBrain', "Raw Response that failed to parse", { rawResponse });
    }
    throw err;
  }
}

/**
 * Asks the AI to fix a Forge script based on a Qlik Engine error message.
 * Only used for Tier 2 (Forge) snippets.
 */
async function attemptSelfHeal(script, error) {
  logger.log('EnhancerBrain', `Attempting self-heal for failed Forge script...`);

  const systemInstruction = `You are a Qlik Script Debugger.
Fix the provided script based on the error message from the Qlik Engine.
Follow ALL of these rules strictly:
- NO aggregations (Sum, Count, Avg) in a LOAD without a GROUP BY.
- ALL loads must be RESIDENT loads.
- If a total denominator is needed, pre-calculate it with a separate RESIDENT load into a LET variable.
- DROP all temporary tables you use.
Return ONLY the raw corrected script snippet. No markdown, no explanation.`;

  const combinedPrompt = `
${systemInstruction}

--- START OF FAIL DATA ---
Failing Script:
${script}

Error from Qlik Engine:
${error}
--- END OF FAIL DATA ---

Provide the corrected script snippet.
`;

  return await generateContent(combinedPrompt, null);
}

module.exports = { generateEnrichmentPlan, attemptSelfHeal };
