const fs = require('fs');
const qvs = fs.readFileSync('.debug_final_script.qvs', 'utf8');

const tables = qvs.split('// --- Table: ');
const fCount = {};

tables.forEach(block => {
    if (!block.trim() || block.startsWith('Centralized')) return;
    
    const lines = block.split('\n');
    const tableName = lines[0].split(' ---')[0].trim();
    
    let inLoad = false;
    lines.forEach(line => {
        if (line.trim().startsWith('LOAD')) inLoad = true;
        else if (line.trim().startsWith('FROM') || line.trim().startsWith('RESIDENT')) inLoad = false;
        else if (inLoad) {
            const match = line.match(/AS "(.*?)"|^\s*"(.*?)"/);
            if (match) {
                const f = match[1] || match[2];
                if (f && !f.startsWith('%') && f !== 'DateType') {
                    fCount[f] = fCount[f] || [];
                    fCount[f].push(tableName);
                }
            }
            const matchNoQuotes = line.match(/AS ([\w]+)|^\s*([\w]+)/);
            if (matchNoQuotes && !match) {
               const f = matchNoQuotes[1] || matchNoQuotes[2];
               if (f && !f.startsWith('%') && f !== 'DateType') {
                    fCount[f] = fCount[f] || [];
                    fCount[f].push(tableName);
                }
            }
        }
    });
});

let synKeysCount = 0;
Object.keys(fCount).forEach(f => {
    if (fCount[f].length > 1) {
        console.log('Shared field:', f, '->', fCount[f].join(', '));
        synKeysCount++;
    }
});
console.log('Total potential links:', synKeysCount);
