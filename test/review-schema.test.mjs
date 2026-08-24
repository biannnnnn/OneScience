import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loadJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));

test('review schema and canonical example stay on the same version', async () => {
  const [schema, example] = await Promise.all([
    loadJson('../schemas/review-schema.json'),
    loadJson('../docs/reviewer/review-example.json'),
  ]);

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema_version.const, example.schema_version);
  assert.equal(schema.additionalProperties, false);

  const required = new Set(schema.required);
  for (const key of Object.keys(example)) {
    assert.ok(key in schema.properties, `${key} is not declared by the schema`);
  }
  for (const key of required) assert.ok(key in example, `${key} is missing from the example`);
});

test('canonical review example has valid ids, evidence and task references', async () => {
  const example = await loadJson('../docs/reviewer/review-example.json');
  const concerns = [...example.major_concerns, ...example.minor_concerns];
  const concernIds = new Set(concerns.map((item) => item.id));
  const allIds = [
    ...example.strengths.map((item) => item.id),
    ...concerns.map((item) => item.id),
    ...example.questions.map((item) => item.id),
    ...example.revision_tasks.map((item) => item.id),
  ];

  assert.equal(new Set(allIds).size, allIds.length, 'review item ids must be unique');
  assert.ok(example.strengths.every((item) => item.evidence.length > 0));
  assert.ok(concerns.every((item) => item.evidence.length > 0));

  for (const task of example.revision_tasks) {
    assert.ok(task.source_concern_ids.length > 0);
    assert.ok(task.source_concern_ids.every((id) => concernIds.has(id)));
  }
  for (const question of example.questions) {
    assert.ok(question.related_concern_ids.every((id) => concernIds.has(id)));
  }

  const directEvidence = [
    ...example.central_contribution.evidence,
    ...example.strengths.flatMap((item) => item.evidence),
    ...concerns.flatMap((item) => item.evidence),
  ].filter((item) => item.type === 'direct_quote');
  assert.ok(directEvidence.length > 0);
  assert.ok(directEvidence.every((item) => item.section && item.paragraph_id && item.excerpt));
});

test('schema separates pre-submission readiness from acceptance prediction', async () => {
  const schema = await loadJson('../schemas/review-schema.json');
  const verdicts = schema.$defs.recommendation.properties.verdict.enum;

  assert.deepEqual(verdicts, [
    'ready_for_submission',
    'minor_revision',
    'major_revision',
    'fundamental_revision',
    'insufficient_evidence',
  ]);
  assert.equal(verdicts.includes('accept'), false);
  assert.equal(verdicts.includes('reject'), false);
});
