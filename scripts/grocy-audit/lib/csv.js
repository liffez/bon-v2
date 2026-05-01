// Simpel CSV-skriver. Skriver Excel-kompatibel CSV med UTF-8 BOM.
// Quotes felter der indeholder komma, citationstegn eller newline.

const fs = require('fs');

function escape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes(';')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function writeCsv(filePath, columns, rows) {
    const header = columns.join(',');
    const body = rows.map(r => columns.map(c => escape(r[c])).join(',')).join('\n');
    // UTF-8 BOM så Numbers og Excel læser æøå korrekt
    const content = '﻿' + header + '\n' + body + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
}

function readCsv(filePath) {
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    if (!lines.length) return [];

    // Auto-detect separator. Numbers på dansk system bruger ';'.
    const sample = lines.slice(0, 5).join('\n');
    const semi = (sample.match(/;/g) || []).length;
    const comma = (sample.match(/,/g) || []).length;
    const SEP = semi > comma ? ';' : ',';

    // Numbers eksporterer ofte en "titel-række" som første linje (filnavn,
    // evt. fyldt med tomme celler/semikoloner). Vi forventer at headeren
    // starter med 'decision'. Hvis linje 1 ikke gør det, skip den.
    while (lines.length && !/^"?decision"?[,;]/i.test(lines[0])) {
        lines = lines.slice(1);
    }
    if (!lines.length) return [];

    const parseLine = (line) => {
        const out = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQ) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (c === '"') { inQ = false; }
                else { cur += c; }
            } else {
                if (c === '"') { inQ = true; }
                else if (c === SEP) { out.push(cur); cur = ''; }
                else { cur += c; }
            }
        }
        out.push(cur);
        return out;
    };

    const header = parseLine(lines[0]);
    return lines.slice(1).map(line => {
        const vals = parseLine(line);
        return Object.fromEntries(header.map((h, i) => [h, vals[i] ?? '']));
    });
}

module.exports = { writeCsv, readCsv };
