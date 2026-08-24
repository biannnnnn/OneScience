import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extractDocument } from '../../server/lib/extractor.mjs';
import {
  DATASET_SCHEMA_VERSION,
  DEFAULT_ALLOWED_ARTICLE_LICENSES,
  cleanText,
  contentValue,
  isAllowedArticleLicense,
  normalizeTitle,
  parseArgs,
  parseNumericLabel,
  readJsonl,
  redactText,
  requireArg,
  sha256,
  toStringList,
  writeJson,
  writeJsonl,
} from './lib.mjs';

const REVIEW_TEXT_FIELDS = ['review', 'main_review', 'comments', 'comment'];
const SUMMARY_FIELDS = ['summary', 'paper_summary', 'summary_of_the_paper'];
const STRENGTH_FIELDS = ['strengths', 'strength', 'positive_aspects'];
const WEAKNESS_FIELDS = ['weaknesses', 'weakness', 'limitations', 'concerns'];
const QUESTION_FIELDS = ['questions', 'questions_for_authors', 'clarifications'];

function getIdentityTerms(submission) {
  return [
    ...toStringList(contentValue(submission, ['authors'], [])),
    ...toStringList(contentValue(submission, ['authorids'], [])),
  ].filter((value) => value && value !== 'Anonymous');
}

function normalizeReply(reply, identityTerms) {
  const note = reply.note;
  const redact = (value) => redactText(value, identityTerms);
  const summary = redact(contentValue(note, SUMMARY_FIELDS));
  const strengths = toStringList(contentValue(note, STRENGTH_FIELDS)).map(redact);
  const weaknesses = toStringList(contentValue(note, WEAKNESS_FIELDS)).map(redact);
  const questions = toStringList(contentValue(note, QUESTION_FIELDS)).map(redact);
  const mainText = redact(contentValue(note, REVIEW_TEXT_FIELDS));
  const combinedText = cleanText([summary, ...strengths, ...weaknesses, ...questions, mainText].filter(Boolean).join('\n\n'));
  return {
    review_id: note.id,
    type: reply.kind,
    summary,
    strengths,
    weaknesses,
    questions,
    main_text: mainText,
    combined_text: combinedText,
    rating: parseNumericLabel(contentValue(note, ['rating', 'recommendation', 'overall_score'])),
    rating_raw: redact(contentValue(note, ['rating', 'recommendation', 'overall_score'])),
    confidence: parseNumericLabel(contentValue(note, ['confidence', 'reviewer_confidence'])),
    confidence_raw: redact(contentValue(note, ['confidence', 'reviewer_confidence'])),
    license: 'CC BY 4.0',
    created_at_ms: note.cdate,
  };
}

function segmentText(text) {
  const blocks = cleanText(text)
    .split(/\n{2,}|(?=^\s*(?:\d+(?:\.\d+)*[.)]?\s+|abstract\b|摘要\b|references\b|参考文献\b))/gim)
    .map((value) => cleanText(value, 20_000))
    .filter(Boolean);
  let sectionIndex = 0;
  let paragraphIndex = 0;
  let currentSection = 'Document';
  return blocks.map((textValue) => {
    const firstLine = textValue.split('\n')[0].trim();
    const looksLikeHeading = firstLine.length <= 160 && (
      /^(?:\d+(?:\.\d+)*[.)]?\s+|abstract\b|introduction\b|methods?\b|experiments?\b|results?\b|discussion\b|conclusions?\b|references\b|摘要\b|引言\b|方法\b|实验\b|结果\b|讨论\b|结论\b|参考文献\b)/i.test(firstLine)
    );
    if (looksLikeHeading) {
      sectionIndex += 1;
      paragraphIndex = 0;
      currentSection = firstLine;
    } else if (sectionIndex === 0) {
      sectionIndex = 1;
    }
    paragraphIndex += 1;
    return {
      section_id: `section-${String(sectionIndex).padStart(2, '0')}`,
      section: currentSection,
      paragraph_id: `section-${String(sectionIndex).padStart(2, '0')}-p${String(paragraphIndex).padStart(3, '0')}`,
      text: textValue,
    };
  });
}

async function loadManuscriptText(bundle, rawDir, identityTerms) {
  const inline = contentValue(bundle.submission, ['paper_text', 'text', 'full_text']);
  if (inline) return redactText(inline, identityTerms);
  if (bundle.pdf?.status !== 'downloaded' || !bundle.pdf.path) return '';
  const absolutePath = path.resolve(rawDir, bundle.pdf.path);
  const buffer = await readFile(absolutePath);
  const document = await extractDocument({ originalname: path.basename(absolutePath), buffer });
  return redactText(document.text, identityTerms);
}

function normalizeDecision(reply, identityTerms) {
  if (!reply) return null;
  const note = reply.note;
  return {
    decision: redactText(contentValue(note, ['decision', 'recommendation']), identityTerms),
    comment: redactText(contentValue(note, ['comment', 'metareview', 'meta_review']), identityTerms),
  };
}

export async function cleanForumBundle(bundle, options = {}) {
  const allowlist = options.allowedArticleLicenses || DEFAULT_ALLOWED_ARTICLE_LICENSES;
  const submission = bundle.submission;
  const identityTerms = getIdentityTerms(submission);
  const title = redactText(contentValue(submission, ['title'], 'Untitled manuscript'), identityTerms);
  const abstract = redactText(contentValue(submission, ['abstract']), identityTerms);
  const manuscriptLicense = bundle.pdf?.license || submission.license || contentValue(submission, ['license', 'copyright_license']);
  const manuscriptTextAllowed = isAllowedArticleLicense(manuscriptLicense, allowlist);
  const rawText = manuscriptTextAllowed
    ? await loadManuscriptText(bundle, options.rawDir || process.cwd(), identityTerms)
    : '';
  const paragraphs = segmentText(rawText);
  const reviews = bundle.replies
    .filter((reply) => reply.kind === 'official_review')
    .map((reply) => normalizeReply(reply, identityTerms));
  const metaReviews = bundle.replies
    .filter((reply) => reply.kind === 'meta_review')
    .map((reply) => normalizeReply(reply, identityTerms));
  const authorResponses = bundle.replies
    .filter((reply) => reply.kind === 'author_response')
    .map((reply) => normalizeReply(reply, identityTerms));
  const decisionReply = bundle.replies.find((reply) => reply.kind === 'decision');
  const minReviewCharacters = Number(options.minReviewCharacters || 200);
  const substantiveReviews = reviews.filter((review) => review.combined_text.length >= minReviewCharacters);
  const qualityFlags = [];
  if (!abstract) qualityFlags.push('missing_abstract');
  if (!manuscriptLicense) qualityFlags.push('missing_article_license');
  else if (!manuscriptTextAllowed) qualityFlags.push('article_license_not_allowed');
  if (!rawText) qualityFlags.push('missing_manuscript_text');
  if (!reviews.length) qualityFlags.push('missing_official_review');
  if (reviews.length && !substantiveReviews.length) qualityFlags.push('reviews_too_short');
  if (substantiveReviews.some((review) => !review.weaknesses.length && !review.main_text)) {
    qualityFlags.push('review_missing_critique');
  }
  const normalizedTitle = normalizeTitle(title);

  return {
    dataset_schema_version: DATASET_SCHEMA_VERSION,
    source: {
      provider: 'OpenReview',
      venue_id: bundle.source.venue_id,
      year: bundle.source.year,
      forum_id: bundle.forum_id,
      submission_id: submission.id,
      fetched_at: bundle.source.fetched_at,
      terms_url: bundle.source.terms_url,
    },
    paper: {
      title,
      abstract,
      keywords: toStringList(contentValue(submission, ['keywords'])).map((item) => redactText(item, identityTerms)),
      subject_areas: toStringList(contentValue(submission, ['subject_areas', 'topics'])).map((item) => redactText(item, identityTerms)),
      manuscript_license: manuscriptLicense || null,
      manuscript_text_allowed: manuscriptTextAllowed,
      text: rawText,
      paragraphs,
    },
    reviews,
    meta_reviews: metaReviews,
    author_responses: authorResponses,
    decision: normalizeDecision(decisionReply, identityTerms),
    dedup: {
      normalized_title: normalizedTitle,
      exact_title_hash: sha256(normalizedTitle),
      manuscript_hash: rawText ? sha256(rawText) : null,
    },
    quality_flags: [...new Set(qualityFlags)],
    training_eligible: Boolean(
      manuscriptTextAllowed && rawText && abstract && substantiveReviews.length,
    ),
  };
}

export async function cleanFile(inputPath, outputPath, options = {}) {
  const bundles = await readJsonl(inputPath);
  const rawDir = path.dirname(inputPath);
  const records = [];
  for (const bundle of bundles) records.push(await cleanForumBundle(bundle, { ...options, rawDir }));
  await writeJsonl(outputPath, records);
  await writeJson(`${outputPath}.manifest.json`, {
    dataset_schema_version: DATASET_SCHEMA_VERSION,
    input: path.basename(inputPath),
    output: path.basename(outputPath),
    total_records: records.length,
    training_eligible: records.filter((record) => record.training_eligible).length,
    quality_flags: Object.fromEntries(
      [...new Set(records.flatMap((record) => record.quality_flags))]
        .sort()
        .map((flag) => [flag, records.filter((record) => record.quality_flags.includes(flag)).length]),
    ),
  });
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(requireArg(args, 'input'));
  const outputPath = path.resolve(requireArg(args, 'out'));
  const licenses = args.allowed_licenses
    ? String(args.allowed_licenses).split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ARTICLE_LICENSES;
  const records = await cleanFile(inputPath, outputPath, {
    allowedArticleLicenses: licenses,
    minReviewCharacters: Number(args.min_review_characters || 200),
  });
  console.log(`已清洗 ${records.length} 个论坛，其中 ${records.filter((item) => item.training_eligible).length} 个可进入训练切分。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const __testables = { segmentText, normalizeReply };
