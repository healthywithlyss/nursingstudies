#!/usr/bin/env node
// seed-nur118-cards.js — inserts 310 NUR118 flashcards with explanations
// Uses native fetch (Node 22+). No npm required.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load .env ────────────────────────────────────────────────────────────────
const envPath = resolve(__dirname, '../.env');
const envText = readFileSync(envPath, 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
);
console.log('Loaded env from', envPath);

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY;

const SB_HEADERS = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

async function sbInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`INSERT failed (${res.status}): ${text}`);
  }
}

async function sbCount(table, eq) {
  const [col, val] = Object.entries(eq)[0];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}&select=id`,
    { headers: { ...SB_HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
  );
  return parseInt(res.headers.get('content-range')?.split('/')[1] ?? '0', 10);
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────
// Single-pass RFC-4180-compliant parser. Handles quoted fields with embedded
// commas and newlines correctly.
function parseCSV(text) {
  const records = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const fields = [];

    // Parse one record (terminated by unquoted \n or EOF)
    recordLoop: while (i < len) {
      let field = '';

      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              field += '"'; i += 2; // escaped quote
            } else {
              i++; break; // closing quote
            }
          } else {
            field += text[i++];
          }
        }
      } else {
        // Unquoted field — read until comma or newline
        while (i < len && text[i] !== ',' && text[i] !== '\n') {
          field += text[i++];
        }
      }

      fields.push(field);

      if (i < len && text[i] === ',') {
        i++; // comma → more fields in this record
      } else {
        break recordLoop; // newline or EOF → end of record
      }
    }

    // Consume the newline that ended the record
    if (i < len && text[i] === '\n') i++;

    if (fields.length > 0 && fields.some(f => f.trim())) {
      records.push(fields);
    }
  }

  return records;
}

const csvPath = 'C:/Users/Alyssa/Downloads/nur118_cards (1).csv';
const rawCSV  = readFileSync(csvPath, 'utf8').replace(/\r/g, '');
const rows    = parseCSV(rawCSV);

// header: question,answer,objective_ids,course,explanation
const [, ...dataRows] = rows;
console.log('Total data rows:', dataRows.length);

// ─── Build records ────────────────────────────────────────────────────────────
const records = dataRows
  .filter(r => r.length >= 4 && r[0].trim())
  .map(r => {
    const [question, answer, objective_ids_raw, course, explanation] = r;
    const inner = objective_ids_raw.replace(/[{}]/g, '').trim();
    const objective_ids = inner ? inner.split(',').map(s => s.trim()) : [];
    return {
      question:      question.trim(),
      answer:        answer.trim(),
      objective_ids,
      course:        (course || 'NUR118').trim(),
      explanation:   (explanation && explanation.trim()) ? explanation.trim() : null,
    };
  });

console.log(`Parsed ${records.length} cards. Inserting in batches…\n`);

// ─── Insert in batches of 50 ──────────────────────────────────────────────────
const BATCH = 50;
let inserted = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const batch = records.slice(i, i + BATCH);
  await sbInsert('flashcards', batch);
  inserted += batch.length;
  process.stdout.write(`\r  Inserted ${inserted}/${records.length}…`);
}
console.log('\n');

// ─── Verify ───────────────────────────────────────────────────────────────────
const count = await sbCount('flashcards', { course: 'NUR118' });
console.log(`✅ Done! NUR118 flashcards in DB: ${count}`);
if (count !== records.length) {
  console.warn(`⚠️  Expected ${records.length}, got ${count}`);
}
