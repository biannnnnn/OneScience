import path from 'node:path';

const CJK_CHARACTERS = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function decodeMojibakeFilename(filename) {
  if ([...filename].some((character) => character.codePointAt(0) > 0xff)) {
    return filename;
  }

  const decoded = Buffer.from(filename, 'latin1').toString('utf8');
  if (decoded.includes('\ufffd')) return filename;

  // Multipart parsers may interpret UTF-8 filename bytes as Latin-1.
  // Only accept recovery when it reveals CJK text that was absent before,
  // so legitimate Latin filenames such as “résumé.pdf” remain untouched.
  if (!CJK_CHARACTERS.test(filename) && CJK_CHARACTERS.test(decoded)) {
    return decoded;
  }

  return filename;
}

export function normalizeUploadFilename(value) {
  const raw = String(value || '')
    .replaceAll('\\', '/')
    .replaceAll('\0', '')
    .trim();
  const basename = path.posix.basename(raw) || '未命名文件';
  return decodeMojibakeFilename(basename).normalize('NFC');
}

export const __testables = { decodeMojibakeFilename };
