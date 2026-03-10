# Qlik Data Architect: V2 Pipeline Specification

This document formalizes the updated Data Modeling pipeline designed to natively process raw tables into a validated, enterprise-grade associative schema in Qlik Sense. It prioritizes the Qlik Engine as a compilation/validation layer to eliminate LLM graph hallucinations.

## Core Architectural Principles
- **No LLM Graph Hallucinations**: Qlik's Native Engine is used as a compiler. Every proposed data model is tested via a 1-row data load. If `$synthetic` tables or circular references appear in Qlik's metadata, the build fails and passes the exact error back to the LLM.
- **Statistical Profiling Pre-computation**: The LLM is never asked to guess field cardinalities or null percentages. A backend script pre-profiles the full datasets using Qlik and feeds absolute statistical JSON metadata to the LLM before inference begins.
- **Associative Default**: The pipeline defaults to keeping tables separate (Associative Model) linked by a single clean key. It generally avoids flattening tables (e.g., joining Headers and Details) to preserve raw granularity, but will evaluate the statistical metadata (cardinality, row counts, user query patterns) to strategically utilize `LEFT JOIN` if flattening mathematically improves usability without unacceptable bloat.

---

## The 8-Step Algorithm Pipeline

### Step 0: Pre-computation Profiling (Backend)
**Action:** A dedicated Qlik profiling script loads all available tables entirely into RAM. **CRITICAL:** The load script MUST utilize `QUALIFY *` for every table during this profiling phase; otherwise, Qlik will build massive, memory-crashing Synthetic Keys pulling down the server.
**Output:** Extracts formal metadata including Field Lists, Row Counts, Distinct Counts, Null Percentages, and Min/Max values per table. This JSON payload is injected into the LLM context.

### Step 1: Classify Tables by Role and Grain (LLM)
**Action:** The LLM evaluates the JSON profile and field names.
- **Candidate Keys:** Fields with high distinctness and low nulls.
- **Header Grain:** Keys strictly formatted like `DocID`.
- **Detail Grain:** Composite keys formatted like `DocID + LineNo`.
- **Fact-like:** Additive measures (Amount, Qty) + Foreign keys.
- **Dimension-like:** Stable descriptive attributes (Customer, Product).

### Step 2: Normalize Field Names (LLM)
**Action:** Standardize primary/foreign keys to ensure intended associations (e.g., `CustomerKey`). Rename generic fields (e.g., `Date`) to role-specific names (`OrderDate`, `ShipDate`) to prevent accidental intersections.
**Hard Stop:** No two tables may share 2+ field names identically (Synthetic Key trigger). If they do, evaluate if those fields logically form a composite ID. If yes, instruct the generated script to hash/concatenate them into a singular new Composite Key field, dropping the association on the original separate fields.

### Step 3: Build Conceptual Association Graph (LLM)
**Action:** The LLM maps the intended edges between tables via normalized shared keys.
**Hard Stop:** No circular reference cycles are permitted.

### Step 4: Handle Mixed Granularity (Header/Detail)
**Action:** Keep Headers and Details separate, linked by exactly one associative field (e.g., `OrderKey`). Do NOT default to joining these into a flat table without explicit performance metrics requiring a Left Join. Leave Header-level numerical measures physically inside the Header table.

### Step 5: Shared Dimensions & Link Tables
**Action:** Connect common dimensions (like `Customer`) directly to their respective Fact tables using single canonical keys (`CustomerKey`).
**Link Table Trigger:** Only utilize a Link Table if two distinct Fact tables share **2+ conformed keys** simultaneously (e.g., connecting both Facts to Customer AND Product). 

### Step 6: Dates and Temporal Roles
**Action:** If a Fact possesses a single date, provision a standard Master Calendar.
If a Fact possesses **multiple dates** (OrderDate, ShipDate), deploy a **Canonical Date Bridge** using the following rigid, pre-defined QVS template to avoid syntax hallucinations:
```qvs
BridgeTable:
LOAD OrderKey as CommonKey, 'Order' as DateType, OrderDate as CanonicalDate Resident FactTable;
CONCATENATE(BridgeTable)
LOAD OrderKey as CommonKey, 'Ship' as DateType, ShipDate as CanonicalDate Resident FactTable;
```

### Step 7: Decide Join vs Keep vs Association
**Action:** Default rigidly to **Association** (Keep tables separate). 
Only use `JOIN` when mapping a multi-level hierarchy or 1:1 dimension extension that will not multiply fact rows. Use `KEEP` for strict intersection filtering where tables must remain logically separate.

### Step 8: Absolute Compilation Validation (Backend)
**Action:** The generated QVS script is executed on the Qlik Engine with a `First 1` load constraint per table. The backend script queries the Qlik `TableList`.
**Failure Metrics (Auto-Reprompt LLM):**
1. Evidence of Circular References.
2. Evidence of Synthetic Keys (Tables named `$Synthetic...`)
3. Disconnected island Facts without declared grains.
