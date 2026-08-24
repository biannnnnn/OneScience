import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(projectRoot, '.venv-mlx', 'bin', 'python');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Reviewer Service 启动超时：${stderr}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'ready') {
            clearTimeout(timer);
            resolve(event);
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Reviewer Service 提前退出（${code}）：${stderr}`));
    });
  });
}

test('local Reviewer Service exposes health, model discovery and schema-validated review APIs', {
  skip: !existsSync(python) && '需要项目的 .venv-mlx Python 环境',
}, async () => {
  const port = await availablePort();
  const child = spawn(python, [
    '-m', 'reviewer_service.app',
    '--config', 'config/reviewer-service.m1.json',
    '--backend', 'mock',
    '--port', String(port),
  ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const ready = await waitForReady(child);
    const baseUrl = ready.url;
    const healthResponse = await fetch(`${baseUrl}/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.status, 'ready');
    assert.equal(health.backend.backend, 'mock');
    assert.equal(health.privacy.persist_requests, false);
    assert.equal(health.acceptance_prediction.loaded, false);

    const modelsResponse = await fetch(`${baseUrl}/v1/models`);
    const models = await modelsResponse.json();
    assert.equal(models.active.model, 'reviewer-mock');
    assert.deepEqual(models.available_backends, ['mlx', 'openai_compatible', 'mock', 'plan_b']);
    assert.ok(models.capabilities.includes('venue_score_batch'));
    assert.equal(models.acceptance_predictor, null);

    const invalidResponse = await fetch(`${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_type: 'general' }),
    });
    const invalid = await invalidResponse.json();
    assert.equal(invalidResponse.status, 422);
    assert.equal(invalid.error.code, 'REQUEST_SCHEMA_INVALID');
    assert.ok(invalid.error.details.length >= 1);

    const request = {
      request_id: 'service-test-01',
      review_type: 'general',
      review_language: 'zh-CN',
      target_venue: null,
      manuscript: {
        paper_id: 'paper-01',
        title: '本地审稿服务协议测试',
        language: 'zh-CN',
        fingerprint: 'sha256:test',
        paragraphs: [
          { section: '摘要', paragraph_id: 'abstract-p01', text: '本文验证本地审稿服务的接口协议与模型替换机制。' },
        ],
      },
    };
    const reviewResponse = await fetch(`${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const result = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200);
    assert.equal(result.status, 'completed');
    assert.equal(result.schema_version, '1.0.0');
    assert.equal(result.review.manuscript.paper_id, 'paper-01');
    assert.ok(Array.isArray(result.review.limitations));
    assert.equal(result.review.model_trace.model, 'reviewer-mock');

    const scoreResponse = await fetch(`${baseUrl}/v1/venue-scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: 'score-test-01',
        review_language: 'zh-CN',
        target_venue: { id: 'venue-01', name: 'Test Journal' },
        papers: [
          {
            paper_id: 'manuscript-01',
            title: '用户稿件',
            input_type: 'manuscript',
            language: 'zh-CN',
            text: '本文提供足够长的测试正文，用于验证同一期刊条件下的批量评分服务协议。',
          },
          {
            paper_id: 'reference-01',
            title: 'Reference paper',
            input_type: 'abstract',
            language: 'en',
            text: 'This abstract is long enough to validate the compact venue scoring contract.',
          },
        ],
      }),
    });
    const scoreResult = await scoreResponse.json();
    assert.equal(scoreResponse.status, 200);
    assert.equal(scoreResult.score_batch.scores.length, 2);
    assert.equal(scoreResult.score_batch.scores[0].input_type, 'manuscript');
    assert.equal(scoreResult.score_batch.model_trace.prompt_version, 'venue-score-mock-1.0.0');
    assert.match(scoreResult.score_batch.disclaimer, /不是录用概率/);

    const duplicateScoreResponse = await fetch(`${baseUrl}/v1/venue-scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        review_language: 'zh-CN',
        target_venue: { name: 'Test Journal' },
        papers: [
          { paper_id: 'same', title: 'A', input_type: 'abstract', language: 'en', text: 'A sufficiently long abstract for duplicate id validation.' },
          { paper_id: 'same', title: 'B', input_type: 'abstract', language: 'en', text: 'Another sufficiently long abstract for duplicate id validation.' },
        ],
      }),
    });
    const duplicateScore = await duplicateScoreResponse.json();
    assert.equal(duplicateScoreResponse.status, 422);
    assert.equal(duplicateScore.error.code, 'SCORE_REQUEST_SCHEMA_INVALID');

    const unavailablePredictionResponse = await fetch(`${baseUrl}/v1/acceptance-predictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const unavailablePrediction = await unavailablePredictionResponse.json();
    assert.equal(unavailablePredictionResponse.status, 503);
    assert.equal(unavailablePrediction.error.code, 'ACCEPTANCE_MODEL_NOT_CONFIGURED');

    const duplicateResponse = await fetch(`${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        request_id: 'duplicate-paragraphs',
        manuscript: {
          ...request.manuscript,
          paragraphs: [request.manuscript.paragraphs[0], request.manuscript.paragraphs[0]],
        },
      }),
    });
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 422);
    assert.match(duplicate.error.details.at(-1).message, /paragraph_id/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('server Reviewer Service protects model and review APIs with a bearer key', {
  skip: !existsSync(python) && '需要项目的 .venv-mlx Python 环境',
}, async () => {
  const port = await availablePort();
  const apiKey = 'reviewer-service-test-key';
  const child = spawn(python, [
    '-m', 'reviewer_service.app',
    '--config', 'config/reviewer-server/service.json',
    '--backend', 'mock',
    '--port', String(port),
  ], {
    cwd: projectRoot,
    env: { ...process.env, ONESCIENCE_REVIEWER_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const ready = await waitForReady(child);
    const healthResponse = await fetch(`${ready.url}/health`);
    assert.equal(healthResponse.status, 200);

    const unauthorized = await fetch(`${ready.url}/v1/models`);
    const unauthorizedBody = await unauthorized.json();
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.error.code, 'UNAUTHORIZED');

    const authorized = await fetch(`${ready.url}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).active.backend, 'mock');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
