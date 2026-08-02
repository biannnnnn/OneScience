import path from 'node:path';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { normalizeUploadFilename } from './filename.mjs';

const SECTION_PATTERNS = {
  abstract: /(^|\n)\s*(摘要|abstract)\s*[:：]?/i,
  introduction: /(^|\n)\s*(\d+[.、\s]*)?(引言|绪论|introduction|background)\s*[:：]?/i,
  methods: /(^|\n)\s*(\d+[.、\s]*)?(材料与方法|研究方法|方法|methodology|materials?\s+and\s+methods?|methods?)\s*[:：]?/i,
  results: /(^|\n)\s*(\d+[.、\s]*)?(结果|实验结果|results?|findings)\s*[:：]?/i,
  discussion: /(^|\n)\s*(\d+[.、\s]*)?(讨论|分析与讨论|discussion)\s*[:：]?/i,
  conclusion: /(^|\n)\s*(\d+[.、\s]*)?(结论|总结与展望|conclusions?)\s*[:：]?/i,
  references: /(^|\n)\s*(参考文献|references?|bibliography)\s*[:：]?/i,
};

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  const latinWords = text.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
  const chineseChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinWords + chineseChars;
}

function extractAbstract(text) {
  const match = text.match(
    /(?:^|\n)\s*(?:摘要|abstract)\s*[:：]?\s*([\s\S]{40,2200}?)(?=\n\s*(?:(?:关键词|关键字|keywords?)\s*[:：]|(?:\d+[.、\s]+)?(?:引言|绪论|introduction)(?:\s|$))|$)/i,
  );
  return match?.[1]?.replace(/\n+/g, ' ').trim() ?? '';
}

function extractKeywords(text) {
  const match = text.match(
    /(?:关键词|关键字|keywords?)\s*[:：]\s*([^\n]{2,300})/i,
  );
  if (!match) return [];
  return match[1]
    .split(/[;,；，、|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function extractTitle(text, fallbackName) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.find(
    (line) =>
      line.length >= 6 &&
      line.length <= 220 &&
      !Object.values(SECTION_PATTERNS).some((pattern) => pattern.test(`\n${line}`)),
  );
  return candidate || path.parse(fallbackName).name;
}

function countReferences(text) {
  const referenceStart = text.search(SECTION_PATTERNS.references);
  const referenceText = referenceStart >= 0 ? text.slice(referenceStart) : text;
  const numbered = referenceText.match(/(?:^|\n)\s*(?:\[\d+\]|\d+[.)、])\s+/g)?.length ?? 0;
  const authorYear = referenceText.match(/\([12][0-9]{3}[a-z]?\)/gi)?.length ?? 0;
  return Math.max(numbered, Math.min(authorYear, 200));
}

export async function extractDocument(file) {
  const filename = normalizeUploadFilename(file.originalname);
  const extension = path.extname(filename).toLowerCase();
  let rawText = '';

  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    rawText = result.value;
  } else if (extension === '.pdf') {
    const result = await pdf(file.buffer);
    rawText = result.text;
  } else if (['.txt', '.md'].includes(extension)) {
    rawText = file.buffer.toString('utf8');
  } else {
    throw new Error('暂不支持该文件格式，请上传 DOCX、PDF、TXT 或 Markdown 文件。');
  }

  const text = normalizeText(rawText);
  if (text.length < 120) {
    throw new Error('未能提取到足够的论文正文，请检查文件是否为空、加密或仅包含扫描图片。');
  }

  const detectedSections = Object.fromEntries(
    Object.entries(SECTION_PATTERNS).map(([name, pattern]) => [name, pattern.test(text)]),
  );
  const chineseChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinChars = text.match(/[A-Za-z]/g)?.length ?? 0;

  return {
    filename,
    fileType: extension.slice(1).toUpperCase(),
    title: extractTitle(text, filename),
    abstract: extractAbstract(text),
    keywords: extractKeywords(text),
    language: chineseChars >= latinChars * 0.35 ? '中文' : '英文',
    characterCount: text.length,
    wordCount: countWords(text),
    referenceCount: countReferences(text),
    detectedSections,
    text,
  };
}

export const __testables = { normalizeText, countWords, extractAbstract, extractKeywords };
