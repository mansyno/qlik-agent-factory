# Qlik Agent Factory

A multi-phase agent pipeline and React-based Command Center designed to parse raw CSV data, determine complex star-schema or LinkTable strategies, inject advanced Qlik script heuristics, and automatically generate visual layouts for Qlik Sense.

## Current Pipeline

The Agent Factory pipeline automates the generation of a Qlik Sense App through three major phases:

### 1. Architect Phase
- **Profiling Data:** Scans raw CSV files locally to determine cardinalities and metrics.
- **LLM Classification:** Identifies fields as Identifiers, Dates, Attributes, or Measures.
- **Relationship Detection:** Detects overlaps and unifies ID names to build a clean associative data model.
- **Structural Tester:** Determines whether to use `CONCATENATE`, `LINK_TABLE`, or `MULTI_FACT_STAR` strategies.
- **Generator & Validation:** Emits the base `QVS` load script and validates it against the local Qlik Engine API via Enigma.js.

### 2. Enhancer Phase
- **Heuristic Inspection:** Analyzes the generated architecture and proposes script enhancements.
- **Tool Injection:** Recommends and injects Qlik-specific technical solutions like `as_of_table` (rolling calendars) or `dual_flag_injector` (sorting utilities).
- **LLM Refinement:** Deduplicates deterministic rules against LLM-driven architectural suggestions before finalizing the enhanced script.

### 3. Layout Phase
- **Visual Scaffold:** Connects to the Qlik Engine to identify measures and dimensions.
- **Template Generation:** Selects appropriate charts (Bar Charts, Line Charts, KPIs, Tables) and lays them out into a functional dashboard sheet directly within the `.qvf` app.

---

## Prerequisites

Before installing the project, ensure you have the following on your machine:
- **Node.js** (v18 or higher)
- **Qlik Sense Desktop** (Must be running and authenticated in the background)
- **AI Engine Options** (You need at least one of the following):
  - **Option A (Cloud):** A **Gemini API Key** (Required for the default cloud LLM agents).
  - **Option B (Local):** **LM Studio** installed and running with the `lms` CLI enabled, and at least one LLM model downloaded (e.g., Llama-3-8B-Instruct).

## Installation Instructions

1. **Clone the repository**
   ```bash
   git clone <repository_url>
   cd "poc architect agent"
   ```

2. **Install Backend Dependencies**
   Run the following command in the root directory:
   ```bash
   npm install
   ```

3. **Install Frontend Dependencies**
   Navigate to the `ui` directory and install its dependencies:
   ```bash
   cd ui
   npm install
   cd ..
   ```

4. **Environment Configuration (If using Gemini Cloud)**
   Create a `.env` file in the root directory of the project and add your Gemini API key:
   ```env
   GEMINI_API_KEY=your_api_key_here
   ```
   *(If you intend to strictly use LM Studio locally, you can skip this step).*

*(Note: The `projects/` directory, which stores your agent runs, is gitignored. The application will automatically create this directory structure the first time you execute a run.)*

## Running the Application

To launch both the backend server and the Vite React UI simultaneously, run:

```bash
npm start
```

Once the servers start, open your browser and navigate to the Command Center:
**[http://localhost:5173](http://localhost:5173)**

From the Command Center, you can select your data source, choose a pipeline to execute (Architect, Enhancer, and/or Layout), and monitor the agents' progress via the live WebSocket feed.

---

## Future Features / Roadmap

- **Interactive JS Data Model Viewer**: Implement an interactive, Node-based UI (e.g., using React Flow or Cytoscape.js) directly within the Agent Factory's UI. This will replicate the Qlik Sense Data Model Viewer experience (tables, fields, associative links, panning/zooming) without needing to open the Qlik Hub, allowing users to visually inspect and debug the generated associative model in real-time before finalizing the app.
