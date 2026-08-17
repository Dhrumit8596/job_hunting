'use strict';

const http = require('http');

// Node's built-in fetch uses an implicit response-header timeout (commonly five minutes). That is
// shorter than legitimate source + evidence-scoring workflows and previously surfaced only as the
// opaque message "fetch failed". This client owns one explicit timeout from request start through
// response completion and produces endpoint-specific errors.
function postJson(options = {}) {
  const port = Number(options.port);
  const pathname = String(options.pathname || '');
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 300000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('local JSON client requires a valid port'));
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return Promise.reject(new Error('local JSON client requires an absolute path'));
  const payload = JSON.stringify(options.body || {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, resp => {
      let text = '';
      resp.setEncoding('utf8');
      resp.on('data', chunk => { text += chunk; });
      resp.on('end', () => {
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (_) { data = { raw: text }; }
        finish(resolve, { ok: resp.statusCode >= 200 && resp.statusCode < 300,
          status: resp.statusCode || 0, data });
      });
    });
    req.setTimeout(timeoutMs, () => {
      const error = new Error(`local POST ${pathname} timed out after ${timeoutMs}ms`);
      error.code = 'PJA_LOCAL_HTTP_TIMEOUT';
      req.destroy(error);
    });
    req.on('error', error => finish(reject, error));
    req.end(payload);
  });
}

module.exports = { postJson };
