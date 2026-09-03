import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const python = path.join(root, ".venv-mlx", "bin", "python");
const script = path.join(root, "scripts", "naipv2", "prepare_fulltext_evidence.py");

test("full-text evidence preparation excludes leakage and removes train/test overlap", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "onescience-fulltext-ranker-"));
  const fixture = path.join(scratch, "fixture.py");
  writeFileSync(fixture, String.raw`
import pandas as pd
import sys

root = sys.argv[1]
markdown = {"content": """Alice Author, Famous University
# Abstract
We introduce a ranking method for scientific papers [12]. It targets reliable evaluation.
# Introduction
This paper studies whether richer evidence improves paper ranking. Our contribution is an auditable evidence representation.
# Experiments
We evaluate on the DemoSet benchmark with three baselines. Training uses a fixed split and accuracy as the metric.
# Results and Conclusion
Our method improves accuracy by five points. We conclude that structured full-text evidence is useful.
# References
Secret Venue 2025. https://leak.example
"""}
def row(pid, title, decision):
    return {
        "paper_id": pid, "arxiv_id": pid, "title": title, "markdown": markdown,
        "reviews": {"private": "never input"},
        "scores": {"rating": "4;8", "confidence": "1;3", "rating_avg": 6.0},
        "metadata": {"venueid": "SecretVenue.cc/2025/Conference"},
        "meta_review": "never input", "decision": {"decision": decision},
    }
pd.DataFrame([row("same", "Same paper", "Accept"), row("train-only", "Train paper", "Reject")]).to_parquet(root + "/train.parquet")
pd.DataFrame([row("same", "Same paper", "Accept"), row("test-only", "Test paper", "Reject")]).to_parquet(root + "/test.parquet")
`);
  execFileSync(python, [fixture, scratch]);
  execFileSync(python, [
    script,
    "--train-parquet", path.join(scratch, "train.parquet"),
    "--test-parquet", path.join(scratch, "test.parquet"),
    "--output-dir", path.join(scratch, "out"),
  ]);
  const manifest = JSON.parse(readFileSync(path.join(scratch, "out", "manifest.json"), "utf8"));
  assert.equal(manifest.overlap_removed_from_train, 1);
  assert.equal(manifest.train.rows, 1);
  assert.equal(manifest.test.rows, 2);
  assert.equal(manifest.test.groups, 1);
  const csv = readFileSync(path.join(scratch, "out", "proreview-test.csv"), "utf8");
  assert.match(csv, /\[EXPERIMENTAL SETUP AND DATASETS\]/);
  assert.match(csv, /DemoSet benchmark/);
  assert.doesNotMatch(csv, /Alice Author|Famous University|Secret Venue 2025|leak\.example|never input/);
  assert.match(csv, /7\.0/); // (4*1 + 8*3) / 4
});

test("full-text Ranker prompt packs only the four declared evidence sections", () => {
  const output = execFileSync(python, ["-c", String.raw`
from ranker_service.model import prompt_for_paper
print(prompt_for_paper({
  "title": "Paper", "abstract": "Abstract",
  "research_question_contributions": "Question and contribution",
  "experimental_setup_datasets": "Experiment and dataset",
  "key_findings_conclusion": "Findings and conclusion",
  "authors": "Must not appear", "decision": "Accept",
}, "fulltext_evidence_v1"))
`], { cwd: root, encoding: "utf8" });
  assert.match(output, /\[RESEARCH QUESTION AND MAIN CONTRIBUTIONS\]/);
  assert.match(output, /\[EXPERIMENTAL SETUP AND DATASETS\]/);
  assert.match(output, /\[KEY FINDINGS AND CONCLUSION\]/);
  assert.doesNotMatch(output, /Must not appear|Accept/);
});
