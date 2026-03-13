# Qlik Field Classification Strategy (Refined)

This table outlines a hybrid strategy for field classification, incorporating expert refinements on semantic intent and edge-case "traps." 

**CRITICAL INSTRUCTION:** The "Semantic Indicators" column provides **EXAMPLES ONLY**. It is NOT an exhaustive list. You must use semantic reasoning to identify synonyms or similar concepts (e.g., "Cost" is semantically identical to "Price").

| Classification | Primary Intent | Semantic Indicators (EXAMPLES ONLY) | Statistical Profile (Heuristics) | Edge Case: The "Trap" |
| :--- | :--- | :--- | :--- | :--- |
| **IDENTIFIER** | Linking tables (Keys) | e.g., Words ending/starting with: `ID`, `KEY`, `CODE`, `Num`, `SK`, `GUID`. | High distinctness. Low null count. Unique (PK) or repeated (FK). | **Trap**: Serial numbers or Barcodes (usually Attributes, not Keys). |
| **MEASURE** | Quantitative analysis (Sum/Avg) | e.g., `Amount`, `Total`, `Qty`, `Weight`, `Tax`, `Qnt`. | Numeric data with high variance. Frequent non-integers. | **Trap**: `Price`, `Cost`, `Units per Carton`, `Rate`. These are usually **ATTRIBUTES** used for calculation, not direct aggregation. |
| **DATE** | Time dimension/Filtering | e.g., `Date`, `Time`, `Year`, `Updated`, `Timestamp`. | Chronological patterns. Standard date formats. | **Trap**: Birth years or Year constants (often Attributes). |
| **ATTRIBUTE** | Context, filtering, or description | e.g., `Name`, `Type`, `City`, `Desc`, `Category`, `Status`, `Barcode`, `Cost`, `Price`. | High repeat values (Low Cardinality) OR static reference values. | **Trap**: `Units in Carton` (Numeric, but master data). |
| **SYSTEM_METADATA** | Technical ETL/Audit fields | e.g., `ROW_ID`, `ETL_`, `BATCH_`, `LoadTimestamp`, `Filename`. | Very high uniqueness (1:1 with row). Technical naming. | **Trap**: Transaction dates (Dates) vs. Row Load timestamps. |

## Refined Decision Matrix

### Measure vs. Attribute
*   **Context Check**: "Is this numeric value transactional or master data?"
    *   **Transactional** (e.g., `ExtendedAmount` in `Orders.csv`) → **MEASURE**
    *   **Master Data / Reference** (e.g., `UnitCost`, `StandardPrice`) → **ATTRIBUTE** (Values are reference points, not additive totals).
*   **Aggregation Check**: "Does summing this value directly make business sense?"
    *   **Yes** (Total Sales, Total Qnt) → **MEASURE**
    *   **No** (Unit Price, Cost, Discount Rate, Carton Size) → **ATTRIBUTE** (Summing a Unit Price is meaningless).

### Identifier vs. Attribute
*   **Functional Check**: "Is this field used primarily to connect to another table?"
    *   **Yes** (CustomerID, BranchID) → **IDENTIFIER**
    *   **No** (Passport Number, SKU Barcode) → **ATTRIBUTE**
