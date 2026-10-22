# Wescc Chat

Chat interno completo: canais, mensagens diretas, threads, discussões, times, omnichannel (livechat), integrações, LDAP, SAML, auditoria, retenção e demais recursos, todos liberados, sem planos nem licenças.

- **Servidor:** Node.js 22 + TypeScript (Fastify, WebSocket), em `server/`
- **Banco:** PostgreSQL 14+ (migrações SQL em `server/src/db/migrations`, aplicadas ao iniciar)
- **Cliente web:** React + Vite, em `web/`
- **Tipos compartilhados:** `shared/`

## Rodando em desenvolvimento

```bash
# 1. Banco: com Docker
docker compose up -d
#    ou num PostgreSQL já instalado
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

No Windows (PowerShell), defina a variável antes: `$env:ADMIN_PASSWORD="troque-esta-senha"; npm run dev`.

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

Visitantes podem enviar arquivos pelo 📎, arrastando para a conversa ou colando imagens. Isso segue as regras de
Administração › Configurações › Upload de arquivos (tamanho máximo e tipos) e pode ser desligado em
Omnichannel › File Upload (`Livechat_fileupload_enabled`). O widget baixa os arquivos com o cabeçalho `x-visitor-token`,
e cada visitante só tem acesso aos arquivos das próprias conversas.

## Login com OAuth / OpenID Connect

Em Administração › OAuth cadastre provedores Google, GitHub (inclusive Enterprise), GitLab (inclusive próprio),
Microsoft Entra ID ou qualquer servidor OAuth 2.0 / OpenID Connect (Keycloak, Authentik, Okta...). Cada provedor ativo
vira um botão na tela de login.

- Cadastre no provedor a URL de callback mostrada na tela: `URL do site/oauth/<id>/callback` (a URL do site fica em
  Configurações › Geral).
- O fluxo usa authorization code com PKCE (S256) e `state` de uso único ligado ao navegador; o client secret nunca é
  devolvido pela API.
- Contas existentes só são vinculadas pelo e-mail quando a opção estiver ligada e o provedor confirmar o e-mail.
- Papéis e canais podem ser sincronizados a cada login a partir de um claim (ex.: `groups`, `roles`, `realm_access.roles`),
  com mapa JSON valor → papéis/canais; `admin` só é concedido por mapeamento explícito.

## Segurança

- Troca de senha obrigatória e 2FA obrigatório (geral ou por papel) são cobrados pelo servidor: até a pendência ser
  resolvida, a API só aceita as rotas para resolvê-la e o WebSocket fecha com o código 4005. Quem liga o 2FA
  obrigatório também precisa configurar o próprio 2FA.
- Tentativas de login falhas (inclusive código 2FA errado) bloqueiam a conta e o IP por alguns minutos, em todas as
  instâncias: Configurações › Contas › Sessão.
- A API só aceita chamadas de outros sites com CORS ligado (Configurações › Segurança › CORS). O cookie de sessão vale
  apenas para leituras (imagens e downloads) e para o WebSocket da própria página.
- Avatares exigem login por padrão (`Accounts_AvatarBlockUnauthenticatedAccess`); avatares de salas privadas só para
  quem tem acesso.
- O LDAP só vincula uma conta local com o mesmo nome de usuário com `LDAP_Merge_Existing_Users` ligado.
