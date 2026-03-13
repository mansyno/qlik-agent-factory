# Qlik Architect Agent: Pipeline Audit

This document provides a structured breakdown of the Architect Agent's multi-phase pipeline, distinguishing between AI-driven (LLM) and programmatic (Deterministic) logic.

## Pipeline Overview

The pipeline follows an **"Assisted Determinism"** pattern:
1.  **Profiling**: Real-world data metrics (Deterministic).
2.  **Classification**: Semantic understanding of data intent (AI/LLM).
3.  **Modeling**: Solving relationships and normalization (Deterministic).
4.  **Generation**: Outputting standard Qlik Script (Deterministic).
5.  **Validation**: Real-time feedback from the Qlik Engine (Deterministic).

---

## Phase 0: Engine Native Profiling
- **Type**: Deterministic (Programmatic)
- **Input**: CSV Files, Path.
- **Process**:
    - Opens a temporary Qlik Session.
    - Loads data into memory using a raw `LOAD *` to let the Qlik Engine calculate symbol counts and memory footprint.
- **Output**: `engineMetrics` (Memory size, Field cardinality per table).

## Phase 1: Data Profiling
- **Type**: Deterministic (Programmatic)
- **Input**: CSV Files, Path, `engineMetrics`.
- **Process**:
    - Streams files locally to calculate frequency, null counts, information density, and uniqueness ratios.
    - **Relational Analysis**: Compares distinct values between every field pair to find overlap ratios (e.g., "Field A shares 90% of values with Field B").
- **Output**: `profileMetadata` (A massive JSON of data statistics and overlap matrix).

## Phase 2: Classification
- **Type**: AI-Driven (Gemini 3 Flash)
- **Input**: `profileMetadata` + `field_classification_strategy.md` (Architectural Rules).
- **Process**:
    - The LLM acts as a "Senior Architect".
    - It maps field names and statistics to semantic roles: `IDENTIFIER`, `MEASURE`, `DATE`, `ATTRIBUTE`.
    - It detects "Traps" specified in the strategy (e.g., "Cost" is an Attribute in Dim tables but a Measure in Fact tables).
- **Output**: `classifications` (Table roles [FACT/DIMENSION], Grain definitions, and Field-level types).

## Phase 3: Relationship Detection & Normalization
- **Type**: Deterministic (Programmatic)
- **Input**: `profileMetadata` (Step 1) + `classifications` (Step 2).
- **Process**:
    - **Tokenization**: Splits names like `LorryID` into `['lorry', 'id']`.
    - **Relationship Scoring**: Combines overlap ratios with token similarity and classification types to find valid links.
    - **Normalization**: If "Field A" and "Field B" link with >0.7 confidence, they are unified under the **same logical name** to enforce Qlik's associative engine.
    - **Collision Guards**: Prevents multiple fields in the *same* table from getting the same name.
- **Output**: `normalizedData` (Tables with fields aliased to their logical global names).

## Phase 4: Structural Strategy
- **Type**: Deterministic (Programmatic)
- **Input**: `normalizedData`.
- **Process**:
    - **Similarity Check**: Groups Fact tables with >70% overlapping fields (Likely candidates for `CONCATENATE`).
    - **Modeling Guard**: Counts shared keys between facts.
        - 2+ shared keys -> `LINK_TABLE` strategy.
        - 0-1 shared keys -> `MULTI_FACT_STAR` strategy.
- **Output**: `structuralBlueprint` (Modeling strategy and grouping instructions).

## Phase 5: Script Generation
- **Type**: Deterministic (Programmatic)
- **Input**: `structuralBlueprint` + `normalizedData`.
- **Process**:
    - Generates the actual Qlik Load Script (QVS).
    - Implements logic for `LinkTable`, `CanonicalDateBridge`, and `MasterCalendar`.
    - Forces aliasing in fact tables in `LINK_TABLE` mode to prevent synthetic keys between measures.
- **Output**: `.debug_final_script.qvs` (The Load Script).

## Phase 6: Engine Validation (Structural Test)
- **Type**: Deterministic (Qlik Engine Integration)
- **Input**: `.debug_final_script.qvs`.
- **Process**:
    - Sends the script to a real Qlik Engine.
    - Captures syntax errors, Synthetic Keys, and Circular References.
- **Output**: `validationResult` (Pass/Fail). If "Fail" due to Synthetic Keys, the pipeline can **Escalate** to a safer strategy (e.g., force a Link Table).

---

## Technical Audit: Where "Isolation" & "Aliasing" Live
- **Relationship Detector (Phase 3)**: Optimized with strict semantic logic:
    1.  **Strict Identifier Guard (Fixed)**: Implemented a penalty system. If two fields match value overlap but fail token similarity (e.g., `Order_ID` vs `SalesMgr_ID`), the confidence is penalized by 0.4. This prevents the "leap of logic" seen in `data2`.
    2.  **Entity Protection (Fixed)**: Identifier unification now requires an exact token match (e.g. `Product_ID` and `Product_ID`) or a precise `Table.ID` match. This stopped `Product_ID` from merging with `Product Group ID`, resolving the dynamic triangle cycle.
    3.  **Global Namespace Guard**: All fields default to table-prefixed names unless confirmed unique and safe, preventing "Measure Hijacking" for `Cost` and `Price`.
- **Generator (Phase 5)**: This converts the logical mapping into Qlik code. I fixed two synchronization bugs here:
    1.  **Resident Mapping**: Fixed the `LinkTable` to correctly identify when a field is in a consolidated fact (uses normalized name) vs. a standalone fact (uses prefixed name).
    2.  **Bracket Sensitivity**: Ensured that bracketed names are handled consistently during the prefixing and resident loading process.
- **Classification (Phase 2)**: Updated the semantic strategy to ensure Unit Prices and Costs are treated as `ATTRIBUTES` (Reference data) rather than `MEASUREs` (Transactional totals). This forces the system to treat them as descriptive metadata that shouldn't be automatically summed or linked across distinct entities.
