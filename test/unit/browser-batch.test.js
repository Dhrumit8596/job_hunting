'use strict';

const Batch = require('../../browser-batch');

module.exports = async t => {
  const jobs = [{ id: '1', sourcePlatform: 'linkedin', title: 'Process Engineer', query: 'process engineer' }];
  const id = Batch.batchId({ source: 'linkedin', query: 'process engineer', page: 2, sequence: 1, jobs });
  t.eq(id, Batch.batchId({ source: 'linkedin', query: 'process engineer', page: 2, sequence: 1, jobs }),
    'browser batch: stable source/query/page/sequence/job identity produces stable batchId');
  let calls = 0;
  const retried = await Batch.sendAcknowledged(async envelope => {
    calls++; return calls === 1 ? undefined : { acknowledged: true, batchId: envelope.batchId };
  }, { batchId: id }, { attempts: 3 });
  t.eq({ ok: retried.ok, attempts: retried.attempts, calls }, { ok: true, attempts: 2, calls: 2 },
    'browser batch: first timeout remains unacknowledged and succeeds only after bounded retry');
  const mismatched = await Batch.sendAcknowledged(async () => ({ acknowledged: true, batchId: 'wrong' }),
    { batchId: id }, { attempts: 2 });
  t.eq({ ok: mismatched.ok, reason: mismatched.reason }, { ok: false, reason: 'batch_id_mismatch' },
    'browser batch: mismatched response batchId is never success');
  const exhausted = await Batch.sendAcknowledged(async () => undefined, { batchId: id }, { attempts: 2 });
  t.eq({ ok: exhausted.ok, attempts: exhausted.attempts, reason: exhausted.reason },
    { ok: false, attempts: 2, reason: 'persistence_timeout' },
  'browser batch: exhausted retries terminalize persistence failure');
  const invalidated = await Batch.sendAcknowledged(async () => { throw new Error('Extension context invalidated.'); },
    { batchId: id }, { attempts: 3 });
  t.eq({ ok: invalidated.ok, reason: invalidated.reason },
    { ok: false, reason: 'extension_context_invalidated' },
  'browser batch: extension invalidation is an explicit terminal reason');
  const ownershipRejected = await Batch.sendAcknowledged(async envelope => ({ acknowledged: false,
    batchId: envelope.batchId, reason: 'source_ownership_lost' }), { batchId: id }, { attempts: 2 });
  t.eq({ ok: ownershipRejected.ok, reason: ownershipRejected.reason },
    { ok: false, reason: 'source_ownership_lost' },
  'browser batch: ownership rejection never acknowledges or permits a late shortlist mutation');

  const partial = Batch.mergeBatch([], [{ id: '1', sourcePlatform: 'linkedin', title: 'Process Engineer' },
    { id: '2', sourcePlatform: 'linkedin', title: 'Software Engineer' }], {
    source: 'linkedin', observedAt: 200, accept: job => /process/i.test(job.title) ? true : 'unsupported_role_family',
  });
  t.eq(partial.counts, { received: 2, accepted: 1, inserted: 1, enriched: 0, refreshed: 0,
    filtered: 1, rejected: 1, rejectionCounts: { unsupported_role_family: 1 } },
  'browser batch: acknowledgement exposes partial acceptance and rejection reason counts');
  const duplicateDelivery = Batch.mergeBatch(partial.list, [partial.list[0]], {
    source: 'linkedin', observedAt: 300, accept: () => true });
  t.eq({ rows: duplicateDelivery.list.length, inserted: duplicateDelivery.counts.inserted,
    refreshed: duplicateDelivery.counts.refreshed }, { rows: 1, inserted: 0, refreshed: 1 },
  'browser batch: idempotent stable job identity cannot create a duplicate row');
  const crossSource = Batch.mergeBatch(partial.list, [{ id: '1', sourcePlatform: 'indeed', title: 'Process Engineer' }],
    { source: 'indeed', observedAt: 300, accept: () => true });
  t.eq(crossSource.list.length, 2, 'browser batch: stable identity is namespaced by source');

  const hydrated = { id: '7', sourcePlatform: 'linkedin', title: 'Quality Engineer',
    description: 'Validated quality systems and root-cause requirements.', descriptionStatus: 'full',
    fitScore: 82, scoreKind: 'llm', candidateFingerprint: 'candidate', descriptionFingerprint: 'jd',
    firstDiscoveredAt: 100, discoveredAt: 100, lastSeenAt: 100, matchedQueries: ['quality engineer'] };
  const refreshed = Batch.mergeRecord(hydrated, { id: '7', sourcePlatform: 'linkedin',
    title: 'Quality Engineer', description: '', descriptionStatus: 'missing',
    query: 'manufacturing quality engineer', sourcePage: 2, discoveredAt: 400 }, { observedAt: 400 }).record;
  t.eq({ first: refreshed.firstDiscoveredAt, discovered: refreshed.discoveredAt, seen: refreshed.lastSeenAt,
    description: refreshed.description, fit: refreshed.fitScore, scoreKind: refreshed.scoreKind },
  { first: 100, discovered: 100, seen: 400,
    description: hydrated.description, fit: 82, scoreKind: 'llm' },
  'browser freshness: rediscovery refreshes lastSeenAt while preserving original date, JD, and valid score');
  t.eq(refreshed.matchedQueries, ['quality engineer', 'manufacturing quality engineer'],
    'browser freshness: rediscovery merges query attribution');
  const backedOff = Batch.mergeRecord(hydrated, { ...hydrated,
    routeResolutionStatus: 'unresolved', routeResolutionReason: 'voyager_no_destination',
    routeResolutionAttempts: 1, routeResolutionAttemptedAt: 450,
    hydrationAttempts: 1, hydrationAttemptedAt: 450 }, { observedAt: 450 }).record;
  t.eq({ status: backedOff.routeResolutionStatus, reason: backedOff.routeResolutionReason,
    routeAttempts: backedOff.routeResolutionAttempts, hydrationAttempts: backedOff.hydrationAttempts },
  { status: 'unresolved', reason: 'voyager_no_destination', routeAttempts: 1, hydrationAttempts: 1 },
  'browser enrichment: an acknowledged null result persists cooldown metadata without erasing a valid JD or score');
  const identityCollision = Batch.mergeRouteInspection([
    { id: 'shared-1', sourcePlatform: 'linkedin', routeLandingAttempts: 0 },
    { id: 'shared-1', sourcePlatform: 'glassdoor', routeLandingAttempts: 0 },
  ], [{ id: 'shared-1', status: 'no_explicit_route_evidence', reason: 'no_route', attemptedAt: 500 }]);
  t.eq(identityCollision.list.map(row => ({ platform: row.sourcePlatform,
    status: row.routeLandingStatus || '', attempts: row.routeLandingAttempts })), [
    { platform: 'linkedin', status: 'no_explicit_route_evidence', attempts: 1 },
    { platform: 'glassdoor', status: '', attempts: 0 },
  ], 'browser route persistence: a raw ID collision mutates only the LinkedIn-owned record');
  const newlyHydrated = Batch.mergeRecord({ id: '8', sourcePlatform: 'linkedin', title: 'Process Engineer',
    description: '', descriptionStatus: 'missing', fitScore: 74, scoreKind: 'heuristic' },
  { id: '8', sourcePlatform: 'linkedin', title: 'Process Engineer',
    description: 'New validated requirements.', descriptionStatus: 'full' }, { observedAt: 500 }).record;
  t.eq({ description: newlyHydrated.description, fit: newlyHydrated.fitScore, scoreKind: newlyHydrated.scoreKind },
    { description: 'New validated requirements.', fit: undefined, scoreKind: undefined },
  'browser hydration: newly acquired JD invalidates old scoring fields before evidence scoring');

  const useful1 = { page: 1, stableIds: 25, deterministicAccepted: 12, inserted: 8,
    enriched: 0, directRoutes: 4, duplicates: 1 };
  const useful2 = { page: 2, stableIds: 25, deterministicAccepted: 10, inserted: 7,
    enriched: 0, directRoutes: 3, duplicates: 3 };
  t.eq(Batch.pageContinuationDecision(useful1, [], { maxPages: 3, remainingMs: 90000 }).continue, true,
    'adaptive pages: useful page one continues');
  t.eq(Batch.pageContinuationDecision(useful2, [useful1], { maxPages: 3, remainingMs: 60000 }).continue, true,
    'adaptive pages: useful page two permits a three-page LinkedIn query');
  t.eq(Batch.pageContinuationDecision({ page: 1, stableIds: 20, deterministicAccepted: 2,
    inserted: 0, enriched: 0 }, [], { maxPages: 3, remainingMs: 90000 }).reason, 'zero_new_persisted',
  'adaptive pages: zero persisted yield stops early');
  t.eq(Batch.pageContinuationDecision({ ...useful2, page: 2 }, [useful1],
    { maxPages: 3, remainingMs: 4000 }).reason, 'deadline_reserve',
  'adaptive pages: deadline reserve stops before page three');
  t.eq(Batch.pageContinuationDecision({ ...useful1, persistenceFailed: true }, [],
    { maxPages: 3, remainingMs: 90000 }).reason, 'persistence_failed',
  'adaptive pages: an eligible unacknowledged batch prevents done/continuation');
  t.eq(Batch.pageContinuationDecision(useful1, [], { maxPages: 3, remainingMs: 90000,
    ownershipOk: false }).reason, 'source_ownership_lost',
  'adaptive pages: ownership loss stops the current query before another page');
  t.eq(Batch.resultIdsChanged(['1', '2'], ['1', '2']), false,
    'LinkedIn pagination: a Next click with unchanged result IDs is not advancement');
  t.eq(Batch.resultIdsChanged(['1', '2'], ['3', '4']), true,
    'LinkedIn pagination: changed stable IDs prove navigation');
};
