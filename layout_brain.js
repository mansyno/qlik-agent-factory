const { generateContent } = require('./brain'); // Re-using brain.js since it handles LLM setup
const logger = require('./.agent/utils/logger.js');
const fs = require('fs');
const path = require('path');

// Prompts the LLM with the final Enigma data model.
const LAYOUT_AGENT_PROMPT = `
You are Agent 4: The Senior BI Analytics Lead & UX Architect.
Your mission is to transform a raw Qlik Data Model into a world-class Executive Dashboard. Don't just list fields; identify the "Story" in the data.

CRITICAL INSTRUCTIONS:
Always use deterministic, valid JSON ONLY. No markdown wrapping. No explanations.

1. SUB-AGENT A: THE SEMANTIC ARCHITECT
Define the Master Items. Look at the primary Fact tables and Dimension tables.
Provide a "masterItems" object with two arrays: "dimensions" and "measures".
- "measures" must include 'id', 'title', and 'expression'. 
- ANALYTICAL TIP: Look for opportunities to create comparative measures (e.g., Sales vs Costs, Budget vs Actual) or calculated ratios.
- "dimensions" must include 'id', 'title', and 'expression'.

2. SUB-AGENT B: THE UI STRATEGIST
Define the Dashboard Blueprint using a 24-column grid system.
Y-axis goes from 0 (top) downwards. X-axis goes from 0 (left) to 23 (right).

ANALYTICAL DEPTH RULE:
A high-quality dashboard provides depth. Do not settle for simple 1-Dimension/1-Measure charts if the data allows for more:
- LINE CHARTS: Use them to show TRENDS. If there are multiple related metrics (e.g. Quantity vs Amount), show them together on one line chart to highlight correlation. If there is a key breakdown (e.g. Sales by Region), use 2 dimensions to show lines per region over time.
- TABLES: Use them for high-density detail. Always include at least 3-5 relevant columns (mix of dims and measures).

SCALE SAFETY RULE:
NEVER mix measures with vastly different scales in the same chart (e.g., do NOT put "Total Revenue" which is in millions and "Margin %" which is a decimal between 0 and 1 on the same Bar or Line chart). It makes the smaller value invisible. Use separate charts or KPIs for these unless they share a similar numeric range.

TEMPLATE CAPABILITIES:
- "templateId": MUST BE one of exact strings ["kpi", "barchart", "linechart", "table"].
- "measures" / "dimensions": Arrays of IDs from Master Items.
- TABLE: Supports many-to-many.
- LINECHART: Supports EITHER (1 Dim + Multiple Meas) OR (2 Dims + 1 Meas). **Strongly preferred** for complex trend analysis.
- BAR CHART: Supports EITHER (1 Dim + Multiple Meas) OR (2 Dims + 1 Meas). Useful for comparative analysis.
- KPI: 1 Meas (Standard).

Example output structure:
{
  "masterItems": {
    "dimensions": [
      { "id": "Dim_MonthYear", "title": "Month-Year", "expression": "MonthYear" },
      { "id": "Dim_Region", "title": "Region", "expression": "Region" }
    ],
    "measures": [
      { "id": "Sum_Sales", "title": "Total Sales", "expression": "Sum(SalesAmount)" },
      { "id": "Sum_Costs", "title": "Total Costs", "expression": "Sum(TotalCost)" }
    ]
  },
  "blueprint": [
    {
      "templateId": "linechart",
      "title": "Sales & Costs Trend Analysis",
      "dimensions": ["Dim_MonthYear"],
      "measures": ["Sum_Sales", "Sum_Costs"],
      "grid": { "x": 0, "y": 0, "width": 24, "height": 10 }
    }
  ]
}

YOUR FINAL DATA MODEL TO ANALYZE:
`;

/**
 * Runs the Layout planner (Agent 4) logic to determine UI and Master Items.
 */
async function generateLayoutPlan(dataModelExcerpt, runFolder = null) {
  logger.log('LayoutBrain', 'Synthesizing Semantic & UI Blueprint...');
  const fullPrompt = LAYOUT_AGENT_PROMPT + '\n' + dataModelExcerpt;
  
  const debugPath = runFolder || process.cwd();
  try {
    fs.writeFileSync(path.join(debugPath, '.debug_layout_prompt.txt'), fullPrompt);
  } catch (err) {
    logger.warn('LayoutBrain', 'Failed to write debug prompt file');
  }

  try {
    const resultString = await generateContent(fullPrompt);
    // Stripping backticks if LLM mistakenly added them
    const cleaned = resultString.replace(/^```json\S*/mg, '').replace(/```\S*/g, '').trim();
    
    // Debug: Log the response
    try {
        fs.writeFileSync(path.join(debugPath, '.debug_layout_response.json'), cleaned);
    } catch (err) {
        logger.warn('LayoutBrain', 'Failed to write debug response file');
    }

    return JSON.parse(cleaned);
  } catch (error) {
    logger.error('LayoutBrain', 'Failed to generate layout blueprint from LLM', error);
    return null;
  }
}

module.exports = { generateLayoutPlan };
