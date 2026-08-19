'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function devProtocolHarness(devSource, wsAsk) {
  const start = devSource.indexOf('function exactCommittedCorpusImportReceipt');
  const end = devSource.indexOf('\nfunction compactReportJob', start);
  if (start < 0 || end < 0) throw new Error('dev corpus-import helpers not found');
  const SourceSafety = {
    sourceError(code, message, statusCode) {
      const error = new Error(message || code);
      error.code = code;
      error.statusCode = statusCode;
      return error;
    },
  };
  return new Function('wsAsk', 'SourceSafety', 'setTimeout',
    `${devSource.slice(start, end)}\nreturn { exactCommittedCorpusImportReceipt, resolveCorpusImportReply };`
  )(wsAsk, SourceSafety, callback => { callback(); return 1; });
}

function backgroundProtocolHarness(backgroundSource, options = {}) {
  const start = backgroundSource.indexOf('function pjaExactCorpusImportReceipt');
  const end = backgroundSource.indexOf('\nif (DEV_MODE)', start);
  if (start < 0 || end < 0) throw new Error('background corpus-import helpers not found');
  const ownershipReads = [];
  const self = {
    PJAIdb: {
      getImportReceipt: options.getImportReceipt || (async () => null),
    },
    PJASourceSafety: {
      sourceDecision(input) {
        ownershipReads.push(input);
        const owned = !input.runId || input.controlObserved === true && input.control &&
          input.control.runId === input.runId && input.control.status === 'planning' &&
          input.control.phase === 'sourcing';
        return owned ? { ok: true } : { ok: false, code: 'source_ownership_lost' };
      },
      assertSourceDecision(decision) {
        if (!decision.ok) {
          const error = new Error(decision.code);
          error.code = decision.code;
          throw error;
        }
        return decision;
      },
    },
  };
  const chrome = { storage: { local: { get(_key, callback) {
    callback({ pja_apply_run_control: { runId: 'run-1', status: 'planning', phase: 'sourcing' } });
  } } } };
  const api = new Function('self', 'chrome', 'pjaIngestCorpus',
    `${backgroundSource.slice(start, end)}\nreturn { pjaRunCorpusImport };`
  )(self, chrome, options.pjaIngestCorpus);
  return { ...api, ownershipReads };
}

module.exports = async t => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const dev = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
  const receipt = { importId: 'corpus-run-1', runId: 'run-1', committed: true,
    imported: 12, incoming: 12, retired: 2, total: 40, committedAt: 1234 };

  let observerCalls = 0;
  const direct = devProtocolHarness(dev, async () => { observerCalls += 1; return {}; });
  const directResult = await direct.resolveCorpusImportReply({ ok: true, receipt, added: 2 },
    receipt.importId, receipt.runId);
  t.ok(directResult.receipt === receipt && directResult.reconciled === false && observerCalls === 0,
    'corpus import protocol: an exact committed direct receipt is accepted without another observation');
  t.eq(direct.exactCommittedCorpusImportReceipt({ receipt: { ...receipt, committed: false } },
    receipt.importId, receipt.runId), null,
  'corpus import protocol: an uncommitted receipt cannot prove success');
  t.eq(direct.exactCommittedCorpusImportReceipt({ receipt }, 'another-import', receipt.runId), null,
    'corpus import protocol: a receipt for another import cannot prove success');
  t.eq(direct.exactCommittedCorpusImportReceipt({ receipt }, receipt.importId, 'another-run'), null,
    'corpus import protocol: an owned import requires the exact run identity');

  const observedCommands = [];
  const reconciler = devProtocolHarness(dev, async (cmd, payload, replyCmd) => {
    observedCommands.push({ cmd, payload, replyCmd });
    return { ok: true, importId: receipt.importId, receipt };
  });
  const reconciled = await reconciler.resolveCorpusImportReply({ error: 'timeout' },
    receipt.importId, receipt.runId);
  t.ok(reconciled.reconciled === true && reconciled.receipt === receipt &&
    observedCommands.length === 1 && observedCommands[0].cmd === 'getCorpusImportReceipt' &&
    observedCommands[0].payload.importId === receipt.importId,
  'corpus import protocol: a mutation timeout observes only the exact durable receipt instead of resending');

  let unavailableCalls = 0;
  const unavailableHarness = devProtocolHarness(dev, async () => {
    unavailableCalls += 1;
    return { ok: true, receipt: null };
  });
  let unavailable = null;
  try {
    await unavailableHarness.resolveCorpusImportReply({ error: 'no extension connected' },
      receipt.importId, receipt.runId);
  } catch (error) { unavailable = error; }
  t.ok(unavailable && unavailable.code === 'corpus_import_state_unavailable' &&
    unavailable.statusCode === 503 && unavailable.retryable === true &&
    unavailable.retryScope === 'receipt_observation' && unavailable.resubmit === false && unavailableCalls === 3,
  'corpus import protocol: unresolved transport ambiguity is retryable only as observation and forbids resubmission');

  let ingestCalls = 0;
  let capturedOptions = null;
  const backgroundHarness = backgroundProtocolHarness(background, {
    async pjaIngestCorpus(_index, _state, importOptions) {
      ingestCalls += 1;
      capturedOptions = importOptions;
      await importOptions.beforeCommit();
      return { receipt };
    },
  });
  const message = { importId: receipt.importId, runId: receipt.runId, deadlineMs: Date.now() + 10000,
    index: { one: {} }, state: { one: {} } };
  const [first, joined] = await Promise.all([
    backgroundHarness.pjaRunCorpusImport(message),
    backgroundHarness.pjaRunCorpusImport({ ...message }),
  ]);
  t.ok(first.receipt === receipt && joined.receipt === receipt && ingestCalls === 1,
    'corpus import protocol: duplicate requests with the same identity join one background mutation');
  t.ok(capturedOptions && capturedOptions.importId === receipt.importId &&
    capturedOptions.runId === receipt.runId && typeof capturedOptions.beforeCommit === 'function' &&
    backgroundHarness.ownershipReads.length === 2,
  'corpus import protocol: IDB receives exact identities and rechecks durable ownership immediately before commit');

  const sourceRoute = dev.slice(dev.indexOf("req.url === '/source-v2'"),
    dev.indexOf("req.url === '/supply-audit'"));
  t.eq((sourceRoute.match(/wsAsk\('importCorpus'/g) || []).length, 1,
    'corpus import protocol: source-v2 has exactly one corpus mutation send path');
  t.ok(sourceRoute.includes('resolveCorpusImportReply(importReply, sourceImportId') &&
    sourceRoute.includes('resubmit: e.resubmit === true') &&
    background.includes("msg.cmd === 'getCorpusImportReceipt'") &&
    background.includes("cmd: 'corpusImportReceiptReply'"),
  'corpus import protocol: timeout handling is exact-receipt reconciliation with an explicit no-resubmit result');

  const auditRoute = dev.slice(dev.indexOf("req.url === '/supply-audit'"),
    dev.indexOf("req.url === '/apply-run'"));
  t.ok(auditRoute.includes('if (o.includeAssisted === true) auditOptions.includeAssisted = true') &&
    !auditRoute.includes('includeAssisted: true'),
  'supply audit: assisted routes are included only after an explicit caller opt-in');
};
