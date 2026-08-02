import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDocument } from '../server/lib/analyzer.mjs';
import { __testables as extractor } from '../server/lib/extractor.mjs';
import { normalizeUploadFilename } from '../server/lib/filename.mjs';

function completeDocument() {
  return {
    title: 'A Reproducible Framework for Intelligent Journal Recommendation',
    abstract:
      'This study proposes a novel framework for intelligent journal recommendation. Experiments on a public dataset show that the method outperforms the baseline and improves retrieval accuracy.',
    keywords: ['journal recommendation', 'artificial intelligence', 'retrieval'],
    wordCount: 5200,
    referenceCount: 32,
    detectedSections: {
      abstract: true,
      introduction: true,
      methods: true,
      results: true,
      discussion: true,
      conclusion: true,
      references: true,
    },
    text:
      'dataset sample size parameters source code github random baseline Figure 1 Table 1 p < 0.05 significant ablation experiment results methodology discussion',
  };
}

test('complete manuscript receives a bounded, strong score', () => {
  const result = analyzeDocument(completeDocument());
  assert.ok(result.overall >= 75);
  assert.ok(result.overall <= 100);
  assert.equal(Object.keys(result.scores).length, 5);
  assert.ok(result.confidence <= 92);
});

test('missing core sections generates actionable risks', () => {
  const document = completeDocument();
  document.detectedSections.methods = false;
  document.detectedSections.results = false;
  document.referenceCount = 2;
  document.text = 'short manuscript without core experimental details';
  const result = analyzeDocument(document);
  assert.ok(result.issues.some((issue) => issue.title === '方法章节不明确'));
  assert.ok(result.issues.some((issue) => issue.title === '结果章节不明确'));
  assert.ok(result.issues.every((issue) => issue.action.length > 0));
});

test('Chinese abstract and keyword extraction stops at the next section', () => {
  const text = extractor.normalizeText(
    '论文标题\n\n摘要：这是一个用于验证摘要抽取功能的中文摘要，其中包含研究问题、研究方法以及实验结论，长度足够完成解析。\n关键词：智能体；论文分析；投稿\n1 引言\n这里是引言正文。',
  );
  const abstract = extractor.extractAbstract(text);
  assert.match(abstract, /验证摘要抽取/);
  assert.doesNotMatch(abstract, /关键词/);
  assert.deepEqual(extractor.extractKeywords(text), ['智能体', '论文分析', '投稿']);
});

test('multipart mojibake in a Chinese filename is repaired', () => {
  const filename = '大模型驱动的具身群体智能研究.pdf';
  const latin1Decoded = Buffer.from(filename, 'utf8').toString('latin1');
  assert.equal(normalizeUploadFilename(latin1Decoded), filename);
});

test('legitimate Latin filename and client paths are preserved safely', () => {
  assert.equal(normalizeUploadFilename('résumé.pdf'), 'résumé.pdf');
  assert.equal(normalizeUploadFilename('C:\\fakepath\\论文.docx'), '论文.docx');
});
