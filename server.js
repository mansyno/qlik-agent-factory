const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const logger = require('./.agent/utils/logger.js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const { runAgent } = require('./agent_runner');
const { getActiveModel, MODELS, setActiveModel } = require('./brain');
const { listProjects, listRuns, readRunConfig, getRunFolder } = require('./path_manager');
const fs = require('fs');

app.use(cors());
app.use(express.json());

let agentRunning = false;
const agentControl = { stopRequested: false, paused: false, resumeCallback: null };

function resetControl() {
    agentControl.stopRequested = false;
    agentControl.paused = false;
    agentControl.resumeCallback = null;
}

// ─── Logger Integration ──────────────────────────────────────────────────────
logger.addListener((entry) => {
    if (io) {
        io.emit('agent-log', {
            agent: entry.agent,
            message: entry.message,
            type: (entry.level || 'info').toLowerCase(),
            data: entry.details,
            timestamp: entry.timestamp
        });
    }
});

// ─── Broadcast Helper ────────────────────────────────────────────────────────
function broadcastAgentState(agent, message, type = 'info', data = null) {
    const level = type.toUpperCase() === 'PHASE' ? 'PHASE' : 
                  (type.toUpperCase() === 'ERROR' ? 'ERROR' : 
                  (type.toUpperCase() === 'WARNING' ? 'WARNING' : 'INFO'));
    logger.log(level, message, data, agent);
}

// ─── API: Run Job ──────────────────────────────────────────────────────────
app.post('/api/run', async (req, res) => {
    if (agentRunning) {
        return res.status(409).json({ error: 'Agent is already running.' });
    }
    const { projectName = 'test', dataDir, appName, pipeline = ['architect', 'enhancer'] } = req.body;
    if (!dataDir || !appName || !projectName) {
        return res.status(400).json({ error: 'projectName, dataDir and appName are required.' });
    }

    res.json({ status: 'started' });
    agentRunning = true;
    resetControl();
    io.emit('job-started', { projectName, dataDir, appName, pipeline });

    try {
        await runAgent({ projectName, dataDir, appName, pipeline, io, broadcastAgentState, agentControl });
    } catch (err) {
        console.error('Unhandled run error:', err);
        // agent_runner ideally broadcasts logical errors, but log this just in case
    } finally {
        agentRunning = false;
        agentControl.paused = false;
        io.emit('job-complete');
    }
});

// ─── API: Workspace Management ──────────────────────────────────────────
app.get('/api/projects', (req, res) => {
    res.json(listProjects());
});

app.get('/api/projects/:project/runs', (req, res) => {
    res.json(listRuns(req.params.project));
});

app.get('/api/projects/:project/runs/:run/config', (req, res) => {
    const actualRunFolder = path.join(process.cwd(), 'projects', req.params.project, req.params.run);
    const config = readRunConfig(actualRunFolder);
    if (!config) return res.status(404).json({ error: 'Run config not found.' });
    res.json(config);
});

// ─── API: Stop Job ────────────────────────────────────────────────────────
app.post('/api/stop', (req, res) => {
    if (!agentRunning) return res.status(409).json({ error: 'No job running.' });
    agentControl.stopRequested = true;
    if (agentControl.resumeCallback) agentControl.resumeCallback(); // unblock pause so stop check runs
    io.emit('job-stopping');
    res.json({ status: 'stop requested' });
});

// ─── API: Pause Job ───────────────────────────────────────────────────────
app.post('/api/pause', (req, res) => {
    if (!agentRunning) return res.status(409).json({ error: 'No job running.' });
    agentControl.paused = true;
    io.emit('job-paused');
    res.json({ status: 'paused' });
});

// ─── API: Resume Job ──────────────────────────────────────────────────────
app.post('/api/resume', (req, res) => {
    if (!agentRunning) return res.status(409).json({ error: 'No job running.' });
    agentControl.paused = false;
    if (agentControl.resumeCallback) {
        agentControl.resumeCallback();
        agentControl.resumeCallback = null;
    }
    io.emit('job-resumed');
    res.json({ status: 'resumed' });
});

// ─── API: Model Selection ──────────────────────────────────────────────────
app.get('/api/model', (req, res) => {
    res.json({ 
        activeModel: getActiveModel(),
        options: MODELS
    });
});

app.post('/api/model', (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: 'Model name is required.' });
    
    setActiveModel(model);
    
    res.json({ status: 'success', activeModel: model });
});

// ─── API: Debug Files ─────────────────────────────────────────────────────
app.get('/api/debug-files', (req, res) => {
    const { projectName, dataDir, appName } = req.query;
    if (!projectName || !dataDir || !appName) return res.json([]);

    const runFolder = getRunFolder(projectName, dataDir, appName);
    if (!fs.existsSync(runFolder)) return res.json([]);

    const files = fs.readdirSync(runFolder)
        .filter(f => f.startsWith('.debug_') || f === 'final_script.qvs' || f === 'audit_log.json');
    res.json(files);
});

app.get('/api/debug-files/:name', (req, res) => {
    const { projectName, dataDir, appName } = req.query;
    const fileName = req.params.name;
    
    if (!projectName || !dataDir || !appName) return res.status(400).json({ error: 'Target context missing' });

    const runFolder = getRunFolder(projectName, dataDir, appName);
    const fullPath = path.join(runFolder, fileName);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

    try {
        const content = fs.readFileSync(fullPath, 'utf8');
        res.send(content);
    } catch (e) {
        res.status(500).json({ error: 'Read error' });
    }
});

// ─── WebSocket Connection ─────────────────────────────────────────────────
io.on('connection', (socket) => {
    logger.info('Server', `UI client connected: ${socket.id}`);
    socket.emit('agent-log', {
        agent: 'Server', message: 'Connected to Qlik Agent Factory', type: 'info',
        timestamp: new Date().toISOString()
    });
});

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    logger.info('Server', `Agent Factory backend running on http://localhost:${PORT}`);
    logger.info('Server', 'Waiting for UI connections...');
});

module.exports = { io, broadcastAgentState };
