'use strict';

function scoreId(value) {
  return String(value == null ? '' : value).trim();
}

function stringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim());
}

function normalizedStrings(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(item => String(item).trim()).filter(Boolean))).sort();
}

function sameStrings(left, right) {
  return JSON.stringify(normalizedStrings(left)) === JSON.stringify(normalizedStrings(right));
}

function normalizedGapText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasValidRawScoreSchema(row) {
  if (!row || typeof row !== 'object' || typeof row.score !== 'number' ||
      !Number.isFinite(row.score) || row.score < 0 || row.score > 100) return false;
  if (!stringArray(row.matchEvidence) || !Array.isArray(row.gapDetails) || !stringArray(row.conflicts)) return false;
  if (typeof row.confidence !== 'string' || !/^(?:high|medium|low)$/i.test(row.confidence.trim())) return false;
  if (!row.transferability || typeof row.transferability !== 'object' ||
      typeof row.transferability.level !== 'string' ||
      !/^(?:direct|adjacent|stretch)$/i.test(row.transferability.level.trim()) ||
      typeof row.transferability.rationale !== 'string' || !row.transferability.rationale.trim()) return false;
  const seenGapTexts = new Set();
  for (const gap of row.gapDetails) {
    if (!gap || typeof gap !== 'object' || typeof gap.text !== 'string' || !gap.text.trim() ||
        typeof gap.severity !== 'string' ||
        !/^(?:material|trainable|preferred)$/i.test(gap.severity.trim()) ||
        typeof gap.basis !== 'string' ||
        !/^(?:required|preferred|unclear)$/i.test(gap.basis.trim())) return false;
    const gapText = normalizedGapText(gap.text);
    if (seenGapTexts.has(gapText)) return false;
    seenGapTexts.add(gapText);
  }
  const gapTexts = row.gapDetails.map(gap => gap.text);
  const severityTexts = severity => row.gapDetails
    .filter(gap => gap.severity.toLowerCase() === severity).map(gap => gap.text);
  const optionalGapArrays = [
    ['gaps', gapTexts],
    ['materialGaps', severityTexts('material')],
    ['trainableGaps', severityTexts('trainable')],
    ['preferredGaps', severityTexts('preferred')],
  ];
  for (const [key, expected] of optionalGapArrays) {
    if (Object.prototype.hasOwnProperty.call(row, key) &&
        (!stringArray(row[key]) || !sameStrings(row[key], expected))) return false;
  }
  return true;
}

// A model response is useful only when it names one of the exact requested jobs. Preserve request
// ordering, accept the first row for each ID, and keep missing IDs explicit so unrelated or
// duplicated rows can never make a chunk appear complete.
function selectRequestedScoreRows(batch, scores) {
  const requestedIds = [];
  const requested = new Set();
  for (const job of Array.isArray(batch) ? batch : []) {
    const id = scoreId(job && job.id);
    if (!id || requested.has(id)) continue;
    requested.add(id);
    requestedIds.push(id);
  }
  const byId = new Map();
  const invalidIds = [];
  for (const row of Array.isArray(scores) ? scores : []) {
    const id = scoreId(row && row.id);
    if (!id || !requested.has(id) || byId.has(id)) continue;
    if (!hasValidRawScoreSchema(row)) { if (!invalidIds.includes(id)) invalidIds.push(id); continue; }
    byId.set(id, row);
  }
  const rows = requestedIds.filter(id => byId.has(id)).map(id => byId.get(id));
  const missingIds = requestedIds.filter(id => !byId.has(id));
  return { rows, missingIds, invalidIds: invalidIds.filter(id => !byId.has(id)), requestedCount: requestedIds.length,
    complete: requestedIds.length > 0 && missingIds.length === 0 };
}

function attachPartialRows(error, batch, acceptedRows) {
  const partialRows = selectRequestedScoreRows(batch, acceptedRows).rows;
  const source = error && typeof error === 'object' ? error : new Error(String(error || 'score chunk failed'));
  try {
    Object.defineProperty(source, 'partialRows', {
      value: partialRows, configurable: true, writable: true, enumerable: false,
    });
  } catch (_) {}
  if (source.partialRows === partialRows) return source;
  const wrapped = new Error(String(source.message || 'score chunk failed'));
  for (const key of ['code', 'reason', 'retryable', 'engine']) {
    if (source[key] != null) wrapped[key] = source[key];
  }
  Object.defineProperty(wrapped, 'partialRows', {
    value: partialRows, configurable: true, writable: true, enumerable: false,
  });
  return wrapped;
}

function partialRowsFromError(batch, error) {
  return selectRequestedScoreRows(batch, error && error.partialRows).rows;
}

async function scoreJobChunkWithRetry(batch, chunkIndex, options = {}) {
  if (typeof options.scoreChunk !== 'function') throw new Error('scoreChunk function required');
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  const wait = typeof options.wait === 'function'
    ? options.wait : ms => new Promise(resolve => setTimeout(resolve, ms));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let lastError = null;
  const accepted = new Map();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const selected = selectRequestedScoreRows(batch, await options.scoreChunk(batch));
      for (const row of selected.rows) if (!accepted.has(scoreId(row.id))) accepted.set(scoreId(row.id), row);
      const accumulated = selectRequestedScoreRows(batch, [...accepted.values()]);
      if (accumulated.complete) return accumulated.rows;
      if (accumulated.rows.length && attempt === maxAttempts) return accumulated.rows;
      lastError = new Error(`partial score result ${accumulated.rows.length}/${accumulated.requestedCount}`);
    } catch (error) {
      lastError = error;
    }
    if (lastError && lastError.retryable === false) {
      throw attachPartialRows(lastError, batch, [...accepted.values()]);
    }
    if (attempt >= maxAttempts) break;
    const waitMs = 750 * attempt + Math.floor(random() * 250);
    log(`[PJA] chunk ${Number(chunkIndex) + 1} score attempt ${attempt}/${maxAttempts} failed: ${lastError && lastError.message}; retrying in ${waitMs}ms`);
    await wait(waitMs);
  }
  const accumulated = selectRequestedScoreRows(batch, [...accepted.values()]);
  if (accumulated.rows.length) return accumulated.rows;
  throw lastError || new Error('score chunk failed');
}

module.exports = { scoreId, stringArray, hasValidRawScoreSchema,
  selectRequestedScoreRows, attachPartialRows, partialRowsFromError, scoreJobChunkWithRetry };
