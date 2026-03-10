# **Agent 3 Specification: The Tool-Aware Script Enhancer (v3)**

**Objective:** Combine AI reasoning with a dual-tier execution strategy. The AI acts as a "Senior Architect" that chooses between pre-defined Catalog tools (Tier 1\) and custom-synthesized script blocks (Tier 2 \- The Forge).

## **1\. The Decision Logic (Pick and Match)**

1. **Analyze Metadata:** Review field names, cardinality, and sample data.  
2. **Strategy Selection:**  
   * **Tier 1 (Catalog):** Default choice for structural improvements. The AI "picks" a Tool ID from the Manifest and provides the parameters.  
   * **Tier 2 (The Forge):** Used only for unique logic (e.g., complex Pick(Match()) or one-off cleanup).  
3. **Execution:** The Composer fills the template (Tier 1\) or validates the synthesis (Tier 2).

## **2\. The Toolbox Manifest (Catalog Tools)**

The AI is aware of these high-reliability tools:

| Tool ID | Description | Required Parameters |
| :---- | :---- | :---- |
| master\_calendar | Temporal dimensions via Derived Fields. | dateField, canonicalName |
| as\_of\_table | Rolling period mapping for trend analysis. | dateField, periodTypes |
| pareto\_analysis | 80/20 segmentation (Proper Qlik syntax). | factTable, dimension, measure |
| market\_basket | P2P association table (Syntax-safe). | factTable, idField, itemField |
| dual\_flag\_injector | Wraps categorical fields in Dual() logic. | fieldName, mappingPairs |
| autonumber\_keys | Model optimization (Link Keys). | keyFields |

## **3\. The Forge: Syntax Guardrails (MANDATORY)**

To pass the sandbox, AI-synthesized code MUST follow these rules:

1. **No SQL Aggregations:** NEVER use Sum(), Count(), or Avg() in a LOAD without a GROUP BY.  
2. **Resident Only:** All transformation logic must use RESIDENT loads.  
3. **Variable Pre-Calculation:** If a total is needed as a denominator, load it into a variable first using Peek() or a separate aggregation pass.

## **4\. Error Handling (Sandbox Loop)**

* All Forge snippets are tested in a session app.  
* If a snippet fails, the AI gets the error log and has **one** attempt to fix it.  
* If it fails3 times, the enrichment is discarded to ensure the project reloads successfully.

## **5\. Success Criteria**

* 0 Synthetic Keys.  
* 0 Syntax Errors.  
* Associative integrity maintained.