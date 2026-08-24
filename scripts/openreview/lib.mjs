import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DATASET_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_ALLOWED_ARTICLE_LICENSES = ['CC BY 4.0', 'CC0 1.0'];

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replaceAll('-', '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

export function requireArg(args, key) {
  if (!args[key] || args[key] === true) throw new Error(`缺少参数 --${key.replaceAll('_', '-')}`);
  return String(args[key]);
}

export function unwrap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

export function contentValue(note, names, fallback = '') {
  for (const name of names) {
    const value = unwrap(note?.content?.[name]);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

export function cleanText(value, maxLength = 200_000) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item, maxLength)).filter(Boolean).join('\n');
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export function toStringList(value, maxItems = 100) {
  const items = Array.isArray(value)
    ? value
    : cleanText(value).split(/\n|;|；|,(?=\s*[A-Za-z])/);
  return items.map((item) => cleanText(item, 2_000)).filter(Boolean).slice(0, maxItems);
}

export function normalizeLicense(value) {
  return cleanText(value, 200)
    .toUpperCase()
    .replace(/CREATIVE COMMONS/g, 'CC')
    .replace(/ATTRIBUTION/g, 'BY')
    .replace(/INTERNATIONAL/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAllowedArticleLicense(value, allowlist = DEFAULT_ALLOWED_ARTICLE_LICENSES) {
  const normalized = normalizeLicense(value);
  return allowlist.some((item) => normalizeLicense(item) === normalized);
}

export function isPublicNote(note) {
  return Array.isArray(note?.readers) && note.readers.includes('everyone');
}

export function invitationKind(note) {
  const invitations = [note?.invitation, ...(note?.invitations || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replaceAll('-', '_'));
  const joined = invitations.join(' ');
  if (/(^|\/)official_review$|(^|\/)review$/.test(joined)) return 'official_review';
  if (/meta_review|metareview/.test(joined)) return 'meta_review';
  if (/decision/.test(joined)) return 'decision';
  if (/rebuttal|author_response|author_rebuttal/.test(joined)) return 'author_response';
  if (/official_comment|comment/.test(joined)) return 'comment';
  return 'other';
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeTitle(value) {
  return cleanText(value, 2_000)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(a|an|the|of|for|with|and|in|on|to|via)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactText(value, identityTerms = []) {
  let result = cleanText(value);
  result = result
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/openreview\.net\/profile\?id=~?[\w.-]+/gi, '[REDACTED_PROFILE]')
    .replace(/~[A-Z][A-Za-z.'-]*_[A-Z][A-Za-z.'_-]*\d+/g, '[REDACTED_PROFILE]')
    .replace(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi, '[REDACTED_ORCID]');

  for (const term of identityTerms) {
    const cleaned = cleanText(term, 200);
    if (cleaned.length < 4) continue;
    const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '[REDACTED_AUTHOR]');
  }
  return result;
}

export function parseNumericLabel(value) {
  const match = cleanText(value, 500).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是有效 JSON：${error.message}`);
    }
  });
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeJsonl(filePath, values) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = values.map((value) => JSON.stringify(value)).join('\n');
  await writeFile(filePath, body ? `${body}\n` : '', 'utf8');
}

export function slugify(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

export function yearFromVenue(venueId, fallback = null) {
  const match = String(venueId).match(/\/(20\d{2})(?:\/|$)/);
  return match ? Number(match[1]) : fallback;
}

export function stableUnit(value, seed = 'onescience-openreview-v1') {
  const hex = sha256(`${seed}\0${value}`).slice(0, 13);
  return Number.parseInt(hex, 16) / 0x1fffffffffffff;
}
