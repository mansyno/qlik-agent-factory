# **Antigravity Skills for Qlik Engine**

*These definitions tell Antigravity how to build the .agent/skills/ directory for the Architect Agent.*

## **1\. Skill: qlik-data-profiler**

**Path:** .agent/skills/qlik-data-profiler/SKILL.md

## **name: qlik-data-profiler description: Profiles raw data files by connecting to Qlik Sense Desktop and loading a sample to analyze cardinality and uniqueness.**

### **Goal**

Extract the "DNA" of a data source so the Architect can plan joins.

### **Instructions**

1. Establish a session with Qlik Sense Desktop (localhost:4848).  
2. Create a temporary session app.  
3. Perform a FIRST 50 LOAD \* from the target path.  
4. Query the $Field and $Table system tables.  
5. Return a JSON object containing field names and their distinct count.

## **2\. Skill: qlik-script-validator**

**Path:** .agent/skills/qlik-script-validator/SKILL.md

## **name: qlik-script-validator description: Tests a Qlik Load Script for technical validity and identifies Synthetic Keys or Circular References.**

### **Goal**

Ensure the data model is healthy before the Architect commits to it.

### **Instructions**

1. Open a sandbox session app in the Qlik Engine.  
2. Set the provided script string and execute doReload().  
3. If reload fails, capture the error log.  
4. If reload succeeds, check the internal counts for $Syn (Synthetic Keys).  
5. **Output:** Return a report: { success: bool, synKeys: int, errors: string\[\] }.

## **3\. Implementation Note for Antigravity**

The logic inside these skills should leverage a shared Node.js helper (e.g., scripts/qlik-helper.js) to handle the enigma.js WebSocket handshake, as documented in our technical reference.