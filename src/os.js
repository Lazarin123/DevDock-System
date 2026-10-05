'use strict';
// Camada de integração com o SO: portas, processos, kill/restart e Docker.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');
const run = promisify(execFile);
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Executa um binário (sem shell). Retorna stdout ou null se falhar/não existir.
async function sh(cmd, args, { lenient = false } = {}) {
  try {
    return (await run(cmd, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout;
  } catch (e) {
    return lenient && e.code !== 'ENOENT' && typeof e.stdout === 'string' ? e.stdout : null;
  }
}

// ---------- parsers (puros, testáveis) ----------
function parseSS(out) { // ss -ltnpH
  const rows = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'LISTEN') continue;
    const m = /\("([^"]+)",pid=(\d+)/.exec(line);
    const i = f[3].lastIndexOf(':');
    rows.push({ port: +f[3].slice(i + 1), address: f[3].slice(0, i), pid: m ? +m[2] : null, name: m ? m[1] : '?' });
  }
  return rows;
}
function parseLsof(out) { // lsof -Fpcn
  const rows = []; let pid = null, name = '?';
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'c') name = line.slice(1);
    else if (line[0] === 'n') {
      const a = line.slice(1), i = a.lastIndexOf(':');
      if (i > -1 && /^\d+$/.test(a.slice(i + 1))) rows.push({ port: +a.slice(i + 1), address: a.slice(0, i), pid, name });
    }
  }
  return rows;
}
function parseNetstat(out) { // netstat -ano -p TCP (Windows)
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (m) rows.push({ port: +m[2], address: m[1], pid: +m[3], name: '?' });
  }
  return rows;
}


// Fallback Linux sem ss/lsof/ps: lê /proc diretamente.
function listenFromProc() {
  const sockets = new Map(); // inode -> porta
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of txt.split('\n').slice(1)) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 10 && p[3] === '0A') sockets.set(p[9], parseInt(p[1].split(':')[1], 16));
    }
  }
  const owner = new Map(); // inode -> {pid,name}
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      for (const fd of fs.readdirSync(`/proc/${d}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${d}/fd/${fd}`));
        if (m && sockets.has(m[1]) && !owner.has(m[1])) owner.set(m[1], { pid: +d, name: fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim() });
      }
    } catch { /* sem permissão: processo de outro usuário */ }
  }
  return [...sockets].map(([inode, port]) => ({ port, address: '*', pid: owner.get(inode)?.pid ?? null, name: owner.get(inode)?.name ?? '?' }));
}
const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
// argv exato (Linux): permite relançar preservando aspas/espaços nos argumentos
function restartCmdFromProc(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).map(shq).join(' ') || null; } catch { return null; }
}
function procFromProc(pids) {
  const map = new Map();
  for (const pid of pids) {
    try { map.set(pid, { uptime: '-', command: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(), restart: restartCmdFromProc(pid) }); } catch { /* sumiu */ }
  }
  return map;
}

// ---------- processos ----------
async function procInfo(pids) {
  const map = new Map();
  if (!pids.length) return map;
  if (isWin) {
    const out = await sh('tasklist', ['/fo', 'csv', '/nh']);
    for (const l of (out || '').split('\n')) {
      const m = /^"([^"]+)","(\d+)"/.exec(l);
      if (m && pids.includes(+m[2])) map.set(+m[2], { name: m[1], command: m[1], uptime: '-' });
    }
    return map;
  }
  const out = await sh('ps', ['-o', 'pid=,etime=,args=', '-p', pids.join(',')], { lenient: true });
  if (out === null && process.platform === 'linux') return procFromProc(pids);
  for (const l of (out || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    if (m) map.set(+m[1], { uptime: m[2], command: m[3] });
  }
  if (process.platform === 'linux') for (const [pid, i] of map) i.restart = restartCmdFromProc(pid);
  return map;
}
const kindOf = (name, cmd) => {
  const head = `${name} ${(cmd || '').split(' ')[0]}`;
  if (/docker|vpnkit|containerd/i.test(head)) return 'docker';
  if (/\b(node|nodejs|bun|deno|npm|pnpm|yarn|tsx|vite|next)\b|node\.exe/i.test(head)) return 'node';
  return 'other';
};

async function listPorts() {
  let rows = null;
  if (isWin) rows = parseNetstat((await sh('netstat', ['-ano', '-p', 'TCP'])) || '');
  else if (process.platform === 'linux') {
    const ss = await sh('ss', ['-ltnpH']);
    rows = ss !== null ? parseSS(ss) : null;
  }
  if (rows === null) {
    const l = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { lenient: true });
    if (l !== null) rows = parseLsof(l);
    else if (process.platform === 'linux') rows = listenFromProc();
    else throw new Error('"lsof" não encontrado. Instale-o para listar portas.');
  }
  const info = await procInfo([...new Set(rows.map((r) => r.pid).filter(Boolean))]);
  const merged = new Map();
  for (const r of rows) { // junta IPv4/IPv6 da mesma porta+pid
    const k = `${r.port}:${r.pid}`;
    if (merged.has(k)) continue;
    const i = info.get(r.pid) || {};
    const name = r.name !== '?' ? r.name : i.name || '?';
    merged.set(k, { ...r, name, command: i.command || '', uptime: i.uptime || '-', kind: kindOf(name, i.command) });
  }
  return [...merged.values()].sort((a, b) => a.port - b.port);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function killPid(pid, force = false) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('PID inválido');
  if (pid === process.pid) throw new Error('O devdock não pode matar a si mesmo');
  if (isWin) { await sh('taskkill', ['/PID', String(pid), '/T', '/F']); return alive(pid) ? 'falhou' : 'killed'; }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch (e) {
    throw new Error(e.code === 'EPERM' ? `Sem permissão para encerrar ${pid} (tente com sudo)` : e.code === 'ESRCH' ? `Processo ${pid} não existe mais` : e.message);
  }
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100); // espera encerrar com graça
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} await sleep(200); return 'killed'; }
  return force ? 'killed' : 'terminated';
}

async function getCwd(pid) {
  if (process.platform === 'linux') { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  const out = await sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { lenient: true });
  const l = (out || '').split('\n').find((x) => x[0] === 'n');
  return l ? l.slice(1) : null;
}

// Reinicia: captura comando + cwd, encerra e relança destacado do terminal.
async function restartPid(pid) {
  if (isWin) throw new Error('Restart de processos não é suportado no Windows (use Docker ou reinicie manualmente)');
  pid = Number(pid);
  const info = (await procInfo([pid])).get(pid);
  if (!info) throw new Error(`Processo ${pid} não encontrado`);
  const cwd = await getCwd(pid);
  await killPid(pid);
  await sleep(400);
  spawn(info.restart || info.command, { shell: true, cwd: cwd || process.cwd(), detached: true, stdio: 'ignore' }).unref();
  return { command: info.command, cwd };
}

// ---------- Docker ----------
async function dockerList() {
  const out = await sh('docker', ['ps', '-a', '--format', '{{json .}}']);
  if (out === null) return { available: false, containers: [] };
  const containers = out.split('\n').filter(Boolean).map((l) => {
    const c = JSON.parse(l);
    return { id: c.ID, name: c.Names, image: c.Image, status: c.Status, state: c.State, ports: c.Ports };
  });
  return { available: true, containers };
}
async function dockerAction(id, action) {
  if (!/^\w[\w.-]*$/.test(id)) throw new Error('ID/nome de container inválido');
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Ação inválida');
  try { await run('docker', [action, id], { timeout: 60000 }); }
  catch (e) { throw new Error((e.stderr || e.message).trim()); }
  return 'ok';
}

module.exports = { listPorts, killPid, restartPid, dockerList, dockerAction, procInfo, parseSS, parseLsof, parseNetstat, kindOf };
