#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ccfT1T2Journals } from '../../server/data/ccf-journals.mjs';
import { findRecentSimilarPapers, resolveJournalSource } from '../../server/lib/scholarly-search.mjs';
import { argument, writeJson, writeJsonl } from './io.mjs';

const configPath = path.resolve(argument('config', 'config/venue-tier-pilot.json'));
const outputDir = path.resolve(argument('output-dir', 'evaluation/venue-tier/runs/pilot'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const externalCatalog = config.catalog_file
  ? JSON.parse(await readFile(path.resolve(config.catalog_file), 'utf8'))
  : null;
const catalogJournals = externalCatalog?.journals || ccfT1T2Journals;
const catalogById = new Map(catalogJournals.map((journal) => [journal.id, journal]));
const catalogMetadata = config.catalog || (externalCatalog ? {
  label: externalCatalog.catalog,
  version: externalCatalog.version,
  url: externalCatalog.official_url,
} : {
  label: 'CCF 2025 计算领域高质量科技期刊分级目录',
  version: '2025',
  url: 'https://www.ccf.org.cn/ccftjgjxskwml/',
});
const papers = [];
const retrieval = [];
const sourceCache = new Map();

for (const selection of config.venues || []) {
  const journal = catalogById.get(selection.catalog_id);
  if (!journal) throw new Error(`Unknown catalog_id: ${selection.catalog_id}`);
  if (!sourceCache.has(journal.id)) sourceCache.set(journal.id, await resolveJournalSource(journal));
  const source = sourceCache.get(journal.id);
  if (!source) {
    retrieval.push({ catalog_id: journal.id, status: 'source_not_resolved' });
    continue;
  }
  const result = await findRecentSimilarPapers(journal, selection.queries || [], {
    source,
    limit: selection.limit || config.papers_per_venue || 10,
    recentYears: config.recent_years || 3,
    queries: selection.queries || [],
    includeJournalFields: false,
    excludeCitationRanking: true,
  });
  const usable = result.items.filter((item) => (
    item.title?.trim()
    && item.abstract?.trim().length >= 100
    && !/\b(survey|review|overview|bibliometric)\b|综述/iu.test(item.title)
  ));
  for (const item of usable) {
    papers.push({
      paper_id: item.id,
      title: item.title,
      abstract: item.abstract,
      venue: source.name,
      venue_tier: journal.ccfTier,
      tier_rank: Number(selection.tier_rank ?? journal.tierRank),
      field: selection.field,
      topic: selection.topic,
      article_type: selection.article_type || 'research article',
      year: item.year,
      source_id: source.id,
    });
  }
  retrieval.push({
    catalog_id: journal.id,
    catalog_name: journal.englishName || journal.name,
    catalog_tier: journal.ccfTier,
    catalog_source: journal.source,
    openalex_source: source,
    requested: selection.limit || config.papers_per_venue || 10,
    retrieved: result.items.length,
    usable_with_abstract: usable.length,
    queries: result.queries,
    errors: result.errors,
  });
  console.log(JSON.stringify({ event: 'venue_collected', venue: journal.id, usable: usable.length }));
}

const uniquePapers = [...new Map(papers.map((paper) => [paper.paper_id, paper])).values()]
  .sort((a, b) => a.paper_id.localeCompare(b.paper_id));
await Promise.all([
  writeJsonl(path.join(outputDir, 'papers.source.private.jsonl'), uniquePapers),
  writeJson(path.join(outputDir, 'retrieval-manifest.private.json'), {
    schema_version: '1.0.0',
    provider: 'OpenAlex',
    catalog: catalogMetadata.label,
    catalog_version: catalogMetadata.version,
    catalog_url: catalogMetadata.url,
    selection_policy: {
      requires_title_and_abstract: true,
      minimum_abstract_characters: 100,
      excludes_review_titles: true,
      excludes_citation_ranking: true,
    },
    config: path.relative(process.cwd(), configPath),
    papers: uniquePapers.length,
    venues: retrieval,
  }),
]);
console.log(JSON.stringify({ papers: uniquePapers.length, venues: retrieval.length, output_dir: outputDir }, null, 2));
