# **Agent 2 Implementation: The Data Architect**

**Developer Platform:** Google Antigravity

**Target Agent:** The Data Architect (Autonomous Qlik Developer)

## **1\. Role Definition**

The Architect Agent is a specialized instance created by Antigravity. Its primary "Brain" logic is to navigate the journey from raw data to a clean associative model. It operates by delegating technical execution to **Antigravity Skills**.

## **2\. Core Workflow (Planning Mode)**

Antigravity should configure the Architect Agent to follow this specific loop:

1. **Discovery Phase:** \* The Agent identifies the data sources (CSV/SQL).  
   * It invokes the qlik-data-profiler skill for each source.  
   * **Goal:** Determine field names, data types, and cardinality.  
2. **Schema Drafting:** \* The Agent compares results from all profiles.  
   * It identifies "Natural Keys" (shared names with high value overlap) vs "Naming Collisions" (shared names with no value overlap).  
   * It designs a Star Schema, choosing the largest table as the Fact.  
3. **Script Synthesis:** \* The Agent generates a Qlik Load Script string.  
   * It must use QUALIFY patterns and AS aliases based on its mapping logic.  
   * It ensures all link keys are wrapped in AutoNumber().  
4. **Validation Loop:** \* The Agent passes the script to the qlik-script-validator skill.  
   * If the skill returns synKeys \> 0, the Agent enters a "Debug" state, analyzes the system metadata, renames the offending fields, and retries.

## **3\. Success Criteria**

* **Reload Success:** The engine confirms data is loaded.  
* **Zero Synthetic Keys:** The associative model is clean.  
* **Associativity Test:** The Agent performs a sample selection via the profiler to ensure filtering works as intended.

## **4\. Interaction with Orchestrator**

Once successful, this Agent produces a **Model Artifact** (The validated Script \+ Schema Diagram) and signals the Orchestrator to "hand off" to the Script Enhancer (Agent 3).