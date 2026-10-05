# devdock

CLI + dashboard local para **ver portas ocupadas, processos Node e containers Docker** — e encerrar/reiniciar tudo com um comando ou um clique.
Zero dependências. Só Node.js 18+.

## Instalação

```bash
cd devdock
npm link            # cria o comando global "devdock"  (ou use: node bin/devdock.js ...)
devdock --help
```

## Comandos

| Comando | O que faz |
|---|---|
| `devdock` | modo interativo (lista numerada; `k 2` encerra, `r 2` reinicia, `f 2` força) |
| `devdock ports [--node] [--docker] [--json]` | portas em LISTEN |
| `devdock docker` | containers |
| `devdock kill 3000` | encerra quem usa a porta 3000 (SIGTERM → SIGKILL após 3s) |
| `devdock kill :8080 -f -y` | força e não pergunta |
| `devdock kill pid:4242` | por PID |
| `devdock restart 5173` | reinicia o dev server da porta (relança o mesmo comando no mesmo diretório) |
| `devdock restart meu-postgres` | reinicia um container |
| `devdock dash [-p 7777] [--open]` | dashboard em http://127.0.0.1:7777 |

## Como funciona

- **Linux:** `ss -ltnp`; **macOS:** `lsof`; **Windows:** `netstat -ano` + `tasklist`.
- **Kill:** `process.kill` (SIGTERM, escala para SIGKILL); Windows usa `taskkill /T /F`.
- **Restart:** lê `ps` (comando) e `/proc/PID/cwd` ou `lsof` (diretório), mata e relança destacado.
- **Docker:** `docker ps/start/stop/restart` via `child_process.execFile` (sem shell).

## Limitações

- Restart de processo **não** preserva variáveis de ambiente, e não existe no Windows (no macOS, aspas complexas nos argumentos podem se perder; no Linux o argv é preservado). Para algo crítico, prefira `npm run dev` manual.
- Processos de outros usuários aparecem sem PID; use `sudo devdock ...`.

## Segurança do dashboard

Escuta só em `127.0.0.1`, valida o header `Host` (anti DNS-rebinding) e exige um token aleatório por execução nas ações de escrita (anti CSRF — outros sites abertos no navegador não conseguem matar seus processos).

## Testes

```bash
npm test
```
