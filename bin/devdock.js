#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { parse } = require('../src/args');
const os = require('../src/os');
const { createServer } = require('../src/server');
const pkg = require('../package.json');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c(2, s), bold = (s) => c(1, s), red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s), cyan = (s) => c(36, s);
const KIND_COLOR = { node: green, docker: cyan, other: dim };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s, n) => String(s).padEnd(n);

const HELP = `
${bold('devdock')} ${pkg.version} — portas, processos e containers do seu ambiente dev

${bold('Uso')}
  devdock                      modo interativo
  devdock ports [--node|--docker] [--json]
  devdock docker               lista containers
  devdock kill <porta|pid:N> [-f] [-y]
  devdock restart <porta|pid:N|container>
  devdock dash [-p 7777] [--open]   dashboard web local

${bold('Exemplos')}
  devdock kill 3000            encerra quem usa a porta 3000
  devdock kill :8080 -f -y     força, sem confirmação
  devdock kill pid:4242
  devdock restart 5173         reinicia o dev server da porta 5173
  devdock restart meu-postgres reinicia o container

${bold('Flags')}  -f/--force  -y/--yes  -j/--json  -p/--port  -o/--open  -h/--help  -v/--version
`;

function printPorts(ports) {
  if (!ports.length) return console.log(dim('Nenhuma porta em LISTEN.'));
  console.log(bold(`${pad('PORTA', 7)}${pad('PID', 8)}${pad('PROCESSO', 16)}${pad('TIPO', 8)}${pad('UPTIME', 12)}COMANDO`));
  for (const p of ports) {
    console.log(`${pad(p.port, 7)}${pad(p.pid ?? '-', 8)}${pad(trunc(p.name, 15), 16)}${KIND_COLOR[p.kind](pad(p.kind, 8))}${pad(p.uptime, 12)}${dim(trunc(p.command, 60))}`);
  }
}

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
});

// "3000" | ":3000" -> porta; "pid:123" -> pid; outro texto -> container
async function resolveTarget(arg, flags) {
  if (flags.pid) return { type: 'pid', pid: Number(flags.pid) };
  if (/^pid:\d+$/.test(arg)) return { type: 'pid', pid: Number(arg.slice(4)) };
  if (/^:?\d+$/.test(arg)) {
    const port = Number(arg.replace(':', ''));
    const hit = (await os.listPorts()).find((p) => p.port === port);
    if (!hit) throw new Error(`Nada escutando na porta ${port}`);
    if (!hit.pid) throw new Error(`Porta ${port} está em uso, mas o PID é invisível (processo de outro usuário — tente com sudo)`);
    return { type: 'pid', pid: hit.pid, proc: hit };
  }
  return { type: 'docker', id: arg };
}

async function cmdKill(args) {
  if (!args._.length && !args.flags.pid) throw new Error('Informe uma porta ou pid:N. Ex.: devdock kill 3000');
  for (const arg of args._.length ? args._ : [null]) {
    const t = await resolveTarget(arg, args.flags);
    if (t.type === 'docker') { await os.dockerAction(t.id, 'stop'); console.log(green('✔'), `container ${t.id} parado`); continue; }
    if (t.proc && t.proc.kind !== 'node' && !args.flags.yes && tty) {
      const a = await ask(yellow(`"${t.proc.name}" (pid ${t.pid}) não parece ser Node. Encerrar? [y/N] `));
      if (a !== 'y') { console.log('Cancelado.'); continue; }
    }
    const r = await os.killPid(t.pid, !!args.flags.force);
    console.log(green('✔'), `pid ${t.pid}${t.proc ? ` (:${t.proc.port} ${t.proc.name})` : ''} — ${r}`);
  }
}

async function cmdRestart(args) {
  if (!args._[0]) throw new Error('Informe porta, pid:N ou nome do container');
  const t = await resolveTarget(args._[0], args.flags);
  if (t.type === 'docker') { await os.dockerAction(t.id, 'restart'); return console.log(green('✔'), `container ${t.id} reiniciado`); }
  const r = await os.restartPid(t.pid);
  console.log(green('✔'), 'reiniciado:', bold(r.command), dim(`em ${r.cwd || process.cwd()}`));
}

async function cmdDash(args) {
  const port = Number(args.flags.port) || 7777;
  const { server, url } = createServer({ port });
  server.on('error', (e) => {
    console.error(red(e.code === 'EADDRINUSE' ? `A porta ${port} já está em uso (use -p para outra, ou: devdock kill ${port})` : e.message));
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`${green('●')} dashboard em ${bold(url)} ${dim('(Ctrl+C para sair)')}`);
    if (args.flags.open) {
      const [cmd, a] = process.platform === 'darwin' ? ['open', []] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']] : ['xdg-open', []];
      spawn(cmd, [...a, url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = (s) => new Promise((r) => rl.question(s, r));
  for (;;) {
    const ports = await os.listPorts();
    const { containers } = await os.dockerList();
    const running = containers.filter((x) => x.state === 'running');
    console.clear?.();
    console.log(bold('devdock'), dim('— ambiente dev'), '\n');
    console.log(bold(`${pad('#', 4)}${pad('PORTA', 7)}${pad('PID', 8)}${pad('PROCESSO', 16)}${pad('TIPO', 8)}COMANDO`));
    ports.forEach((p, i) => console.log(`${pad(i + 1, 4)}${pad(p.port, 7)}${pad(p.pid ?? '-', 8)}${pad(trunc(p.name, 15), 16)}${KIND_COLOR[p.kind](pad(p.kind, 8))}${dim(trunc(p.command, 50))}`));
    if (running.length) {
      console.log('\n' + bold('Containers'));
      running.forEach((x, i) => console.log(`${pad('d' + (i + 1), 4)}${pad(x.name, 24)}${pad(x.image, 24)}${dim(x.ports)}`));
    }
    console.log(dim('\n  k N = encerrar   f N = forçar   r N = reiniciar   (dN para container)   Enter = atualizar   q = sair'));
    const line = (await q('> ')).trim().toLowerCase();
    if (line === 'q') break;
    const m = /^([kfr])\s*(d?)(\d+)$/.exec(line);
    if (!m) continue;
    const [, act, isD, n] = m;
    try {
      if (isD) {
        const ct = running[n - 1]; if (!ct) throw new Error('Container inexistente');
        await os.dockerAction(ct.name, act === 'r' ? 'restart' : 'stop');
        console.log(green('✔'), ct.name);
      } else {
        const p = ports[n - 1]; if (!p || !p.pid) throw new Error('Item inexistente ou sem PID acessível');
        if (act === 'r') await os.restartPid(p.pid); else await os.killPid(p.pid, act === 'f');
        console.log(green('✔'), `${p.name}:${p.port}`);
      }
    } catch (e) { console.log(red('✖'), e.message); }
    await q(dim('Enter para continuar…'));
  }
  rl.close();
}

(async () => {
  const args = parse(process.argv.slice(2));
  const cmd = args._.shift();
  try {
    if (args.flags.help || cmd === 'help') return console.log(HELP);
    if (args.flags.version) return console.log(pkg.version);
    switch (cmd) {
      case undefined: case 'i': case 'interactive':
        if (!process.stdin.isTTY) return console.log(HELP);
        return await interactive();
      case 'ports': case 'ls': {
        let ports = await os.listPorts();
        if (args.flags.node) ports = ports.filter((p) => p.kind === 'node');
        if (args.flags.docker) ports = ports.filter((p) => p.kind === 'docker');
        return args.flags.json ? console.log(JSON.stringify(ports, null, 2)) : printPorts(ports);
      }
      case 'docker': case 'dk': {
        const d = await os.dockerList();
        if (!d.available) throw new Error('Docker não encontrado ou daemon parado');
        if (args.flags.json) return console.log(JSON.stringify(d.containers, null, 2));
        d.containers.forEach((x) => console.log(`${(x.state === 'running' ? green : dim)(pad(x.state, 9))}${pad(x.name, 26)}${pad(x.image, 26)}${dim(x.ports)}`));
        return;
      }
      case 'kill': case 'k': return await cmdKill(args);
      case 'restart': case 'r': return await cmdRestart(args);
      case 'dash': case 'dashboard': return await cmdDash(args);
      default: console.error(red(`Comando desconhecido: ${cmd}`)); console.log(HELP); process.exitCode = 1;
    }
  } catch (e) { console.error(red('✖'), e.message); process.exitCode = 1; }
})();
