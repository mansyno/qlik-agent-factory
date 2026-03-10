# Qlik Architect Agent - Handoff Context

## Current Objective
Stabilizing the `Enhancer-only` pipeline execution and fixing hardcoded values in Qlik catalog templates.

## What Was Just Completed
1. **Catalog Templates (`templates/catalog.json`)**
   - The `pareto_linked` template was failing because the join key (`%Key_Sales`) was hardcoded.
   - We removed the `factKey` parameter requirement from the LLM.
   - The template now dynamically derives the key using Qlik script: `LET vParetoKey = '%Key_' & Mid('{{factTable}}', 6);` (Because all fact tables are named `Fact_Something`, this correctly yields `%Key_Something`).
2. **Enhancer Brain (`enhancer_brain.js`)**
   - Removed JSON parsing hacks and restored clean `JSON.parse`. Removed prompt instructions about `factKey` to reduce LLM confusion.
3. **Enhancer Composer (`enhancer_composer.js`)**
   - Added a safeguard that scans the generated Qlik script for unreplaced `{{placeholders}}` and gracefully rejects the tool if the LLM omitted required parameters, rather than passing a broken script to Qlik.
4. **Agent Orchestration (`agent_runner.js`)**
   - Completely rewritten for stability.
   - Fixed the `App already open` conflict. Qlik Desktop only allows an app to be opened in one session context at a time.
   - For `Enhancer-only` mode, `runAgent` now sequentially extracts the live base script *first* using a temporary connection, closes it, and *then* opens the main working session.
   - To bypass session locking issues, the read session connects directly to the app URL (`ws://localhost:4848/app/${appName}`) and uses `getActiveDoc()` instead of `openDoc()`.

## Where We Got Stuck (Next Steps for New Chat)
Right before the context limit was hit, the UI/CLI threw this error during the new `Enhancer-only` pre-read step:
```text
System: Enhancer-only mode: reading live script from 'northwind2'...
System: Could not read live app: Unknown error
```
**Goal for the new chat:** 
Debug `fetchLiveBaseScript` in `agent_runner.js`. The direct WebSocket URL + `getActiveDoc()` approach is throwing an "Unknown error". We need to find out why the read session is failing and fix the `fetchLiveBaseScript` function so the Enhancer can reliably pull the live script before the main pipeline starts.

---
*To the next AI: Please review `agent_runner.js` (specifically `fetchLiveBaseScript`) and start by diagnosing the "Unknown error" when connecting via `getActiveDoc().`*
