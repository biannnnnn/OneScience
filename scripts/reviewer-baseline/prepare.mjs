import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArgs,
  readJsonl,
  requireArg,
  writeJsonl,
} from '../openreview/lib.mjs';

function languageOf(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk / Math.max(value.length, 1) > 0.1 ? 'zh-CN' : 'en';
}

export function makeEvaluationCase(record, split = 'test') {
  return {
    case_schema_version: '1.0.0',
    case_id: `openreview-${record.source.forum_id}`,
    source: {
      kind: 'openreview',
      dataset: `openreview-${record.dataset_schema_version}`,
      split,
      forum_id: record.source.forum_id,
      venue_id: record.source.venue_id,
      year: record.source.year,
    },
    manuscript: {
      title: record.paper.title,
      language: languageOf(`${record.paper.title}\n${record.paper.abstract}`),
      paragraphs: record.paper.paragraphs.map((paragraph) => ({
        section: paragraph.section,
        paragraph_id: paragraph.paragraph_id,
        text: paragraph.text,
      })),
    },
    gold: null,
    human_references: record.reviews.map((review) => ({
      review_id: review.review_id,
      text: review.combined_text,
      rating: review.rating,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = await readJsonl(path.resolve(requireArg(args, 'input')));
  const split = String(args.split || 'test');
  const limit = Number(args.limit || 0);
  const eligible = records.filter((record) => record.training_eligible && record.paper?.paragraphs?.length);
  const selected = limit ? eligible.slice(0, limit) : eligible;
  await writeJsonl(
    path.resolve(requireArg(args, 'out')),
    selected.map((record) => makeEvaluationCase(record, split)),
  );
  console.log(`已生成 ${selected.length} 个评测样本；gold=null，需后续证据标注或人工盲评。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
