# **Specification: Standalone Data Architect App**

**Objective:** Antigravity is to build a standalone Node.js application. This app, when executed, acts as an autonomous Data Architect for Qlik Sense.

## **1\. App Architecture**

The standalone app must consist of:

* **The Orchestrator Script (index.js):** The entry point that manages the lifecycle.  
* **The Cognitive Core (brain.js):** Manages the communication with the Gemini API (gemini-2.5-flash-preview-09-2025) to make architectural decisions.  
* **The Toolset (qlik\_tools.js):** A library of enigma.js functions for profiling and reloading.  
* **The State Store (state.json):** A local file to persist the "Memory" of the current project (metadata, previous script attempts, etc.).

## **2\. Standalone Logic Flow**

When the app is run (node index.js \--data="./source\_files"):

1. **Connection:** App establishes a WebSocket to localhost:4848.  
2. **Profiling:** App uses qlik\_tools.js to peek at every file in the directory.  
3. **Inference:** App sends the profile results to the Gemini API.  
   * *Prompt:* "Based on this JSON metadata, write a Qlik Load Script that avoids naming collisions and creates a Star Schema."  
4. **Verification:** App takes the generated script and runs a doReload() in a session app.  
5. **Self-Correction:**  
   * If the QIX Engine returns Synthetic Keys, the app captures the system metadata ($Syn, $Field).  
   * It sends the error back to Gemini: "Your last script caused a synthetic key on Field X. Revise the script."  
6. **Finalization:** Once synKeyCount \== 0, the app saves the final .qvs script file and exits.

## **3\. Developer Instructions for Antigravity**

* **No Hardcoding:** All Qlik connection strings and API keys should be handled via a .env file.  
* **Standalone Dependencies:** Ensure package.json includes enigma.js, ws, and the Google Generative AI SDK.  
* **Logging:** The app must log its "thought process" to the console so the user can see the iterations between the Brain and the Engine.