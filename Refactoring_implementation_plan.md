# Qlik Agent Refactoring Roadmap

This plan outlines the systematic refactoring of the Qlik Architect Agent codebase to improve modularity, stability, and statelessness.

## Current Progress
- **Phase 1: Module Loading & Statelessness**: ✅ [COMPLETE]
- **Phase 2: Structured Logging & Enhancer Robustness**: ✅ [COMPLETE]
- **Phase 2.6: Crisis Recovery & Surgical Lifecycle Fixes**: ✅ [COMPLETE]

---

### [DONE] [Phase 2] Structured Logging (Auditability)
- [x] **Phase 1.1: Core Logging & UI Streaming (Refined)**
- [x] **Phase 2.5: Enhancer Robustness Fixes**
- [x] **Phase 2.6: Crisis Recovery & Surgical Lifecycle Fixes**
    - [x] **REVERT invalid URLs**: Removed `/identity/` which caused engine hangs in Desktop.
    - [x] **Fix Pareto Collisions**: Fact-specific table/flag naming prevents synthetic keys.
    - [x] **Unified Session Cleanup**: Reliable `finally` block close and Phase 5 session recycle.
    - [x] **Accurate Cardinality**: Fixed metadata inspection by doing a full reload before reading cardinality.
- [x] **Fix `dual_flag_injector` logic**: Exclude numeric fields from candidates; ensure proper quoting.

---

## Phase 3: Deconstruct the "God Object" (Next)
Deconstruct `agent_runner.js` into a clean orchestrator with separate phase modules.

### [NEW] pipeline/phase1_profiling.js
### [NEW] pipeline/phase2_architect.js
### [NEW] pipeline/phase3_enhancer.js
### [NEW] pipeline/phase4_layout.js

---

## Phase 4: Refactor Qlik Script Generation
Integrate **Handlebars** to replace hardcoded string concatenation in `architect_generator.js`.

### [NEW] templates/base_script.qvs.hbs

---

## Phase 5: Robust Session & Rules Extraction
- Extract deterministic logic into a standalone `rules_engine.js`.
- Standardize `try/catch/finally` patterns for Qlik sessions in `qlik_tools.js`.

---

## Verification Plan
1. **Regression Testing**: Run `node test_classifier_unit.js` after each major structural change.
2. **State Independence**: Run back-to-back jobs to verify no state bleed occurs.
