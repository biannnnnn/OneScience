import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(projectRoot, '.venv-mlx', 'bin', 'python');

test('acceptance predictor keeps decision labels out of reviewer features and returns calibrated output', {
  skip: !existsSync(python) && '需要项目的 .venv-mlx Python 环境',
}, async () => {
  const { stdout, stderr } = await execute(python, [
    '-m', 'unittest', 'test_py.test_acceptance_prediction',
  ], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/onescience-test-pycache' },
  });
  assert.equal(stdout, '');
  assert.match(stderr, /OK/);
});
