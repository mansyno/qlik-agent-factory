const { execSync, spawn } = require('child_process');
const { LMStudioClient } = require('@lmstudio/sdk');
const fs = require('fs');
const path = require('path');
const logger = require('../.agent/utils/logger.js');

let lmsClient = null;

/**
 * Returns the LM Studio client.
 */
function getClient() {
    if (!lmsClient) {
        lmsClient = new LMStudioClient();
    }
    return lmsClient;
}

/**
 * Robustly checks the server status by reading stdout.
 */
function checkServerIsUp() {
    try {
        const status = execSync('lms status', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const cleanStatus = status.replace(/\u001b\[[0-9;]*m/g, '');
        const isUp = cleanStatus.toLowerCase().includes('server: on') || cleanStatus.toLowerCase().includes('server:  on');
        return isUp;
    } catch (e) {
        return false;
    }
}

/**
 * Explicitly attempts to start the lms server. 
 */
async function startServer() {
    const isUp = checkServerIsUp();
    if (isUp) return true;

    logger.info('LMStudio', 'Attempting to start lms server explicitly...');
    try {
        if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', '/B', 'lms', 'server', 'start', '--cors'], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        } else {
            spawn('lms', ['server', 'start', '--cors'], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        }
        return true;
    } catch (startError) {
        logger.error('LMStudio', 'Failed to spawn lms server: ' + startError.message);
        throw new Error('Failed to start LM Studio server.');
    }
}

/**
 * Stops the lms server completely and removes it from memory.
 */
async function stopServer() {
    logger.info('LMStudio', 'Shutting down lms server...');
    try {
        // 1. Try the graceful CLI stop first
        try {
            execSync('lms server stop', { stdio: 'ignore' });
        } catch (gracefulErr) {
            // ignore errors if it was already stopped
        }

        // 2. Forcefully kill processes to ensure it's removed from memory (as requested)
        if (process.platform === 'win32') {
            // /F = Force, /IM = Image Name, /T = Tree (kill child processes)
            execSync('taskkill /F /IM "LM Studio.exe" /T', { stdio: 'ignore' });
        } else {
            execSync('pkill -f "LM Studio"', { stdio: 'ignore' });
        }
        
        return true;
    } catch (e) {
        // If taskkill fails because process isn't found, that's actually a success for us
        return true;
    }
}

/**
 * Unloads ALL models from memory.
 */
async function unloadAllModels() {
    if (!checkServerIsUp()) return;
    try {
        const client = getClient();
        const loaded = await client.llm.listLoaded();
        for (const model of loaded) {
            logger.info('LMStudio', `Unloading model: ${model.identifier}`);
            await client.llm.unload(model.identifier);
        }
        return true;
    } catch (e) {
        logger.error('LMStudio', 'Failed to unload models: ' + e.message);
        return false;
    }
}

async function getAvailableModels() {
    const isUp = checkServerIsUp();
    if (!isUp) throw new Error('LM Studio server is offline.');

    try {
        const client = getClient();
        const models = await client.system.listDownloadedModels();
        const loaded = await client.llm.listLoaded();
        
        return {
            available: models.filter(m => m.type === 'llm').map(m => m.modelKey),
            loaded: loaded.length > 0 ? loaded[0].identifier : null
        };
    } catch (e) {
        logger.error('LMStudio', 'Failed to list models: ' + e.message);
        throw new Error('Failed to retrieve models from LM Studio.');
    }
}

async function loadModel(modelId) {
    const client = getClient();
    const loaded = await client.llm.listLoaded();
    
    // Check if THIS specific model is already loaded
    if (loaded.some(m => m.identifier === modelId)) {
        return await client.llm.model(modelId);
    }

    // Unload everything else first to save VRAM
    await unloadAllModels();

    logger.info('LMStudio', `Loading model ${modelId} with 10k context...`);
    await client.llm.load(modelId, { 
        identifier: modelId,
        config: {
            contextLength: 10240, 
            gpuOffload: "max"
        }
    });
    
    return await client.llm.model(modelId);
}

/**
 * Strips markdown code blocks and extracts JSON from a string.
 */
function cleanJsonResponse(content) {
    if (typeof content !== 'string') return content;
    let cleaned = content.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '');
    cleaned = cleaned.replace(/```\s*$/i, '');
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        cleaned = cleaned.substring(startIdx, endIdx + 1);
    }
    return cleaned;
}

async function generateContent(modelId, prompt, systemInstruction = null, options = {}) {
    if (!modelId) throw new Error("No LM Studio model selected.");
    const model = await loadModel(modelId);
    const messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });
    
    if (options.runFolder) {
        fs.writeFileSync(path.join(options.runFolder, '.debug_lms_prompt.txt'), `SYSTEM:\n${systemInstruction}\n\nUSER:\n${prompt}`);
    }

    const result = await model.respond(messages);
    if (options.runFolder) {
        fs.writeFileSync(path.join(options.runFolder, '.debug_lms_response.txt'), result.content);
    }
    return result.content;
}

async function generateJsonContent(modelId, prompt, schema, systemInstruction = null, options = {}) {
    if (!modelId) throw new Error("No LM Studio model selected.");
    const model = await loadModel(modelId);
    const messages = [];
    const strictSystem = (systemInstruction || "") + "\n\nCRITICAL: Return RAW JSON ONLY. DO NOT wrap in markdown code blocks.";
    messages.push({ role: 'system', content: strictSystem });
    messages.push({ role: 'user', content: prompt });
    
    const result = await model.respond(messages, {
        structured: { type: "json", schema: schema },
        timeout: 120000 
    });
    
    let rawContent = result.content;
    if (options.runFolder) fs.writeFileSync(path.join(options.runFolder, '.debug_lms_json_response_raw.txt'), rawContent);

    const cleanedContent = cleanJsonResponse(rawContent);
    try {
        return JSON.parse(cleanedContent);
    } catch (e) {
        logger.error('LMStudio', 'Failed to parse JSON response.', { preview: rawContent?.substring(0, 200) + '...' });
        throw new Error('Model returned invalid JSON.');
    }
}

module.exports = {
    checkServerIsUp,
    startServer,
    stopServer,
    unloadAllModels,
    getAvailableModels,
    loadModel,
    generateContent,
    generateJsonContent
};