'use strict';
// Parser de argumentos mínimo: --flag, --chave=valor, --chave valor, -f, -fy, -p 8080, "--"
const ALIAS = { f: 'force', y: 'yes', j: 'json', p: 'port', h: 'help', v: 'version', o: 'open' };
const VALUE_FLAGS = new Set(['port', 'pid']);

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) out.flags[key] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key) && argv[i + 1] !== undefined) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        const key = ALIAS[ch] || ch;
        out.flags[key] = VALUE_FLAGS.has(key) && argv[i + 1] !== undefined ? argv[++i] : true;
      }
    } else out._.push(a);
  }
  return out;
}
module.exports = { parse };
