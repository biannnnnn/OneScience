import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ALLOWED_ARTICLE_LICENSES,
  contentValue,
  invitationKind,
  isAllowedArticleLicense,
  isPublicNote,
  parseArgs,
  readJson,
  requireArg,
  sha256,
  slugify,
  writeJson,
  writeJsonl,
  yearFromVenue,
} from './lib.mjs';

const DEFAULT_API_BASE = 'https://api2.openreview.net';

async function getJson(url, fetchImpl = fetch, headers = {}) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const hint = response.status === 403
      ? '。当前 API 拒绝了访客请求；请设置 OPENREVIEW_TOKEN，或使用 OPENREVIEW_USERNAME 和 OPENREVIEW_PASSWORD'
      : '';
    throw new Error(`OpenReview 请求失败（HTTP ${response.status}）：${url}${hint}`);
  }
  return response.json();
}

async function resolveHeaders(apiBase, fetchImpl, options = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'OneScience-OpenReview-Collector/1.0',
  };
  const configuredToken = options.token || process.env.OPENREVIEW_TOKEN;
  if (configuredToken) {
    headers.Authorization = `Bearer ${String(configuredToken).replace(/^Bearer\s+/i, '')}`;
    return headers;
  }
  const username = options.username || process.env.OPENREVIEW_USERNAME;
  const password = options.password || process.env.OPENREVIEW_PASSWORD;
  if (!username && !password) return headers;
  if (!username || !password) throw new Error('OPENREVIEW_USERNAME 和 OPENREVIEW_PASSWORD 必须同时设置。');
  const response = await fetchImpl(new URL('/login', apiBase), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: username, password }),
  });
  if (!response.ok) throw new Error(`OpenReview 登录失败（HTTP ${response.status}）。`);
  const body = await response.json();
  if (body.mfaPending) throw new Error('该 OpenReview 账号启用了 MFA；请使用官方客户端生成短期 OPENREVIEW_TOKEN。');
  if (!body.token) throw new Error('OpenReview 登录响应没有返回 token。');
  headers.Authorization = `Bearer ${body.token}`;
  return headers;
}

async function resolveSubmissionInvitation(venue, apiBase, fetchImpl, headers) {
  if (venue.submission_invitation) return venue.submission_invitation;
  const url = new URL('/groups', apiBase);
  url.searchParams.set('id', venue.venue_id);
  const body = await getJson(url, fetchImpl, headers);
  const group = body.groups?.[0];
  const submissionName = contentValue(group, ['submission_name']);
  if (!submissionName) {
    throw new Error(`${venue.venue_id} 未配置 submission_invitation，且无法从 venue group 获取 submission_name。`);
  }
  return `${venue.venue_id}/-/${submissionName}`;
}

async function getAllSubmissions(invitation, apiBase, fetchImpl, headers, limit = 0) {
  const pageSize = Math.min(limit || 1000, 1000);
  const notes = [];
  let offset = 0;
  while (true) {
    const url = new URL('/notes', apiBase);
    url.searchParams.set('invitation', invitation);
    url.searchParams.set('details', 'replies');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const body = await getJson(url, fetchImpl, headers);
    const page = body.notes || [];
    notes.push(...page);
    if (!page.length || page.length < pageSize || notes.length >= body.count || (limit && notes.length >= limit)) break;
    offset += page.length;
  }
  return limit ? notes.slice(0, limit) : notes;
}

function minimizeNote(note) {
  return {
    id: note.id,
    forum: note.forum || note.id,
    replyto: note.replyto || null,
    number: note.number ?? null,
    invitations: note.invitations || (note.invitation ? [note.invitation] : []),
    readers: note.readers || [],
    cdate: note.cdate ?? note.tcdate ?? null,
    mdate: note.mdate ?? note.tmdate ?? null,
    license: note.license || null,
    content: note.content || {},
  };
}

function articleLicense(note) {
  return note.license || contentValue(note, ['license', 'copyright_license'], '');
}

async function maybeDownloadPdf(submission, venue, outputDir, fetchImpl, headers) {
  const license = articleLicense(submission);
  const allowlist = venue.allowed_article_licenses || DEFAULT_ALLOWED_ARTICLE_LICENSES;
  const pdfValue = contentValue(submission, ['pdf']);
  if (!venue.download_pdfs) return { status: 'not_requested', license: license || null, path: null, sha256: null };
  if (!license) return { status: 'license_missing', license: null, path: null, sha256: null };
  if (!isAllowedArticleLicense(license, allowlist)) {
    return { status: 'license_not_allowed', license, path: null, sha256: null };
  }
  if (!pdfValue) return { status: 'pdf_missing', license, path: null, sha256: null };

  const url = new URL('/attachment', venue.api_base_url || DEFAULT_API_BASE);
  url.searchParams.set('id', submission.id);
  url.searchParams.set('name', 'pdf');
  const response = await fetchImpl(url, { headers });
  if (!response.ok) return { status: `download_error_${response.status}`, license, path: null, sha256: null };
  const buffer = Buffer.from(await response.arrayBuffer());
  const relativePath = path.join('pdfs', `${submission.id}.pdf`);
  const targetPath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buffer);
  return { status: 'downloaded', license, path: relativePath, sha256: sha256(buffer) };
}

export async function collectVenue(venue, options = {}) {
  if (!venue?.venue_id) throw new Error('venue 配置缺少 venue_id。');
  const fetchImpl = options.fetchImpl || fetch;
  const apiBase = venue.api_base_url || options.apiBase || DEFAULT_API_BASE;
  const outputDir = options.outputDir;
  if (!outputDir) throw new Error('collectVenue 需要 outputDir。');
  const headers = await resolveHeaders(apiBase, fetchImpl, options);
  const invitation = await resolveSubmissionInvitation(venue, apiBase, fetchImpl, headers);
  const submissions = await getAllSubmissions(
    invitation,
    apiBase,
    fetchImpl,
    headers,
    Number(venue.max_submissions || options.limit || 0),
  );
  const fetchedAt = new Date().toISOString();
  const bundles = [];
  let skippedPrivateSubmissions = 0;
  let skippedPrivateReplies = 0;

  for (const submission of submissions) {
    if (!isPublicNote(submission)) {
      skippedPrivateSubmissions += 1;
      continue;
    }
    const rawReplies = submission.details?.replies || [];
    const replies = [];
    for (const reply of rawReplies) {
      if (!isPublicNote(reply)) {
        skippedPrivateReplies += 1;
        continue;
      }
      const kind = invitationKind(reply);
      if (kind !== 'other') replies.push({ kind, note: minimizeNote(reply) });
    }
    const pdf = await maybeDownloadPdf(submission, venue, outputDir, fetchImpl, headers);
    bundles.push({
      raw_schema_version: '1.0.0',
      source: {
        provider: 'OpenReview',
        api_version: 2,
        api_base_url: apiBase,
        terms_url: 'https://openreview.net/legal/terms',
        venue_id: venue.venue_id,
        year: Number(venue.year || yearFromVenue(venue.venue_id)),
        submission_invitation: invitation,
        fetched_at: fetchedAt,
      },
      forum_id: submission.forum || submission.id,
      submission: minimizeNote(submission),
      replies,
      pdf,
    });
  }

  const venueSlug = slugify(venue.venue_id);
  const jsonlPath = path.join(outputDir, `${venueSlug}.jsonl`);
  await writeJsonl(jsonlPath, bundles);
  const manifest = {
    venue_id: venue.venue_id,
    submission_invitation: invitation,
    fetched_at: fetchedAt,
    public_forums: bundles.length,
    skipped_private_submissions: skippedPrivateSubmissions,
    skipped_private_replies: skippedPrivateReplies,
    reply_counts: Object.fromEntries(
      ['official_review', 'meta_review', 'decision', 'author_response', 'comment']
        .map((kind) => [kind, bundles.reduce((sum, bundle) => sum + bundle.replies.filter((item) => item.kind === kind).length, 0)]),
    ),
    output: path.basename(jsonlPath),
  };
  await writeJson(path.join(outputDir, `${venueSlug}.manifest.json`), manifest);
  return { bundles, manifest, jsonlPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = requireArg(args, 'config');
  const outputDir = path.resolve(String(args.out || 'data/openreview/raw'));
  const config = await readJson(path.resolve(configPath));
  if (!Array.isArray(config.venues) || !config.venues.length) throw new Error('配置文件必须包含非空 venues 数组。');
  for (const venue of config.venues) {
    const result = await collectVenue(
      { ...venue, api_base_url: venue.api_base_url || config.api_base_url },
      { outputDir, limit: Number(args.limit || 0) },
    );
    console.log(`${venue.venue_id}: 已采集 ${result.manifest.public_forums} 个公开论坛`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
