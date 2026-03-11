# Qlik Field Classification Strategy (Refined)

This table outlines a hybrid strategy for field classification, incorporating expert refinements on semantic intent and edge-case "traps."

| Classification | Primary Intent | Semantic Indicators (AI) | Statistical Profile (Heuristics) | Edge Case: The "Trap" |
| :--- | :--- | :--- | :--- | :--- |
| **IDENTIFIER** | Linking tables (Keys) | Ends/starts with: `ID`, `KEY`, `CODE`, `Num`, `SK`, `GUID`. | High distinctness. Low null count. Unique (PK) or repeated (FK). | **Trap**: Serial numbers or Barcodes (usually Attributes, not Keys). |
| **MEASURE** | Quantitative analysis (Sum/Avg) | Words: `Amount`, `Total`, `Qty`, `Price`, `Weight`, `Tax`, `Qnt`. | Numeric data with high variance. Frequent non-integers. | **Trap**: `Units per Carton` or `Price` (often Attributes in non-Fact tables). |
| **DATE** | Time dimension/Filtering | Words: `Date`, `Time`, `Year`, `Updated`, `Timestamp`. | Chronological patterns. Standard date formats. | **Trap**: Birth years or Year constants (often Attributes). |
| **ATTRIBUTE** | Context, filtering, or description | Words: `Name`, `Type`, `City`, `Desc`, `Category`, `Status`, `Barcode`. | High repeat values (Low Cardinality). Text or categorical IDs. | **Trap**: `Units in Carton` (Numeric but usually static/Attribute). |
| **SYSTEM_METADATA** | Technical ETL/Audit fields | Words: `ROW_ID`, `ETL_`, `BATCH_`, `LoadTimestamp`, `Filename`. | Very high uniqueness (1:1 with row). Technical naming. | **Trap**: Transaction dates (Dates) vs. Row Load timestamps. |

## Refined Decision Matrix

### Measure vs. Attribute
*   **Context Check**: "Is this numeric value transactional or master data?"
    *   **Transactional** (e.g., `Price` in `Orders.csv`) → **MEASURE**
    *   **Master Data** (e.g., `Price` in `Product.csv`) → **ATTRIBUTE** (Used for reference/filtering, not just aggregation).
*   **Aggregation Check**: "Does summing this value make business sense?"
    *   **Yes** (Total Sales, Total Qnt) → **MEASURE**
    *   **No** (Units per Carton, Exchange Rate) → **ATTRIBUTE**

### Identifier vs. Attribute
*   **Functional Check**: "Is this field used primarily to connect to another table?"
    *   **Yes** (CustomerID, BranchID) → **IDENTIFIER**
    *   **No** (Passport Number, SKU Barcode) → **ATTRIBUTE**
