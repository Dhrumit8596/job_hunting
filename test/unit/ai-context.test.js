'use strict';

module.exports = t => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/ai-context.js'), 'utf8');
  for (const scope of ['overview', 'apply', 'sourcing', 'ai', 'storage', 'logs', 'ui']) {
    t.ok(new RegExp(`\\b${scope}: \\{`).test(src), `AI context: ${scope} scope is present`);
  }
  t.ok(src.includes('Read only these first'), 'AI context: command explicitly guides bounded reading');
};
