# Qlik Field Classification Strategy (Refined)

This document outlines a hybrid strategy for field classification, incorporating semantic intent and logical aliasing to bridge data model gaps.

**CRITICAL INSTRUCTION:** The "Semantic Indicators" column provides **EXAMPLES ONLY**. It is NOT an exhaustive list. You must use semantic reasoning to identify synonyms or similar concepts (e.g., "Cost" is semantically identical to "Price").

| **SYSTEM_METADATA** | Technical ETL/Audit fields | e.g., `ROW_ID`, `ETL_`, `BATCH_`, `LoadTimestamp`, `Filename`. | Very high uniqueness (1:1 with row). Technical naming. | **Trap**: Transaction dates (Dates) vs. Row Load timestamps. |

## The Semantic Alias (Bridging synonymous Keys)
To enable the agent to link fields with different names (e.g., `shipVia` and `shipperID`), you must provide a `semanticAlias`.

*   **Definition**: A common logical entity name shared by synonymous fields.
*   **Rules**:
    - If two fields represent the same logical entity across tables but have different names, assign them the **EXACT SAME** `semanticAlias`.
    - **Example**: 
        - `Orders.shipVia` → `semanticAlias: "Shipper"`
        - `Shippers.shipperID` → `semanticAlias: "Shipper"`
        - `Invoices.BillToCustomer` → `semanticAlias: "Customer"`
        - `Customers.customerID` → `semanticAlias: "Customer"`
    - If a field is unique and doesn't share an entity with others, use its own name or a cleaned version as the alias.

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
