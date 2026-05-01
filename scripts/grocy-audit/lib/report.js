// Markdown report writer. Reports go to ~/grocy-audit-2026-05-02/reports/
// (uden for git-repoet — prod-data hører ikke i git).

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPORTS_DIR = path.join(os.homedir(), 'grocy-audit-2026-05-02', 'reports');

function writeReport(name, sections) {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(REPORTS_DIR, `${date}_${name}.md`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const md = [
        `# ${name} — ${date}`,
        '',
        ...sections.flatMap(s => [`## ${s.title}`, '', s.body, ''])
    ].join('\n');

    fs.writeFileSync(file, md);
    console.log(`✓ Rapport: ${file}`);
    return file;
}

function formatTable(rows) {
    if (!rows || !rows.length) return '_(intet at rapportere)_';
    const cols = Object.keys(rows[0]);
    return '| ' + cols.join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n' +
        rows.map(r => '| ' + cols.map(c => {
            const v = r[c];
            if (v === null || v === undefined) return '';
            if (typeof v === 'string') return v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
            return String(v);
        }).join(' | ')).join('\n');
}

module.exports = { writeReport, formatTable, REPORTS_DIR };
