const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

let agentRunning = false;
const agentControl = { stopRequested: false, paused: false, resumeCallback: null };

function resetControl() {
    agentControl.stopRequested = false;
    agentControl.paused = false;
    agentControl.resumeCallback = null;
}

// ─── Broadcast Helper ────────────────────────────────────────────────────────
// Always logs to terminal AND emits to all connected UI clients.
function broadcastAgentState(agent, message, type = 'info', data = null) {
    const entry = { agent, message, type, data, timestamp: new Date().toISOString() };
    console.log(`[${agent}] ${message}`);
    io.emit('agent-log', entry);
}

// ─── API: Run Job ──────────────────────────────────────────────────────────
app.post('/api/run', async (req, res) => {
    if (agentRunning) {
        return res.status(409).json({ error: 'Agent is already running.' });
    }
    const { dataDir, appName, pipeline = ['architect', 'enhancer'] } = req.body;
    if (!dataDir || !appName) {
        return res.status(400).json({ error: 'dataDir and appName are required.' });
    }

    res.json({ status: 'started' });
    agentRunning = true;
    resetControl();
    io.emit('job-started', { dataDir, appName, pipeline });

    try {
        // Cache-bust agent modules so edits are picked up without server restart
        Object.keys(require.cache).forEach(key => {
            if (key.includes('agent_runner') || key.includes('brain') || key.includes('deterministic_modeler') || key.includes('architect_generator')) {
                delete require.cache[key];
            }
        });

        const { runAgent } = require('./agent_runner');
        await runAgent({ dataDir, appName, pipeline, io, broadcastAgentState, agentControl });
    } catch (err) {
        // agent_runner already broadcasts the error — no double-emit needed
    } finally {
        agentRunning = false;
        agentControl.paused = false;
        io.emit('job-complete');
    }
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


// ─── WebSocket Connection ─────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[Server] UI client connected: ${socket.id}`);
    socket.emit('agent-log', {
        agent: 'Server', message: 'Connected to Qlik Agent Factory', type: 'info',
        timestamp: new Date().toISOString()
    });
});

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`\n[Server] Agent Factory backend running on http://localhost:${PORT}`);
    console.log('[Server] Waiting for UI connections...\n');
});

module.exports = { io, broadcastAgentState };
