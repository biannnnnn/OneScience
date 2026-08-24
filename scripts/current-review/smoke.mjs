#!/usr/bin/env node
import 'dotenv/config';
import { journals } from '../../server/data/journals.mjs';
import { findRecentSimilarPapers } from '../../server/lib/scholarly-search.mjs';
import {
  getRankerServiceStatus,
  scoreFromRanker,
  scorePapersWithRanker,
} from '../../server/lib/ranker-client.mjs';

const journal = journals.find((item) => item.id === 'ieee-access');
const keywords = ['scientific peer review', 'large language model', 'journal recommendation'];
const service = await getRankerServiceStatus({ timeoutMs: 5_000 });
if (!service.available) throw new Error(service.error || 'Ranker Service 不可用。');
if (!service.capabilities?.includes('paper_score_batch')) {
  throw new Error('Ranker Service 尚未部署 paper_score_batch；请先升级并重启远程服务。');
}

console.log(JSON.stringify({
  event: 'ranker_ready',
  model: service.backend?.model,
  adapter_version: service.backend?.adapter_version,
  prompt_version: service.backend?.prompt_version,
}, null, 2));

const retrieval = await findRecentSimilarPapers(journal, keywords, {
  limit: 1,
  recentYears: 3,
  timeoutMs: 15_000,
});
if (!retrieval.source || retrieval.items.length === 0) {
  throw new Error('OpenAlex 没有返回可用于烟雾测试的近期论文。');
}
const reference = retrieval.items[0];
console.log(JSON.stringify({
  event: 'openalex_reference_found',
  source: retrieval.source.name,
  source_id: retrieval.source.id,
  paper: {
    id: reference.id,
    title: reference.title,
    publication_date: reference.publicationDate,
    doi: reference.doi,
    abstract_available: Boolean(reference.abstract),
  },
}, null, 2));

const manuscript = {
  title: 'A Retrieval-Grounded Framework for Venue-Conditioned Manuscript Assessment',
  language: 'en',
  abstract: 'This paper presents a retrieval-grounded framework for pre-submission manuscript assessment. The system resolves candidate journals, retrieves recent topically related articles, and applies a frozen venue-conditioned reviewer to both reference articles and a target manuscript. We evaluate retrieval precision, score stability, and calibration on a temporally separated benchmark. Results show that venue-specific comparison reduces unsupported general-purpose recommendations, while limitations remain for venues with sparse public abstracts.',
  text: `Abstract\n\nThis paper presents a retrieval-grounded framework for pre-submission manuscript assessment. The system resolves candidate journals, retrieves recent topically related articles, and applies a frozen venue-conditioned reviewer to both reference articles and a target manuscript. We evaluate retrieval precision, score stability, and calibration on a temporally separated benchmark. Results show that venue-specific comparison reduces unsupported general-purpose recommendations, while limitations remain for venues with sparse public abstracts.\n\nMethods\n\nThe retrieval component first resolves each journal to a stable source identifier. It then filters articles by source and publication date. A frozen reviewer model receives the manuscript, the journal scope, and evidence requirements. All evaluation splits are separated by publication year. Author identity, institution, reviewer text, rebuttal, and final decision text are excluded from model inputs.\n\nResults\n\nOn a held-out set, source resolution succeeded for 96 percent of journals and retrieved relevant abstracts for 81 percent of cases. The venue-conditioned reviewer produced schema-valid output for 92 percent of complete manuscripts. Probability calibration remains disabled because the multi-venue temporal test has not yet reached the required sample size.\n\nConclusion\n\nThe framework provides an auditable baseline comparison without presenting uncalibrated scores as acceptance probabilities.`,
};
if (!reference.abstract) throw new Error('检索结果缺少摘要，不能验证 Ranker 评分。');
let batchResult;
try {
  batchResult = await scorePapersWithRanker([
    {
      paperId: 'current-review-smoke-manuscript',
      title: manuscript.title,
      abstract: manuscript.abstract,
    },
    {
      paperId: reference.id,
      title: reference.title,
      abstract: reference.abstract,
    },
  ], { timeoutMs: 180_000 });
} catch (error) {
  console.error(JSON.stringify({
    event: 'batch_scoring_failed',
    code: error.code || null,
    message: error.message,
    details: error.details || [],
  }, null, 2));
  throw error;
}
const scoreById = new Map(batchResult.scores.map((item) => [item.paper_id, item]));
const referenceScore = scoreFromRanker(scoreById.get(reference.id), batchResult.modelTrace);
const manuscriptScore = scoreFromRanker(
  scoreById.get('current-review-smoke-manuscript'),
  batchResult.modelTrace,
);
console.log(JSON.stringify({
  event: 'reference_scored',
  score: referenceScore.score,
  confidence: referenceScore.confidence,
  limitations: referenceScore.limitations,
  model_trace: referenceScore.modelTrace,
}, null, 2));
console.log(JSON.stringify({
  event: 'manuscript_scored',
  score: manuscriptScore.score,
  confidence: manuscriptScore.confidence,
  strengths: manuscriptScore.strengths,
  risks: manuscriptScore.risks,
  model_trace: manuscriptScore.modelTrace,
}, null, 2));

console.log(JSON.stringify({
  event: 'smoke_complete',
  journal: journal.name,
  reference_score: referenceScore.score,
  manuscript_score: manuscriptScore.score,
  score_delta: manuscriptScore.score - referenceScore.score,
  acceptance_probability_displayed: false,
}, null, 2));
