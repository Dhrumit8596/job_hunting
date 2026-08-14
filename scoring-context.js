'use strict';

// Keep job-fit prompts bounded. Job descriptions often repeat benefits, legal boilerplate, and
// company marketing; those sections add model input without improving resume-to-requirement fit.
// Preserve the opening, requirement-bearing lines (plus nearby context), and the closing section.
const DEFAULT_MAX_CHARS = 7000;
const REQUIREMENT_RE = /\b(requirements?|qualifications?|responsibilit(?:y|ies)|what you(?:'|’)ll do|what we(?:'|’)re looking for|minimum|preferred|must have|nice to have|experience|education|degree|skills?|clearance|citizen(?:ship)?|authorization|sponsor(?:ship)?|location|onsite|hybrid|remote)\b/i;

function compactLine(value) {
  return String(value || '').replace(/[ \t]+/g, ' ').trim();
}

function addSection(parts, label, text, remaining) {
  const body = String(text || '').trim();
  if (!body || remaining <= label.length + 2) return remaining;
  const room = Math.max(0, remaining - label.length - 2);
  const slice = body.slice(0, room);
  parts.push(`${label}\n${slice}`);
  return remaining - label.length - slice.length - 2;
}

function scoringExcerpt(description, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(description || '').replace(/\r/g, '').trim();
  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(1000, Math.floor(Number(maxChars)))
    : DEFAULT_MAX_CHARS;
  if (text.length <= limit) return text;

  const lines = text.split(/\n+/).map(compactLine).filter(Boolean);
  const selected = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!REQUIREMENT_RE.test(lines[i])) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j += 1) selected.add(j);
  }
  const relevant = [...selected].sort((a, b) => a - b).map(i => lines[i]).join('\n');

  const openingBudget = Math.min(2200, Math.floor(limit * 0.34));
  const closingBudget = Math.min(1100, Math.floor(limit * 0.17));
  const opening = text.slice(0, openingBudget);
  const closing = text.slice(-closingBudget);
  const parts = [];
  let remaining = limit;
  remaining = addSection(parts, '[POSTING OPENING]', opening, remaining);
  if (relevant) remaining = addSection(parts, '[REQUIREMENT-BEARING EXCERPTS]', relevant, remaining);
  addSection(parts, '[POSTING CLOSING]', closing, remaining);
  return parts.join('\n\n').slice(0, limit);
}

module.exports = { DEFAULT_MAX_CHARS, REQUIREMENT_RE, scoringExcerpt };
