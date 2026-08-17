'use strict';

const http = require('http');
const Client = require('../../local-json-client');

module.exports = async t => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/slow') {
        setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }, 50);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, body: JSON.parse(body || '{}') }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await Client.postJson({ port, pathname: '/echo', body: { runId: 'apply-1' }, timeoutMs: 1000 });
    t.ok(response.ok, 'local JSON client: successful response is returned');
    t.eq(response.data.body.runId, 'apply-1', 'local JSON client: request body remains structured JSON');
    let timeout = null;
    try { await Client.postJson({ port, pathname: '/slow', body: {}, timeoutMs: 10 }); }
    catch (e) { timeout = e; }
    t.eq(timeout && timeout.code, 'PJA_LOCAL_HTTP_TIMEOUT', 'local JSON client: configured timeout has a stable code');
    t.ok(/\/slow/.test(timeout && timeout.message || ''), 'local JSON client: timeout identifies the failing endpoint');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};
