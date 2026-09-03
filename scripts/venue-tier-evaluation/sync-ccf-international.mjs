#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { argument, writeJson } from './io.mjs';

const CCF_BASE = 'https://www.ccf.org.cn/Academic_Evaluation';
const CATALOG_URL = `${CCF_BASE}/By_category/2026-03-31/870181.shtml`;
const categories = [
  ['ARCH_DCP_SS', '计算机体系结构/并行与分布计算/存储系统'],
  ['CN', '计算机网络'],
  ['NIS', '网络与信息安全'],
  ['TCSE_SS_PDL', '软件工程/系统软件/程序设计语言'],
  ['DM_CS', '数据库/数据挖掘/内容检索'],
  ['TCS', '计算机科学理论'],
  ['CGAndMT', '计算机图形学与多媒体'],
  ['AI', '人工智能'],
  ['HCIAndPC', '人机交互与普适计算'],
  ['Cross_Compre_Emerging', '交叉/综合/新兴'],
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(value) {
  const normalized = String(value || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function firstJournalSection(html) {
  const journalHeading = /<h4\b[^>]*>[^<]*推荐国际学术刊物[^<]*<\/h4>/i.exec(html);
  const conferenceHeading = /<h4\b[^>]*>[^<]*推荐国际学术会议[^<]*<\/h4>/i.exec(html);
  if (!journalHeading || !conferenceHeading || conferenceHeading.index <= journalHeading.index) {
    throw new Error('Could not separate journal and conference sections.');
  }
  return html.slice(journalHeading.index, conferenceHeading.index);
}

function tierBlock(section, tier) {
  const heading = new RegExp(`<h3\\b[^>]*>\\s*${tier}类\\s*</h3>`, 'i').exec(section);
  if (!heading) throw new Error(`Missing ${tier} journal heading.`);
  const start = heading.index + heading[0].length;
  const next = /<h3\b[^>]*>/i.exec(section.slice(start));
  return section.slice(start, next ? start + next.index : section.length);
}

function parseTier(section, tier, categorySlug, categoryName, pageUrl) {
  const block = tierBlock(section, tier);
  return [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => {
    const divs = [...match[1].matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((item) => decodeHtml(item[1]));
    if (divs.length < 4) return null;
    const [order, shortName, name, publisher] = divs;
    if (!/^\d+$/.test(order) || !name) return null;
    const link = /<a\b[^>]*href=["']([^"']+)["']/i.exec(match[1])?.[1] || null;
    return {
      id: `${categorySlug.toLowerCase()}-${slug(shortName || name)}`,
      name,
      englishName: name,
      shortName: shortName || null,
      publisher,
      ccfTier: `CCF-${tier}`,
      tierRank: tier === 'A' ? 1 : 3,
      category: categoryName,
      categorySlug,
      dblpUrl: link,
      source: {
        label: 'CCF 第七版推荐国际学术会议和期刊目录（正式版）',
        version: '2026-04-09',
        url: pageUrl,
      },
    };
  }).filter(Boolean);
}

const output = path.resolve(argument('output', 'data/ccf-international-2026-journals.json'));
const journals = [];
for (const [categorySlug, categoryName] of categories) {
  const pageUrl = `${CCF_BASE}/${categorySlug}/`;
  const response = await fetch(pageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CCF request failed for ${categorySlug}: HTTP ${response.status}`);
  const section = firstJournalSection(await response.text());
  const selected = [
    ...parseTier(section, 'A', categorySlug, categoryName, pageUrl),
    ...parseTier(section, 'C', categorySlug, categoryName, pageUrl),
  ];
  journals.push(...selected);
  console.log(JSON.stringify({ event: 'ccf_category_synced', category: categorySlug, journals: selected.length }));
}

const ids = journals.map((journal) => journal.id);
if (new Set(ids).size !== ids.length) throw new Error('Generated CCF journal IDs are not unique.');
await writeJson(output, {
  schema_version: '1.0.0',
  catalog: 'CCF 第七版推荐国际学术会议和期刊目录',
  version: '2026-04-09',
  official_url: CATALOG_URL,
  scope: 'international_journals_A_and_C_only',
  retrieved_at: new Date().toISOString(),
  journals: journals.sort((a, b) => a.categorySlug.localeCompare(b.categorySlug)
    || a.tierRank - b.tierRank || a.name.localeCompare(b.name)),
});
console.log(JSON.stringify({ journals: journals.length, output }, null, 2));
