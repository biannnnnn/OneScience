import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectVenue } from '../scripts/openreview/collect.mjs';
import { cleanForumBundle } from '../scripts/openreview/clean.mjs';
import { splitRecords } from '../scripts/openreview/split.mjs';
import { invitationKind, isAllowedArticleLicense, redactText } from '../scripts/openreview/lib.mjs';

const field = (value) => ({ value });

function officialReview(id, text, readers = ['everyone']) {
  return {
    id,
    forum: 'forum-1',
    replyto: 'paper-1',
    invitations: [`Venue/Submission1/-/Official_Review`],
    readers,
    cdate: 1700000000000,
    content: {
      summary: field('The paper presents a submission assistant.'),
      strengths: field(['The workflow is clearly decomposed.']),
      weaknesses: field([text]),
      questions: field(['How were the evaluation examples selected?']),
      rating: field('6: weak accept'),
      confidence: field('4: high'),
    },
  };
}

function rawBundle(overrides = {}) {
  return {
    raw_schema_version: '1.0.0',
    source: {
      provider: 'OpenReview',
      api_version: 2,
      api_base_url: 'https://api2.openreview.net',
      terms_url: 'https://openreview.net/legal/terms',
      venue_id: 'Venue/2024/Conference',
      year: 2024,
      fetched_at: '2026-08-10T00:00:00.000Z',
    },
    forum_id: 'forum-1',
    submission: {
      id: 'paper-1',
      forum: 'forum-1',
      readers: ['everyone'],
      license: 'CC BY 4.0',
      content: {
        title: field('A Transparent Submission Assistant'),
        abstract: field('We introduce and evaluate a transparent workflow for scientific submission assistance.'),
        authors: field(['Alice Smith', 'Bob Jones']),
        authorids: field(['~Alice_Smith1', '~Bob_Jones1']),
        keywords: field(['peer review', 'scientific workflow']),
        paper_text: field(
          'Abstract\n\nAlice Smith presents the system. Contact alice@example.org.\n\n1 Introduction\n\nWe introduce a transparent workflow.\n\n2 Experiments\n\nWe evaluate 30 examples and report an improvement.',
        ),
      },
    },
    replies: [
      {
        kind: 'official_review',
        note: officialReview(
          'review-1',
          'The evaluation includes only thirty examples, so broader stability claims need stronger support.',
        ),
      },
    ],
    pdf: { status: 'not_requested', license: 'CC BY 4.0', path: null, sha256: null },
    ...overrides,
  };
}

test('OpenReview helpers classify invitations, licenses and identity text', () => {
  assert.equal(invitationKind(officialReview('review', 'text')), 'official_review');
  assert.equal(invitationKind({ invitations: ['Venue/Submission1/-/Meta_Review'] }), 'meta_review');
  assert.equal(invitationKind({ invitations: ['Venue/Submission1/-/Decision'] }), 'decision');
  assert.equal(isAllowedArticleLicense('Creative Commons Attribution 4.0 International'), true);
  assert.equal(isAllowedArticleLicense('CC BY-NC 4.0'), false);
  assert.equal(
    redactText('Alice Smith alice@example.org ~Alice_Smith1', ['Alice Smith']),
    '[REDACTED_AUTHOR] [REDACTED_EMAIL] [REDACTED_PROFILE]',
  );
});

test('collector keeps only public submissions and public recognized replies', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'onescience-openreview-collect-'));
  const publicSubmission = {
    id: 'paper-1',
    forum: 'forum-1',
    readers: ['everyone'],
    content: { title: field('Public paper'), license: field('CC BY 4.0') },
    details: {
      replies: [
        officialReview('public-review', 'A substantive public review.'),
        officialReview('private-review', 'A private review.', ['Venue/Reviewers']),
        { id: 'unknown', forum: 'forum-1', readers: ['everyone'], invitations: ['Venue/-/Unknown'], content: {} },
      ],
    },
  };
  const privateSubmission = { ...publicSubmission, id: 'paper-private', readers: ['Venue/Program_Chairs'] };
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).pathname, '/notes');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.match(init.headers['User-Agent'], /OneScience/);
    return {
      ok: true,
      json: async () => ({ count: 2, notes: [publicSubmission, privateSubmission] }),
    };
  };

  try {
    const result = await collectVenue(
      {
        venue_id: 'Venue/2024/Conference',
        year: 2024,
        submission_invitation: 'Venue/2024/Conference/-/Submission',
        download_pdfs: false,
      },
      { outputDir, fetchImpl, token: 'test-token' },
    );
    assert.equal(result.bundles.length, 1);
    assert.equal(result.bundles[0].replies.length, 1);
    assert.equal(result.bundles[0].replies[0].note.id, 'public-review');
    assert.equal(result.manifest.skipped_private_submissions, 1);
    assert.equal(result.manifest.skipped_private_replies, 1);
    const written = await readFile(result.jsonlPath, 'utf8');
    assert.match(written, /public-review/);
    assert.doesNotMatch(written, /private-review/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('cleaner anonymizes content, assigns paragraph ids and enforces license eligibility', async () => {
  const cleaned = await cleanForumBundle(rawBundle(), { minReviewCharacters: 40 });
  const serialized = JSON.stringify(cleaned);
  assert.equal(cleaned.training_eligible, true);
  assert.equal(cleaned.reviews.length, 1);
  assert.equal(cleaned.reviews[0].rating, 6);
  assert.equal(cleaned.reviews[0].confidence, 4);
  assert.ok(cleaned.paper.paragraphs.length >= 3);
  assert.match(cleaned.paper.paragraphs[0].paragraph_id, /^section-\d{2}-p\d{3}$/);
  assert.doesNotMatch(serialized, /Alice Smith|alice@example\.org|~Alice_Smith1/);
  assert.match(serialized, /REDACTED_AUTHOR/);

  const disallowed = await cleanForumBundle(
    rawBundle({
      submission: { ...rawBundle().submission, license: 'CC BY-NC 4.0' },
      pdf: { status: 'license_not_allowed', license: 'CC BY-NC 4.0', path: null, sha256: null },
    }),
    { minReviewCharacters: 40 },
  );
  assert.equal(disallowed.training_eligible, false);
  assert.equal(disallowed.paper.text, '');
  assert.ok(disallowed.quality_flags.includes('article_license_not_allowed'));
});

function splitFixture(forumId, year, title, manuscriptHash) {
  return {
    ...rawBundle(),
    source: { ...rawBundle().source, forum_id: forumId, year },
    dedup: {
      normalized_title: title,
      exact_title_hash: `title-${title}`,
      manuscript_hash: manuscriptHash,
    },
    training_eligible: true,
  };
}

test('splitter keeps duplicate papers together and gives test years precedence', () => {
  const records = [
    splitFixture('old-version', 2022, 'transparent submission assistant', 'same-paper'),
    splitFixture('new-version', 2024, 'transparent submission assistant revised', 'same-paper'),
    splitFixture('validation-paper', 2023, 'review calibration', 'validation-hash'),
    splitFixture('train-paper', 2022, 'evidence alignment', 'train-hash'),
  ];
  const { output } = splitRecords(records, {
    validation_years: [2023],
    test_years: [2024],
    near_duplicate_threshold: 0.9,
  });
  assert.deepEqual(output.test.map((record) => record.source.forum_id).sort(), ['new-version', 'old-version']);
  assert.deepEqual(output.validation.map((record) => record.source.forum_id), ['validation-paper']);
  assert.deepEqual(output.train.map((record) => record.source.forum_id), ['train-paper']);
  assert.equal(output.test[0].dedup.group_id, output.test[1].dedup.group_id);
});
