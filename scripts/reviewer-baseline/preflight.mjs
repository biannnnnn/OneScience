import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, readJson, requireArg } from '../openreview/lib.mjs';

function pythonCheck() {
  const localPython = path.resolve('.venv-mlx/bin/python');
  const executable = process.env.BASELINE_PYTHON || (existsSync(localPython) ? localPython : 'python3');
  try {
    const output = execFileSync(executable, [
      '-c',
      'import importlib.util,platform,sys,json; print(json.dumps({"version":platform.python_version(),"mlx":bool(importlib.util.find_spec("mlx")),"mlx_lm":bool(importlib.util.find_spec("mlx_lm"))}))',
    ], { encoding: 'utf8' });
    return { executable, ...JSON.parse(output) };
  } catch (error) {
    return { executable, version: null, mlx: false, mlx_lm: false, error: error.message };
  }
}

export async function inspectMachine(config, targetPath = process.cwd()) {
  const fileSystem = await statfs(targetPath);
  const freeDiskGb = (fileSystem.bavail * fileSystem.bsize) / 1024 ** 3;
  const memoryGb = os.totalmem() / 1024 ** 3;
  const python = pythonCheck();
  const minimumMemory = Number(config.hardware_profile.minimum_memory_gb);
  const recommendedDisk = Number(config.hardware_profile.recommended_free_disk_gb);
  const modelSnapshot = path.resolve(
    targetPath,
    config.model_cache_dir,
    `models--${config.model_id.replaceAll('/', '--')}`,
    'snapshots',
    config.model_revision,
  );
  const modelCached = existsSync(modelSnapshot);
  const checks = {
    apple_silicon: process.platform === 'darwin' && process.arch === 'arm64',
    memory_minimum: memoryGb >= minimumMemory - 0.25,
    disk_recommended: freeDiskGb >= recommendedDisk,
    mlx_installed: python.mlx && python.mlx_lm,
    model_cached: modelCached,
  };
  const ready = checks.apple_silicon
    && checks.memory_minimum
    && checks.mlx_installed
    && (checks.disk_recommended || checks.model_cached);
  return {
    ready,
    platform: process.platform,
    architecture: process.arch,
    memory_gb: Number(memoryGb.toFixed(1)),
    free_disk_gb: Number(freeDiskGb.toFixed(1)),
    python,
    model_id: config.model_id,
    checks,
    actions: [
      !checks.disk_recommended && !checks.model_cached
        && `下载模型前至少释放到 ${recommendedDisk}GB 可用空间，或把 HF_HOME 指向外置磁盘`,
      !checks.mlx_installed && '创建独立虚拟环境并安装 mlx-lm',
    ].filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(path.resolve(requireArg(args, 'config')));
  const result = await inspectMachine(config, process.cwd());
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Apple Silicon：${result.checks.apple_silicon ? '通过' : '不通过'}`);
    console.log(`统一内存：${result.memory_gb}GB（${result.checks.memory_minimum ? '达到最低要求' : '不足'}）`);
    const diskStatus = result.checks.disk_recommended
      ? '达到建议值'
      : result.checks.model_cached ? '低于建议值，固定模型已缓存' : '不足以下载模型';
    console.log(`磁盘可用：${result.free_disk_gb}GB（${diskStatus}）`);
    console.log(`固定模型缓存：${result.checks.model_cached ? '已就绪' : '未找到'}`);
    console.log(`MLX 环境：${result.checks.mlx_installed ? '已安装' : '未安装'}`);
    console.log(`整体状态：${result.ready ? '可运行' : '尚未就绪'}`);
    for (const action of result.actions) console.log(`- ${action}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
