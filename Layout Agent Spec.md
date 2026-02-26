# **Agent 4 Specification: The Layout & Semantic Designer (v2)**

**Role:** BI UX Architect / Semantic Specialist.

**Objective:** Transform the validated data model into a user-ready application using a "Semantic-First" template injection strategy.

## **1\. Sub-Agent A: The Semantic Architect (The Thinker)**

* **Role:** Analyzes the final data model (LinkTable, Facts, Dimensions).  
* **Task:** Define the Master Item library.  
  * **Master Dimensions:** Group logical hierarchies (e.g., Product \-\> Category).  
  * **Master Measures:** Generate the "Golden Formulas" using Set Analysis and the Relative Time Deltas (e.g., Sum({\<\[Month Diff\]={0}\>} Sales)).  
* **Output:** A JSON manifest of Master Items to be created in the app.

## **2\. Sub-Agent B: The UI Strategist (The Expert)**

* **Role:** Visualization Strategy & Mapping.  
* **Task:** Match Master Items to the visual\_catalog.json.  
  * **Template Selection:** Choose BAR\_CHART, KPI\_CARD, or LINE\_TREND based on the measure's purpose.  
  * **Mapping:** Assign the Library IDs from Sub-Agent A to the specific placeholders in the templates.  
* **Output:** A "Visual Blueprint" that describes the sheets and the objects they contain.

## **3\. Sub-Agent C: The Enigma Engineer (The Creator)**

* **Role:** Technical Execution & Placement.  
* **Task:** Physically build the app objects via enigma.js.  
  * **Object Creation:** Call app.createObject() for each Master Item and Visualization.  
  * **Grid Placement:** Calculate the 24-column coordinates for the sheet layout (e.g., KPIs at y:0, Trends at y:6).  
  * **Sheet Logic:** Add all object IDs to the qChildList of the target sheet.

## **4\. The "JSON Vaccine" Protocol**

* **NEVER** allow the LLM to write raw qHyperCubeDef from scratch.  
* **ALWAYS** use deterministic string-replacement in the backend to inject IDs/Labels into "Golden Templates."  
* **MASTER ITEMS FIRST:** Charts should prefer qLibraryId over inline expressions wherever possible.

## **5\. Success Definition**

* The .qvf contains a functional "Executive Dashboard" sheet.  
* All charts are interactive and use Master Items for consistency.  
* Agent 5 (The Analyst) can navigate the app without encountering "Invalid Visualization" errors.