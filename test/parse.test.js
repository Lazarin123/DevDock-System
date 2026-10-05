'use strict';
const assert = require('node:assert');
const { parseSS, parseLsof, parseNetstat, kindOf } = require('../src/os');
const { parse } = require('../src/args');

const ss = parseSS('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=19))\nLISTEN 0 128 [::]:5432 [::]:*\n');
assert.deepStrictEqual(ss.map((r) => [r.port, r.pid, r.name]), [[3000, 1234, 'node'], [5432, null, '?']]);

const lsof = parseLsof('p77\ncnode\nn*:5173\nn[::1]:5173\n');
assert.strictEqual(lsof.length, 2); assert.strictEqual(lsof[0].pid, 77);

const ns = parseNetstat('  TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    4242\n  TCP    [::]:80    [::]:0    LISTENING    4\n');
assert.deepStrictEqual(ns.map((r) => [r.port, r.pid]), [[8080, 4242], [80, 4]]);

assert.strictEqual(kindOf('node', 'node server.js'), 'node');
assert.strictEqual(kindOf('docker-proxy', '/usr/bin/docker-proxy'), 'docker');

const a = parse(['kill', '3000', '-fy', '--port=9', '--pid', '12']);
assert.deepStrictEqual(a._, ['kill', '3000']);
assert.strictEqual(a.flags.force, true); assert.strictEqual(a.flags.yes, true);
assert.strictEqual(a.flags.port, '9'); assert.strictEqual(a.flags.pid, '12');
console.log('✔ todos os testes passaram');
