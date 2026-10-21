# Wescc Chat

Chat interno completo: canais, mensagens diretas, threads, discussões, times, omnichannel (livechat), integrações, LDAP, SAML, auditoria, retenção e demais recursos, todos liberados, sem planos nem licenças.

- **Servidor:** Node.js 22 + TypeScript (Fastify, WebSocket), em `server/`
- **Banco:** PostgreSQL 14+ (migrações SQL em `server/src/db/migrations`, aplicadas ao iniciar)
- **Cliente web:** React + Vite, em `web/`
- **Tipos compartilhados:** `shared/`

## Rodando em desenvolvimento

```bash
# 1. Banco
createuser chat -P            # senha: chat
createdb chat -O chat

# 2. Dependências
npm install

# 3. Cliente web (o servidor serve o build em web/dist)
npm run build -w web

# 4. Servidor (cria o usuário admin na primeira execução)
cd server
ADMIN_PASSWORD=troque-esta-senha npm run dev
```

Abra http://localhost:3000 e entre com `admin` e a senha definida.

Para desenvolver o front com recarga automática, rode `npm run dev -w web` em outro terminal.

## Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://chat:chat@127.0.0.1:5432/chat` | Conexão com o PostgreSQL |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Endereço do servidor |
| `SITE_URL` | `http://localhost:3000` | URL pública (links, SAML, e-mails) |
| `UPLOAD_DIR` | `./uploads` | Pasta dos arquivos enviados |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | `admin` / — / `admin@localhost` | Admin criado no primeiro boot |
| `DISABLE_CRON` | — | `1` desliga as tarefas agendadas nesta instância |

Várias instâncias podem rodar contra o mesmo banco: o tempo real entre elas usa LISTEN/NOTIFY do PostgreSQL e as tarefas agendadas usam advisory locks.

## Testes

```bash
npm test              # testes do servidor (precisa de um PostgreSQL acessível em DATABASE_URL)
npm run typecheck
```

## Produção

```bash
npm run build                 # shared, server (dist/) e web (web/dist)
cd server && NODE_ENV=production node dist/index.js
```

## Widget de atendimento

Ative o Omnichannel em Administração › Configurações e cole no seu site:

```html
<script src="https://SEU-CHAT/livechat/widget.js" async></script>
```

O código pronto aparece em Administração › Omnichannel › Instalação.
