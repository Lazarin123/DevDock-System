'use strict';
// API interna + dashboard estático, só em 127.0.0.1, com token anti-CSRF e checagem de Host (anti DNS-rebinding).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('./os');

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 10_000) { reject(new Error('Body grande demais')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON inválido')); } });
});

function createServer({ port = 7777 } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace('__TOKEN__', token);
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = http.createServer(async (req, res) => {
    try {
      if (!okHosts.has(req.headers.host)) return send(res, 403, { error: 'Host não permitido' });
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/state') {
        const [ports, docker] = await Promise.all([os.listPorts(), os.dockerList()]);
        return send(res, 200, { ports, docker, platform: process.platform, at: Date.now() });
      }
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        if (req.headers['x-devdock-token'] !== token) return send(res, 401, { error: 'Token inválido, recarregue a página' });
        const b = await readBody(req);
        if (pathname === '/api/kill') return send(res, 200, { result: await os.killPid(b.pid, !!b.force) });
        if (pathname === '/api/restart') return send(res, 200, { result: await os.restartPid(b.pid) });
        if (pathname === '/api/docker') return send(res, 200, { result: await os.dockerAction(String(b.id), String(b.action)) });
      }
      send(res, 404, { error: 'Não encontrado' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  return { server, token, url: `http://127.0.0.1:${port}` };
}
module.exports = { createServer };
