const fs = require('fs');
const path = require('path');
const { runAgent } = require('./agent_runner');
const logger = require('./.agent/utils/logger.js');

const args = process.argv.slice(2);
const jobArg = args.find(a => a.startsWith('--job='));
const dataDirArg = args.find(a => a.startsWith('--data='));
const appNameArg = args.find(a => a.startsWith('--app='));
const skipArchitectArg = args.find(a => a === '--skip-architect');
const layoutOnlyArg = args.find(a => a === '--layout-only');

let dataDir = './data';
let targetAppName = "Architect_Agent_Output";
let pipeline = ['architect', 'enhancer', 'layout'];

// Handle Job Configuration
if (jobArg) {
    const jobPath = jobArg.split('=')[1];
    if (fs.existsSync(jobPath)) {
        const jobConfig = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
        if (jobConfig.data && jobConfig.data.sourcePath) dataDir = jobConfig.data.sourcePath;
        if (jobConfig.output && jobConfig.output.appName) targetAppName = jobConfig.output.appName;
        if (jobConfig.pipeline) pipeline = jobConfig.pipeline;
    } else {
        console.error(`Error: Job config file ${jobPath} not found.`);
        process.exit(1);
    }
} else {
    // Handle Individual Args
    if (dataDirArg) dataDir = dataDirArg.split('=')[1];
    if (appNameArg) targetAppName = appNameArg.split('=')[1];
}

// Pipeline Adjustments
if (skipArchitectArg) {
    pipeline = pipeline.filter(p => p !== 'architect');
}
if (layoutOnlyArg) {
    pipeline = ['layout'];
}

async function main() {
    console.log("=== Qlik Agent Factory CLI ===");

    try {
        await runAgent({
            dataDir: path.resolve(dataDir),
            appName: targetAppName,
            pipeline: pipeline,
            // CLI mode: simple console logger for broadcasting
            broadcastAgentState: (agent, msg, type) => {
                const colors = {
                    phase: '\x1b[35m',  // Magenta
                    success: '\x1b[32m', // Green
                    error: '\x1b[31m',   // Red
                    warning: '\x1b[33m', // Yellow
                    info: '\x1b[36m',    // Cyan
                    system: '\x1b[34m',  // Blue
                    reasoning: '\x1b[90m' // Gray
                };
                const color = colors[type] || '';
                const reset = '\x1b[0m';
                console.log(`${color}[${agent}]${reset} ${msg}`);
            }
        });
    } catch (err) {
        console.error("\nFATAL CLI ERROR:", err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
