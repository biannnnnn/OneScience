import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArgs,
  readJson,
  readJsonl,
  requireArg,
  sha256,
  stableUnit,
  writeJson,
  writeJsonl,
} from './lib.mjs';

function titleTokens(record) {
  return new Set(record.dedup.normalized_title.split(/\s+/).filter((token) => token.length >= 2));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function buildDuplicateGroups(records, threshold = 0.9) {
  const parent = records.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const exactTitles = new Map();
  const manuscripts = new Map();
  const tokenIndex = new Map();
  const tokensByIndex = records.map(titleTokens);
  records.forEach((record, index) => {
    const exact = record.dedup.exact_title_hash;
    if (exactTitles.has(exact)) union(index, exactTitles.get(exact));
    else exactTitles.set(exact, index);
    if (record.dedup.manuscript_hash) {
      if (manuscripts.has(record.dedup.manuscript_hash)) union(index, manuscripts.get(record.dedup.manuscript_hash));
      else manuscripts.set(record.dedup.manuscript_hash, index);
    }
    const candidates = new Set();
    for (const token of [...tokensByIndex[index]].sort().slice(0, 8)) {
      for (const candidate of tokenIndex.get(token) || []) candidates.add(candidate);
    }
    for (const candidate of candidates) {
      if (jaccard(tokensByIndex[index], tokensByIndex[candidate]) >= threshold) union(index, candidate);
    }
    for (const token of [...tokensByIndex[index]].sort().slice(0, 8)) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(index);
    }
  });

  const groups = new Map();
  records.forEach((_, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  });
  return [...groups.values()];
}

function chooseSplit(groupRecords, config) {
  const years = new Set(groupRecords.map((record) => Number(record.source.year)));
  const testYears = new Set((config.test_years || []).map(Number));
  const validationYears = new Set((config.validation_years || []).map(Number));
  if ([...years].some((year) => testYears.has(year))) return 'test';
  if ([...years].some((year) => validationYears.has(year))) return 'validation';
  if (testYears.size || validationYears.size) return 'train';

  const key = groupRecords.map((record) => record.source.forum_id).sort().join('|');
  const unit = stableUnit(key, config.seed || 'onescience-openreview-v1');
  const testRatio = Number(config.test_ratio ?? 0.1);
  const validationRatio = Number(config.validation_ratio ?? 0.1);
  if (unit < testRatio) return 'test';
  if (unit < testRatio + validationRatio) return 'validation';
  return 'train';
}

function distribution(records, keyFn) {
  const result = {};
  for (const record of records) {
    const key = String(keyFn(record));
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export function splitRecords(allRecords, config = {}) {
  const records = config.include_ineligible
    ? [...allRecords]
    : allRecords.filter((record) => record.training_eligible);
  const groups = buildDuplicateGroups(records, Number(config.near_duplicate_threshold || 0.9));
  const splitMap = new Map();
  for (const indexes of groups) {
    const groupRecords = indexes.map((index) => records[index]);
    const split = chooseSplit(groupRecords, config);
    const groupId = sha256(groupRecords.map((record) => record.dedup.exact_title_hash).sort().join('|')).slice(0, 16);
    for (const index of indexes) splitMap.set(index, { split, groupId });
  }

  const output = { train: [], validation: [], test: [] };
  records.forEach((record, index) => {
    const assignment = splitMap.get(index);
    output[assignment.split].push({
      ...record,
      split: assignment.split,
      dedup: { ...record.dedup, group_id: assignment.groupId },
    });
  });
  for (const values of Object.values(output)) {
    values.sort((left, right) => left.source.forum_id.localeCompare(right.source.forum_id));
  }
  return { output, duplicateGroups: groups };
}

export async function splitFiles(inputPaths, outputDir, config = {}) {
  const nested = await Promise.all(inputPaths.map(readJsonl));
  const allRecords = nested.flat();
  const { output, duplicateGroups } = splitRecords(allRecords, config);
  await Promise.all([
    writeJsonl(path.join(outputDir, 'train.jsonl'), output.train),
    writeJsonl(path.join(outputDir, 'validation.jsonl'), output.validation),
    writeJsonl(path.join(outputDir, 'test.jsonl'), output.test),
  ]);
  const manifest = {
    generated_at: new Date().toISOString(),
    strategy: config.test_years?.length || config.validation_years?.length ? 'temporal' : 'deterministic_hash',
    seed: config.seed || 'onescience-openreview-v1',
    test_years: config.test_years || [],
    validation_years: config.validation_years || [],
    source_records: allRecords.length,
    excluded_ineligible: config.include_ineligible ? 0 : allRecords.filter((record) => !record.training_eligible).length,
    duplicate_groups: duplicateGroups.length,
    counts: Object.fromEntries(Object.entries(output).map(([key, values]) => [key, values.length])),
    years: Object.fromEntries(Object.entries(output).map(([key, values]) => [key, distribution(values, (record) => record.source.year)])),
    venues: Object.fromEntries(Object.entries(output).map(([key, values]) => [key, distribution(values, (record) => record.source.venue_id)])),
  };
  await writeJson(path.join(outputDir, 'manifest.json'), manifest);
  return { output, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPaths = requireArg(args, 'input').split(',').map((value) => path.resolve(value.trim()));
  const outputDir = path.resolve(requireArg(args, 'out'));
  const config = args.config ? await readJson(path.resolve(String(args.config))) : {};
  if (args.include_ineligible) config.include_ineligible = true;
  const result = await splitFiles(inputPaths, outputDir, config);
  console.log(`切分完成：train=${result.output.train.length}, validation=${result.output.validation.length}, test=${result.output.test.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const __testables = { buildDuplicateGroups, jaccard, chooseSplit };
