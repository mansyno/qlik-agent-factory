const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const logger = require('./.agent/utils/logger');
const { throttle } = require('./.agent/utils/throttle');

// Load API Key
require('dotenv').config();
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("CRITICAL ERROR: GEMINI_API_KEY environment variable not set.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

const MODELS = {
  primary: 'gemini-3-flash-preview',
  fallback: 'gemini-3-flash-lite'
};
let activeModel = MODELS.primary;

/**
 * Wraps an async LLM call with retry logic for 503 and 429 errors.
 * Falls back to a secondary model on sustained quota errors.
 */
async function callWithRetry(fn, callerName = 'EnhancerBrain', maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(activeModel);
    } catch (err) {
      const msg = err.message || '';
      const is503 = msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand');
      const is429 = msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('quota');

      if (is503) {
        if (attempt < maxRetries) {
          logger.log(callerName, `503 Service Unavailable. Waiting 15s before retry ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
      } else if (is429) {
        if (attempt < maxRetries) {
          logger.log(callerName, `429 Quota Error. Waiting 60s before retry ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        } else if (activeModel === MODELS.primary) {
          logger.log(callerName, `Quota exhausted on '${activeModel}'. Switching to fallback model '${MODELS.fallback}'.`);
          activeModel = MODELS.fallback;
          return await fn(activeModel);
        }
      }

      throw err;
    }
  }
}

/**
 * Builds the system prompt including the Toolbox Manifest
 */
function buildSystemPrompt() {
  const catalogPath = path.join(__dirname, 'templates', 'catalog.json');
  let catalogStr = '[]';
  try {
    catalogStr = fs.readFileSync(catalogPath, 'utf8');
  } catch (e) {
    logger.error('EnhancerBrain', 'Failed to read catalog.json', e);
  }

  return `
You are the "Senior Qlik Architect" Intelligence for the Enhancer Phase (Agent 3).
Your job is to analyze the metadata of a Qlik Sense application and decide how to enrich it with advanced analytical infrastructure.

## **1. The Decision Logic (Pick and Match)**
- **Analyze Metadata:** Review field names, cardinality, and sample data.
- **Strategy Selection:**
  - **Tier 1 (Catalog):** Default choice for ALL structural improvements. Pick a Tool ID from the Manifest below and fill in the parameters. THIS IS ALWAYS PREFERRED.
  - **Tier 2 (The Forge):** Used ONLY for truly unique, one-off logic with absolutely NO equivalent in the Catalog. This is a LAST RESORT.
- **Trend Analysis Requirement:** If you find a primary date field, you MUST suggest the [as_of_table] tool to generate a Master Calendar.
  - **CRITICAL**: If the base script contains the field "CanonicalDate" (created by the Architect's Canonical Date Bridge), you MUST attach the Master Calendar EXCLUSIVELY to that "CanonicalDate" field. Do not create separate calendars for original dates like OrderDate if CanonicalDate exists.
- **Pareto Requirement:** If you want to perform any 80/20 or Pareto segmentation, you MUST use the [pareto_linked] catalog tool. Do NOT forge a Pareto pattern.
- **Market Basket Rule:** You MAY suggest the [market_basket] catalog tool if you identify transactional fact data with both an ID/Header field and a Line Item/Product field. The execution engine will dynamically verify if a 1-to-many relationship actually exists before applying it.

## **2. The Toolbox Manifest (Catalog - Tier 1)**
Prioritize these for reliability. Match the 'id' exactly and provide ALL required parameters.
${catalogStr}

## **3. The Forge: Syntax Guardrails (MANDATORY - "No SQL Thinking")**
Your synthesized code MUST follow these rules or it WILL fail validation:
1. **No SQL Aggregations in LOAD:** NEVER use Sum(), Count(), or Avg() in a LOAD statement without a GROUP BY on ALL non-aggregated fields.
2. **Resident Only:** ALL transformation logic MUST use RESIDENT loads. Never load directly from a file in a Forge step.
3. **Variable Pre-Calculation:** If a running total or denominator is needed, calculate it FIRST into a LET variable using Peek() on a separate aggregation table. NEVER use Sum(TOTAL ...) inside a non-aggregated LOAD.
4. **DROP Temp Tables:** Always DROP any intermediate/temporary tables you create.

## **Output Format (Raw JSON Only)**
Return a JSON object matching this schema. Do NOT wrap in markdown.
{
  "reasoningSummary": "Explanation of your analytical strategy.",
  "plan": [
    {
      "tier": "catalog",
      "toolId": "tool_id_from_manifest",
      "parameters": { "param_name": "value" }
    },
    {
      "tier": "forge",
      "patternName": "Custom Pattern Name",
      "description": "Why this pattern was chosen and why no Catalog tool fits.",
      "script": "// Complete, self-contained Qlik script snippet"
    }
  ]
}
`;
}

/**
 * Sends metadata to Gemini to formulate an Enrichment Plan
 */
async function generateEnrichmentPlan(metadata, baseScript) {
  await throttle('EnhancerBrain');
  logger.log('EnhancerBrain', `Generating Enrichment Plan with model: ${activeModel}`);

  const safeBaseScript = baseScript.length > 15000
    ? baseScript.substring(0, 15000) + "\n... [TRUNCATED] ..."
    : baseScript;

  const userPrompt = `
Metadata:
${JSON.stringify(metadata, null, 2)}

Existing Script (Base):
${safeBaseScript}

Formulate the Enrichment Plan.
    `;

  return await callWithRetry(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: buildSystemPrompt(),
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    });
    const result = await model.generateContent(userPrompt);
    const plan = JSON.parse(result.response.text());
    logger.log('EnhancerBrain', 'Enrichment Plan Formulation Complete');
    logger.enhancement('Brain Reasoning', plan.reasoningSummary);
    return plan;
  }, 'EnhancerBrain');
}

/**
 * Asks the AI to fix a Forge script based on a Qlik Engine error message.
 * Only used for Tier 2 (Forge) snippets.
 */
async function attemptSelfHeal(script, error) {
  await throttle('EnhancerBrain');
  logger.log('EnhancerBrain', `Attempting self-heal for failed Forge script...`);

  const systemInstruction = `You are a Qlik Script Debugger.
Fix the provided script based on the error message from the Qlik Engine.
Follow ALL of these rules strictly:
- NO aggregations (Sum, Count, Avg) in a LOAD without a GROUP BY.
- ALL loads must be RESIDENT loads.
- If a total denominator is needed, pre-calculate it with a separate RESIDENT load into a LET variable.
- DROP all temporary tables you use.
Return ONLY the raw corrected script snippet. No markdown, no explanation.`;

  const prompt = `
Failing Script:
${script}

Error from Qlik Engine:
${error}

Provide the corrected script snippet.
`;

  return await callWithRetry(async (modelName) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction,
      generationConfig: { temperature: 0.1 }
    });
    const result = await model.generateContent(prompt);
    return result.response.text().replace(/```(qlik|json)?/gi, '').trim();
  }, 'EnhancerBrain');
}

module.exports = { generateEnrichmentPlan, attemptSelfHeal };
