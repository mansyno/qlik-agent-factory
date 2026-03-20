# Architecture & Flow Analysis

The application currently relies heavily on a central orchestrator ([agent_runner.js](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js)) which contains a massive [runAgent](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#251-739) function (~740 lines). Below is a mapping of the current pipeline execution and structural pain points identified so far.

## 1. Flow Execution Mapping

The pipeline executes sequentially through several predefined phases, conditionally triggered by a `pipeline` array (e.g., `['architect', 'enhancer', 'layout']`):

1. **Pre-flight & Initialization**
   - Configures `runFolder` and `logger`.
   - Validates data directories and extracts phase configuration.
   - Opens a connection to the Qlik Engine (`openSession`).
   - If running in Enhancer/Layout mode only (skipping Architect), it fetches the `liveBaseScript` from Qlik beforehand.

2. **Phase 1: Profiling (Architect)**
   - Creates a Session App.
   - Streams and profiles source CSVs (`profileAllData`).
   - Gathers engine metrics (symbols, memory).

3. **Phase 2: Architectural Reasoning (Architect)**
   - Classifies tabular data and fields (`classifyData`).
   - Normalizes data and detects relationships to prevent cyclic references/synthetic keys (`determineRelationships`).
   - Evaluates a structural strategy (e.g., SINGLE_FACT, LINK_TABLE) via `generateBlueprint`.
   - Generates an initial fast-script (FIRST 1) and runs real-time compilation validation (`validateScript`).
   - Includes fallback logic directly in the runner (escalating to LINK_TABLE if Synthetic Keys are found).
   - Generates the complete base `currentScript`.

4. **Phase 3: Enhancer (Hybrid Deterministic & LLM)**
   - Re-loads the App with partial or full script for real metadata.
   - [runDeterministicChecks](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#71-163): Hardcoded rules mapping fields to tools (e.g., `as_of_table`, `dual_flag_injector`).
   - [runPreFlightInspection](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#164-250): Extracts hints (Pareto, Market Basket) to feed to LLM.
   - Calls `generateEnrichmentPlan` (LLM-based planning).
   - Contains inner-loop heuristics to deduplicate LLM logic against Deterministic logic.
   - `composeEnrichment`: Injects new tools into the base script.
   - Re-validates the hybrid script.

5. **Phase 4 & Phase 5: Finalization & Promotion**
   - Saves final QVS to disk.
   - **Critical State Shift**: Destroys the working session app context and creates a persistent App in Qlik (`createPersistentApp`).
   - Migrates script to persistent app, executing a full reload and save.

6. **Phase 6: UI / Layout Generation**
   - Extracts semantic metadata of the final data-model (Tables and Keys).
   - Invokes `generateLayoutPlan` to construct visual blueprint via LLM.
   - Constructs UI natively via JSON vaccines (`composeLayout`).

---

## 2. Identified Anti-Patterns & Bottlenecks

1. **Monolithic Function / "God Object"**
   - Everything is tightly coupled within the [runAgent](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#251-739) function.
   - Shared local variables (`session`, `qlikGlobal`, `workApp`, `currentScript`, `success`) are mutated across 6 distinct phases over hundreds of lines.

2. **Dangling Logic in the Orchestrator**
   - The runner file contains heavy business logic that should be abstracted.
   - Example 1: [runDeterministicChecks](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#71-163) and [runPreFlightInspection](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#164-250) are defined directly in [agent_runner.js](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js) instead of an `enhancer_service.js` or `enhancer_validator.js`.
   - Example 2: The LLM/Deterministic deduplication logic for tools sits explicitly inline in the Enhancer phase loop.
   - Example 3: The fallback logic for escalating linking strategies (`LINK_TABLE` generation) during Architect validation sits inline.

3. **Complex State Management (Connection Lifecycle)**
   - The Qlik Connection state is difficult to trace. The code frequently handles "Session App" vs "Persistent App" by awkwardly closing open sessions mid-flight and overwriting the `session` and `qlikGlobal` variables, which makes error recovery (the `finally` block) brittle.

4. **UI Event / Logger Coupling**
   - The `broadcast` callback is passed down, but is redundantly called alongside `logger.info()` throughout every phase.

---

## 3. Preliminary Modularization Concepts

*(These are thoughts for organization, no changes have been planned yet.)*

- **State Container/Context Object**: Bundle `app`, `connection`, `scriptState`, `logger`, `runConfig` into a `PipelineContext` instance passed down linearly to separate handlers, avoiding shared mutable scope.
- **Phase Handlers**: Extract the phases into cleanly defined asynchronous modules:
  - `orchestrator/phases/architectPhase.js`
  - `orchestrator/phases/enhancerPhase.js`
  - `orchestrator/phases/layoutPhase.js`
- **Domain Service Abstraction**: Move [runDeterministicChecks](file:///d:/A_i/qlik/poc%20architect%20agent/agent_runner.js#71-163) and LLM collision detection into [enhancer_brain.js](file:///d:/A_i/qlik/poc%20architect%20agent/enhancer_brain.js) or a new `enhancer_heuristics.js`. Move the architecture fallback loop into [architect_structural_tester.js](file:///d:/A_i/qlik/poc%20architect%20agent/architect_structural_tester.js) where the strategy is originally generated.
