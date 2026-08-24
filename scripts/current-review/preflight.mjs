#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { getRankerServiceStatus } from '../../server/lib/ranker-client.mjs';
import { discoverJournalSources, getOpenAlexStatus, resolveJournalSource } from '../../server/lib/scholarly-search.mjs';
import { journals } from '../../server/data/journals.mjs';

const projectRoot = new URL('../../', import.meta.url);
const policy = JSON.parse(await readFile(new URL('config/current-review-flow.json', projectRoot), 'utf8'));

function check(label, ok, detail) {
  const marker = ok ? 'PASS' : 'FAIL';
  console.log(`${marker} ${label}: ${detail}`);
  return ok;
}

const ranker = await getRankerServiceStatus({ timeoutMs: 5_000 });
let rankerReady = check(
  'Ranker Service 连接与鉴权',
  ranker.available,
  ranker.available ? '服务在线且鉴权成功' : ranker.error,
);

if (ranker.backend) {
  const expected = policy.ranker;
  rankerReady = check(
    'Ranker 模型',
    ranker.backend.model === expected.expected_model,
    `${ranker.backend.model || 'unknown'}（期望 ${expected.expected_model}）`,
  ) && rankerReady;
  rankerReady = check(
    'Ranker adapter',
    ranker.backend.adapter_version === expected.expected_adapter_version,
    `${ranker.backend.adapter_version || 'none'}（期望 ${expected.expected_adapter_version}）`,
  ) && rankerReady;
  rankerReady = check(
    'Ranker prompt',
    ranker.backend.prompt_version === expected.expected_prompt_version,
    `${ranker.backend.prompt_version || 'unknown'}（期望 ${expected.expected_prompt_version}）`,
  ) && rankerReady;
  rankerReady = check(
    'Ranker backend',
    !expected.disallowed_backends.includes(ranker.backend.backend),
    ranker.backend.backend || 'unknown',
  ) && rankerReady;
  const missingCapabilities = (expected.required_capabilities || [])
    .filter((capability) => !ranker.capabilities?.includes(capability));
  rankerReady = check(
    'Ranker 当前流程能力',
    missingCapabilities.length === 0,
    missingCapabilities.length
      ? `缺少 ${missingCapabilities.join(', ')}；需部署新版 Ranker Service`
      : expected.required_capabilities.join(', '),
  ) && rankerReady;
}

const openAlex = getOpenAlexStatus();
let openAlexReady = check(
  'OpenAlex API key',
  openAlex.configured,
  openAlex.configured ? '已配置' : '缺少 OPENALEX_API_KEY',
);
if (openAlex.configured) {
  try {
    const journal = journals.find((item) => item.id === 'ieee-access');
    const source = await resolveJournalSource(journal, { timeoutMs: 10_000 });
    openAlexReady = check(
      'OpenAlex Source 解析',
      Boolean(source?.id),
      source ? `${source.name} (${source.id})` : '未解析到 IEEE Access',
    ) && openAlexReady;
  } catch (error) {
    openAlexReady = check('OpenAlex Source 解析', false, error.message) && openAlexReady;
  }
  try {
    const discovery = await discoverJournalSources(['machine learning'], { limit: 1, minWorksCount: 500, timeoutMs: 10_000 });
    openAlexReady = check(
      'OpenAlex 期刊 Web 检索',
      discovery.sources.length > 0,
      discovery.sources.length
        ? `${discovery.sources[0].name} (${discovery.sources[0].id})`
        : '未检索到候选期刊',
    ) && openAlexReady;
  } catch (error) {
    openAlexReady = check('OpenAlex 期刊 Web 检索', false, error.message) && openAlexReady;
  }
}

console.log(`\nRanker=${rankerReady ? 'ready' : 'blocked'} OpenAlex=${openAlexReady ? 'ready' : 'blocked'}`);
process.exitCode = rankerReady && openAlexReady ? 0 : 1;
