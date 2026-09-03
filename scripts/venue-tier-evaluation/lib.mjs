import crypto from 'node:crypto';

const REQUIRED_FIELDS = [
  'paper_id', 'title', 'abstract', 'venue', 'venue_tier', 'tier_rank',
  'field', 'article_type', 'year',
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'using', 'we', 'with',
]);

export function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizePapers(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('At least two papers are required.');
  const seen = new Set();
  return rows.map((row, index) => {
    for (const field of REQUIRED_FIELDS) {
      if (row[field] === undefined || row[field] === null || clean(row[field]) === '') {
        throw new Error(`Paper ${index + 1} is missing ${field}.`);
      }
    }
    const paperId = clean(row.paper_id);
    if (seen.has(paperId)) throw new Error(`Duplicate paper_id: ${paperId}`);
    seen.add(paperId);
    const tierRank = Number(row.tier_rank);
    const year = Number(row.year);
    if (!Number.isInteger(tierRank) || tierRank < 1) throw new Error(`Invalid tier_rank for ${paperId}.`);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error(`Invalid year for ${paperId}.`);
    return {
      paper_id: paperId,
      title: clean(row.title),
      abstract: clean(row.abstract),
      venue: clean(row.venue),
      venue_tier: clean(row.venue_tier),
      tier_rank: tierRank,
      field: clean(row.field),
      topic: clean(row.topic || ''),
      article_type: clean(row.article_type),
      year,
      source_id: clean(row.source_id || ''),
    };
  });
}

function tokens(paper) {
  return `${paper.title} ${paper.abstract}`
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 1 && !STOPWORDS.has(token)) || [];
}

function tfidfVectors(papers) {
  const tokenLists = papers.map(tokens);
  const documentFrequency = new Map();
  for (const list of tokenLists) {
    for (const token of new Set(list)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  return tokenLists.map((list) => {
    const counts = new Map();
    for (const token of list) counts.set(token, (counts.get(token) || 0) + 1);
    const vector = new Map();
    let squaredNorm = 0;
    for (const [token, count] of counts) {
      const value = (1 + Math.log(count)) * (Math.log((papers.length + 1) / ((documentFrequency.get(token) || 0) + 1)) + 1);
      vector.set(token, value);
      squaredNorm += value * value;
    }
    return { values: vector, norm: Math.sqrt(squaredNorm) };
  });
}

function cosine(left, right) {
  if (!left.norm || !right.norm) return 0;
  const [small, large] = left.values.size <= right.values.size
    ? [left.values, right.values]
    : [right.values, left.values];
  let dot = 0;
  for (const [token, value] of small) dot += value * (large.get(token) || 0);
  return dot / (left.norm * right.norm);
}

function blindId(seed, paperId) {
  return `paper-${stableHash(`${seed}:paper:${paperId}`).slice(0, 16)}`;
}

function difficulty(tierGap) {
  if (tierGap === 1) return 'adjacent';
  if (tierGap === 2) return 'moderate';
  return 'wide';
}

export function preparePairs(inputRows, options = {}) {
  const papers = normalizePapers(inputRows);
  const seed = String(options.seed ?? '42');
  const maxYearGap = Number(options.maxYearGap ?? 2);
  const minSimilarity = Number(options.minSimilarity ?? 0);
  const maxPairs = Number(options.maxPairs ?? Number.POSITIVE_INFINITY);
  const maxUsesPerPaper = Number(options.maxUsesPerPaper ?? 1);
  if (!Number.isInteger(maxUsesPerPaper) || maxUsesPerPaper < 1) throw new Error('maxUsesPerPaper must be a positive integer.');
  const vectors = tfidfVectors(papers);
  const candidates = [];
  for (let left = 0; left < papers.length; left += 1) {
    for (let right = left + 1; right < papers.length; right += 1) {
      const first = papers[left];
      const second = papers[right];
      if (first.tier_rank === second.tier_rank) continue;
      if (first.field !== second.field || first.article_type !== second.article_type) continue;
      if (first.topic && second.topic && first.topic !== second.topic) continue;
      if (Math.abs(first.year - second.year) > maxYearGap) continue;
      const similarity = cosine(vectors[left], vectors[right]);
      if (similarity < minSimilarity) continue;
      const high = first.tier_rank < second.tier_rank ? first : second;
      const low = high === first ? second : first;
      candidates.push({
        high,
        low,
        similarity,
        tier_gap: low.tier_rank - high.tier_rank,
        stratum: `${high.field}|${high.topic || low.topic || 'unspecified'}`,
        tie_breaker: stableHash(`${seed}:${high.paper_id}:${low.paper_id}`),
      });
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity
    || a.tier_gap - b.tier_gap
    || a.tie_breaker.localeCompare(b.tie_breaker));

  const uses = new Map();
  const selected = [];
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.stratum)) groups.set(candidate.stratum, []);
    groups.get(candidate.stratum).push(candidate);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => stableHash(`${seed}:${a}`).localeCompare(stableHash(`${seed}:${b}`)));
  while (selected.length < maxPairs) {
    let added = false;
    for (const key of groupKeys) {
      const group = groups.get(key);
      let candidateIndex = -1;
      let candidatePriority = null;
      for (let index = 0; index < group.length; index += 1) {
        const next = group[index];
        const highUses = uses.get(next.high.paper_id) || 0;
        const lowUses = uses.get(next.low.paper_id) || 0;
        if (highUses >= maxUsesPerPaper || lowUses >= maxUsesPerPaper) continue;
        const priority = [Math.max(highUses, lowUses), highUses + lowUses, -next.similarity];
        if (!candidatePriority || priority.some((value, part) => (
          value < candidatePriority[part]
          && priority.slice(0, part).every((earlier, earlierPart) => earlier === candidatePriority[earlierPart])
        ))) {
          candidateIndex = index;
          candidatePriority = priority;
        }
      }
      const candidate = candidateIndex >= 0 ? group.splice(candidateIndex, 1)[0] : null;
      if (!candidate) continue;
      uses.set(candidate.high.paper_id, (uses.get(candidate.high.paper_id) || 0) + 1);
      uses.set(candidate.low.paper_id, (uses.get(candidate.low.paper_id) || 0) + 1);
      selected.push(candidate);
      added = true;
      if (selected.length >= maxPairs) break;
    }
    if (!added) break;
  }
  if (!selected.length) throw new Error('No eligible cross-tier pairs were found.');

  const privatePairs = [];
  const blindPaperById = new Map();
  const orientedSelected = [...selected].sort((a, b) => a.tie_breaker.localeCompare(b.tie_breaker));
  for (const [pairIndex, candidate] of orientedSelected.entries()) {
    const highBlindId = blindId(seed, candidate.high.paper_id);
    const lowBlindId = blindId(seed, candidate.low.paper_id);
    const swap = pairIndex % 2 === 1;
    const a = swap ? candidate.low : candidate.high;
    const b = swap ? candidate.high : candidate.low;
    const aBlindId = swap ? lowBlindId : highBlindId;
    const bBlindId = swap ? highBlindId : lowBlindId;
    const pairId = `pair-${stableHash(`${seed}:${candidate.high.paper_id}:${candidate.low.paper_id}`).slice(0, 12)}`;
    for (const [paper, id] of [[a, aBlindId], [b, bBlindId]]) {
      blindPaperById.set(id, { paper_id: id, title: paper.title, abstract: paper.abstract });
    }
    privatePairs.push({
      pair_id: pairId,
      field: candidate.high.field,
      topic: candidate.high.topic || candidate.low.topic || null,
      article_type: candidate.high.article_type,
      year_gap: Math.abs(candidate.high.year - candidate.low.year),
      tier_gap: candidate.tier_gap,
      difficulty: difficulty(candidate.tier_gap),
      topic_similarity: Number(candidate.similarity.toFixed(6)),
      a_id: aBlindId,
      b_id: bBlindId,
      expected_venue_winner: swap ? 'B' : 'A',
      high_tier: {
        original_paper_id: candidate.high.paper_id,
        venue: candidate.high.venue,
        venue_tier: candidate.high.venue_tier,
        tier_rank: candidate.high.tier_rank,
        year: candidate.high.year,
        blind_id: highBlindId,
      },
      lower_tier: {
        original_paper_id: candidate.low.paper_id,
        venue: candidate.low.venue,
        venue_tier: candidate.low.venue_tier,
        tier_rank: candidate.low.tier_rank,
        year: candidate.low.year,
        blind_id: lowBlindId,
      },
    });
  }
  privatePairs.sort((a, b) => a.pair_id.localeCompare(b.pair_id));
  const blindPapers = [...blindPaperById.values()].sort((a, b) => a.paper_id.localeCompare(b.paper_id));
  const pairedDataset = privatePairs.map((pair) => ({
    dataset_schema_version: '1.0.0',
    pair_id: pair.pair_id,
    field: pair.field,
    topic: pair.topic,
    article_type: pair.article_type,
    year_gap: pair.year_gap,
    tier_gap: pair.tier_gap,
    difficulty: pair.difficulty,
    topic_similarity: pair.topic_similarity,
    paper_a: blindPaperById.get(pair.a_id),
    paper_b: blindPaperById.get(pair.b_id),
    label: pair.expected_venue_winner,
    label_source: 'venue_tier_weak_label',
  }));
  const countBy = (values) => Object.fromEntries([...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)))
    .map((value) => [value, values.filter((item) => item === value).length]));
  const similarities = pairedDataset.map((pair) => pair.topic_similarity).sort((a, b) => a - b);
  const similarityAt = (fraction) => similarities[Math.round((similarities.length - 1) * fraction)];
  return {
    privatePairs,
    blindPapers,
    pairedDataset,
    manifest: {
      schema_version: '1.0.0',
      seed,
      input_papers: papers.length,
      eligible_candidates: candidates.length,
      selected_pairs: privatePairs.length,
      selected_unique_papers: blindPapers.length,
      max_uses_per_paper: maxUsesPerPaper,
      observed_max_uses_per_paper: Math.max(...uses.values()),
      paper_use_distribution: countBy([...uses.values()]),
      paired_dataset_file: 'pairs.dataset.jsonl',
      pair_statistics: {
        labels: countBy(pairedDataset.map((pair) => pair.label)),
        topics: countBy(pairedDataset.map((pair) => pair.topic)),
        year_gaps: countBy(pairedDataset.map((pair) => pair.year_gap)),
        difficulties: countBy(pairedDataset.map((pair) => pair.difficulty)),
        topic_similarity: {
          minimum: similarityAt(0),
          median: similarityAt(0.5),
          p90: similarityAt(0.9),
          maximum: similarityAt(1),
        },
      },
      matching: { same_field: true, same_article_type: true, same_topic_when_present: true, max_year_gap: maxYearGap, min_tfidf_cosine: minSimilarity },
      score_input_fields: ['paper_id', 'title', 'abstract'],
      private_fields_excluded_from_scoring: ['original_paper_id', 'venue', 'venue_tier', 'tier_rank', 'year', 'field', 'topic', 'source_id'],
    },
  };
}

function scoreValue(row) {
  const value = row.raw_score ?? row.score;
  if (!Number.isFinite(Number(value))) throw new Error(`Missing numeric score for ${row.paper_id}.`);
  return Number(value);
}

export function modelOutcome(pair, scoreById, tieThreshold = 0) {
  const a = scoreValue(scoreById.get(pair.a_id) || {});
  const b = scoreValue(scoreById.get(pair.b_id) || {});
  const delta = a - b;
  const winner = Math.abs(delta) <= tieThreshold ? 'tie' : delta > 0 ? 'A' : 'B';
  const outcome = winner === 'tie' ? 'tie' : winner === pair.expected_venue_winner ? 'correct' : 'incorrect';
  return { a_score: a, b_score: b, score_delta_a_minus_b: delta, winner, outcome };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 4) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function wilson(successes, total, z = 1.959964) {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total) / denominator;
  return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))];
}

function pairMetrics(rows) {
  if (!rows.length) return { pairs: 0, ties: 0, non_tie_accuracy: null, tie_half_accuracy: null };
  const ties = rows.filter((row) => row.model.winner === 'tie').length;
  const correct = rows.filter((row) => row.model.outcome === 'correct').length;
  const nonTies = rows.length - ties;
  return {
    pairs: rows.length,
    ties,
    tie_rate: round(ties / rows.length),
    non_tie_accuracy: round(correct / nonTies),
    non_tie_accuracy_95ci_wilson: wilson(correct, nonTies),
    tie_half_accuracy: round((correct + 0.5 * ties) / rows.length),
    mean_high_minus_lower_score: round(mean(rows.map((row) => row.highMinusLow))),
  };
}

export function evaluate(privatePairs, scoreRows, options = {}) {
  const tieThreshold = Number(options.tieThreshold ?? 0);
  const scoreById = new Map(scoreRows.map((row) => [String(row.paper_id), row]));
  const evaluated = privatePairs.map((pair) => {
    const model = modelOutcome(pair, scoreById, tieThreshold);
    const highMinusLow = pair.expected_venue_winner === 'A'
      ? model.a_score - model.b_score
      : model.b_score - model.a_score;
    return { pair, model, highMinusLow };
  });
  const groupBy = (field) => Object.fromEntries([...new Set(evaluated.map((row) => row.pair[field]))]
    .sort().map((value) => [value, pairMetrics(evaluated.filter((row) => row.pair[field] === value))]));

  return {
    schema_version: '1.0.0',
    interpretation: 'Venue tiers are weak labels; scores are experimental comparative signals, not acceptance probabilities.',
    venue_weak_label: {
      overall: pairMetrics(evaluated),
      by_field: groupBy('field'),
      by_difficulty: groupBy('difficulty'),
    },
  };
}
