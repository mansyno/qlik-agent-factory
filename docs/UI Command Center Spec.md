# **Specification: Synthetic Developer Command Center**

**Objective:** Transform the terminal-based factory into a visual Command Center using React (Vite) and Tailwind CSS.

## **1\. Architectural Strategy**

* **Frontend:** React \+ Vite \+ Tailwind CSS \+ Lucide-React (Icons).  
* **Backend:** Refactor the existing index.js to include an Express server and Socket.io.  
* **The Bridge:** Every time an agent (Architect or Enhancer) logs a "thought" or a "decision," it should be emitted via WebSockets to the UI.

## **2\. Dashboard Requirements**

* **Theme:** Professional Dark Mode (Slate/Zinc palette).  
* **Reasoning Feed:** A real-time, scrolling log window capturing agent-log events from the server.  
* **Model Artifacts:** A visual grid of cards representing the tables found in the LinkTable. Each card should show the table name, row count, and a "Loaded" status indicator.  
* **Script Forge:** A dedicated, code-styled viewer for the EnrichedScript.qvs content.  
* **Control Panel:** A header section with an input for the source data path and a "Run Job" button that triggers the factory via the API.

## **3\. Implementation Railguards**

* **No Rewrite:** AG should wrap existing console.log calls into a broadcast function rather than changing the core reasoning logic.  
* **Concurrency:** Use the concurrently package to launch the Node.js backend and the Vite frontend with one command (npm start).