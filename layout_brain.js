const { generateContent } = require('./brain'); // Re-using brain.js since it handles LLM setup
const logger = require('./.agent/utils/logger.js');
const fs = require('fs');
const path = require('path');

// Prompts the LLM with the final Enigma data model.
const LAYOUT_AGENT_PROMPT = `
You are Agent 4: The BI UX Architect / Semantic Specialist.
Your job is to receive a Qlik Data Model and return a JSON payload defining the application's Semantic Layer (Master Items) and the Visual Blueprint (Dashboard Layout).

CRITICAL INSTRUCTIONS:
Always use deterministic, valid JSON ONLY. No markdown wrapping. No explanations.

1. SUB-AGENT A: THE SEMANTIC ARCHITECT
Define the Master Items. Look at the primary Fact tables and Dimension tables.
Provide a "masterItems" object with two arrays: "dimensions" and "measures".
- "measures" must include 'id' (e.g. "Sum_Sales", alphanumeric only), 'title' (e.g. "Total Sales"), and 'expression' (e.g. "Sum(Sales)").
- "dimensions" must include 'id' (e.g. "Dim_Category"), 'title' (e.g. "Category"), and 'expression' (the exact column name, e.g. "CategoryName").

2. SUB-AGENT B: THE UI STRATEGIST
Define the Dashboard Blueprint using a 24-column grid system.
Y-axis goes from 0 (top) downwards. X-axis goes from 0 (left) to 23 (right).
Provide a "blueprint" array. Each object must have:
- "templateId": MUST BE one of exact strings ["kpi", "barchart", "linechart", "table"].
- "title": Human readable title for the object.
- "masterMeasureId": The exact 'id' from your "measures" array.
- "masterDimensionId": The exact 'id' from your "dimensions" array (optional for kpi).
- "grid": An object with { "x", "y", "width", "height" }. Width max is 24.

Example output structure:
{
  "masterItems": {
    "dimensions": [
      { "id": "Dim_Category", "title": "Category", "expression": "CategoryName" }
    ],
    "measures": [
      { "id": "Sum_Sales", "title": "Total Sales", "expression": "Sum(TotalSales)" }
    ]
  },
  "blueprint": [
    {
      "templateId": "kpi",
      "title": "Total Overall Sales",
      "masterMeasureId": "Sum_Sales",
      "grid": { "x": 0, "y": 0, "width": 6, "height": 4 }
    },
    {
      "templateId": "barchart",
      "title": "Sales by Category",
      "masterMeasureId": "Sum_Sales",
      "masterDimensionId": "Dim_Category",
      "grid": { "x": 0, "y": 4, "width": 12, "height": 8 }
    }
  ]
}

YOUR FINAL DATA MODEL TO ANALYZE:
`;

/**
 * Runs the Layout planner (Agent 4) logic to determine UI and Master Items.
 */
async function generateLayoutPlan(dataModelExcerpt) {
  logger.log('LayoutBrain', 'Synthesizing Semantic & UI Blueprint...');
  const fullPrompt = LAYOUT_AGENT_PROMPT + '\n' + dataModelExcerpt;

  try {
    const resultString = await generateContent(fullPrompt);
    // Stripping backticks if LLM mistakenly added them
    const cleaned = resultString.replace(/^```json\S*/mg, '').replace(/```\S*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("DEBUG LayoutBrain LLM Error:", error);
    logger.error('LayoutBrain', 'Failed to generate layout blueprint from LLM', error);
    return null;
  }
}

module.exports = { generateLayoutPlan };
