# Qlik Agent Factory

A multi-phase agent pipeline designed to parse raw CSV data, determine complex star-schema or LinkTable strategies using deterministic rules and LLM classifications, and generate load scripts for Qlik Sense.

## Current Pipeline

The Agent Factory pipeline automates the generation of a Qlik Sense App by doing the following:
1. **Profiling Data** (Local streaming)
2. **LLM Classification** (Identifying Identifiers, Date Fields, Attributes, Measures)
3. **Relationship Detection & Normalization** (Detecting overlaps and unifying ID names)
4. **Structural Tester** (Determining `CONCATENATE`, `LINK_TABLE`, or `MULTI_FACT_STAR` strategies)
5. **Architect Generator** (Emitting `QVS` Load Script code)
6. **Engine Validation** (Validating script with the Qlik Engine API via Enigma.js)

## Future Features / Roadmap

- **Interactive JS Data Model Viewer**: Implement an interactive, Node-based UI (e.g., using React Flow or Cytoscape.js) directly within the Agent Factory's UI. This will replicate the Qlik Sense Data Model Viewer experience (tables, fields, associative links, panning/zooming) without needing to open the Qlik Hub, allowing users to visually inspect and debug the generated associative model in real-time before finalizing the app.
