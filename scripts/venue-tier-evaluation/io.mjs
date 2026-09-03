import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${filePath}:${index + 1}: ${error.message}`); }
  });
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeJsonl(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((item) => item.some((value) => value !== ''));
  if (!header) return [];
  return body.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])));
}

export async function readAnnotations(filePath) {
  if (!filePath) return [];
  if (filePath.endsWith('.jsonl')) return readJsonl(filePath);
  return parseCsv(await readFile(filePath, 'utf8'));
}

export function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

