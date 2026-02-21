# **Backend Integration: Terminal-to-UI Bridge**

**Objective:** Add a communication layer to the current Orchestrator (index.js).

## **1\. Dependencies**

AG must add: express, socket.io, cors, and concurrently.

## **2\. The Broadcast Helper**

Inside index.js, create a helper function broadcastAgentState(agent, message, type).

* It must console.log for the local terminal.  
* It must io.emit('agent-log', { agent, message, type }) for the WebSocket clients.

## **3\. State Sync**

* **Schema Update:** When the Architect finishes profiling, emit the resulting JSON as a model-artifact event.  
* **Script Update:** Every time the script is updated (after Architect validation or Enhancer enrichment), emit the full string as a script-update event.

## **4\. API Endpoint**

* Create POST /api/run which accepts a { path } body and triggers the existing main() orchestration loop.