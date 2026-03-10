# MODEL & PACKAGE ENFORCEMENT

* ALWAYS use the most recent model versions available in the environment: 'gemini-3-flash-preview' for text/logic and 'gemini-2.5-flash-image-preview' for image-related tasks.
* NEVER default to Gemini 1.5, Gemini 2.5, or older versions.
* Ensure all Node.js packages used (enigma.js, ws, etc.) are implemented using the latest stable ECMAScript standards (ES6+).
* If a model version is explicitly requested in a prompt (e.g., 'gemini-3-flash-preview'), do not override it with a different version.
* When generating Qlik Load Scripts, strictly adhere to the professional standards defined in the Agent Specs (e.g., Canonical Dates, Dual formatting).