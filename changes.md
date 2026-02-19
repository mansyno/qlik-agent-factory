# Agent Refinements

## connection Issues
- Updated `qName` to 'SourceData' in `index.js`.
- Verified `qlik_tools.js` reuses the session app.
- Added logging to confirm connection creation.

## Rate Limiting
- Switched model to `gemini-1.5-flash` for better availability.
- Implemented 60s retry delay in `index.js` for 429 errors.

## Model Update
- `gemini-1.5-flash` chosen as a robust fallback after `gemini-2.0-flash` hit rate limits.
