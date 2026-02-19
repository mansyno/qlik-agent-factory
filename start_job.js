const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function askQuestion(rl, query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
    console.log("=== Qlik Architect Agent Job Wizard ===\n");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // 1. Source Path
    let sourcePath = await askQuestion(rl, 'Where is your data located? (default: ./data): ');
    if (!sourcePath.trim()) sourcePath = './data';

    // 2. App Name
    let appName = await askQuestion(rl, 'What should the Qlik App be named? (default: Agent_Generated_App): ');
    if (!appName.trim()) appName = 'Agent_Generated_App';

    // 3. Mode (Fixed for now)
    console.log('Action: Create New App (Default)\n');
    const mode = 'create_new';

    rl.close();

    const jobId = 'job_' + Date.now();
    const jobConfig = {
        jobId: jobId,
        data: {
            sourcePath: sourcePath,
            type: 'csv'
        },
        output: {
            appName: appName,
            mode: mode
        }
    };

    // Ensure jobs dir exists
    const jobsDir = path.join(__dirname, 'jobs');
    if (!fs.existsSync(jobsDir)) {
        fs.mkdirSync(jobsDir);
    }

    const jobFilePath = path.join(jobsDir, `${jobId}.json`);
    fs.writeFileSync(jobFilePath, JSON.stringify(jobConfig, null, 2));

    console.log(`Job Configuration saved to: ${jobFilePath}`);
    console.log("Starting Architect Agent...\n");

    // Execute the agent with the job config
    const child = exec(`node index.js --job="${jobFilePath}"`);

    // Stream output to console
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));

    child.on('close', (code) => {
        console.log(`\nAgent finished with exit code ${code}`);
    });
}

main();
