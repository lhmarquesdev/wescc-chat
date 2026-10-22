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
| `IMPORT_SERVER_DIR` | — | Pasta do servidor de onde a importação pode ler arquivos pelo caminho |
| `IMPORT_ALLOWED_HOSTS` | — | `host:porta` internos liberados para downloads da importação, separados por vírgula |

Várias instâncias podem rodar contra o mesmo banco: o tempo real entre elas usa LISTEN/NOTIFY do PostgreSQL e as tarefas agendadas usam advisory locks.

## Testes

```bash
npm test              # testes do servidor (precisa de um PostgreSQL acessível em DATABASE_URL)
npm run typecheck
```

Os testes usam o banco de `TEST_DATABASE_URL` (padrão `postgres://chat:chat@127.0.0.1:5432/chat_test`), que é
apagado e recriado a cada arquivo. `server/test/ldap-ad.test.ts` roda contra um Active Directory de teste (Samba,
domínio `EXPLORER.TEST`) e é ignorado com um aviso quando ele não responde ou quando as credenciais não foram
definidas. Nenhuma senha fica no repositório: defina `WESCC_TEST_AD_SYNC_PASSWORD`, `WESCC_TEST_AD_PROVISION_PASSWORD`
e `WESCC_TEST_AD_USER_PASSWORD`, e aponte o servidor com `WESCC_TEST_AD_URL`, `WESCC_TEST_AD_LDAPS_URL` e
`WESCC_TEST_AD_CA` (ou `WESCC_TEST_AD_DIR`, a pasta do AD de teste com `tls/ca.pem`). Veja `server/test/ad-env.ts`.

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

## Esqueci minha senha

A tela de login tem o link "Esqueci minha senha" (`Accounts_PasswordReset`). O chat envia por e-mail um link válido por
1 hora, que só funciona uma vez; ao redefinir, todas as sessões da conta são encerradas e o 2FA continua sendo pedido.
Para funcionar:

- configure o SMTP em Administração › Configurações › Email;
- confira a URL do site em Configurações › Geral (ou a variável `SITE_URL`), que é usada no link.

Contas LDAP e contas que só entram por SAML/OAuth seguem o provedor e não recebem o link.

## App instalável e notificações push

O cliente web é um PWA: no Chrome ou no Edge use "Instalar app" na barra de endereço; no celular, "Adicionar à tela
inicial" (no iPhone, as notificações só funcionam com o app adicionado à tela inicial).

Com a permissão de notificações dada, o navegador se inscreve para push e recebe menções e DMs mesmo com o chat
fechado. O push só é enviado para quem não está com o chat aberto em nenhum lugar, e cada pessoa pode desligá-lo por
dispositivo em Minha conta › Preferências.

- As chaves VAPID são geradas no primeiro boot e ficam nas configurações (Segurança › Push), onde o push também pode
  ser desligado ou ter o conteúdo oculto.
- O servidor precisa de acesso de saída aos serviços de push dos navegadores (Google, Mozilla, Apple, Microsoft), e
  o site precisa estar em HTTPS (ou em `localhost`).
- A inscrição é apagada junto com a sessão: ao sair, o dispositivo deixa de receber.

## Chamadas de voz e vídeo

Em qualquer mensagem direta entre duas pessoas, os botões 📞 e 🎥 no topo da conversa ligam para a outra pessoa, que
recebe o toque em todos os dispositivos com o chat aberto (e uma notificação push se estiver com o chat fechado). Dá
para atender só com áudio, desligar o microfone ou a câmera, compartilhar a tela e ampliar a janela. Cada chamada fica
registrada na conversa e no histórico em 📞 Chamadas, na barra lateral.

- O áudio e o vídeo vão direto entre os navegadores (WebRTC); o servidor só repassa a sinalização e guarda o histórico.
- Na mesma rede isso funciona sem configuração. Para chamadas entre redes diferentes (casa e escritório, 4G), configure
  um servidor TURN (por exemplo o coturn) em Administração › Configurações › Videoconferência.
- Fora de `localhost`, o navegador só libera câmera e microfone com o site em HTTPS.

## Importação de dados

Em Administração › Importação dá para trazer dados de outros sistemas, como no Rocket.Chat:

- **Slack**: o .zip de "Importar/exportar dados" do Slack, com usuários, canais, grupos privados, mensagens diretas,
  threads, reações, mensagens fixadas e anexos de integrações. O canal geral do Slack entra no canal padrão daqui.
- **CSV**: um .zip com `users.csv`, `channels.csv`, uma pasta por canal com as mensagens e `directmessages/`.
  A tela de nova importação mostra o formato completo.
- **Usuários do Slack**: o .csv de "Exportar lista de membros" (admins, bots e contas desativadas são respeitados;
  linhas sem um e-mail válido ficam de fora, com aviso).
- **Contatos do omnichannel**: um .csv com `name`, `emails`, `phones`, `manager` e `id`.
- **API**: `import.new`, `import.addUsers` e `import.run`, para sistemas que mandam os dados direto. As senhas seguem
  a mesma política das contas e são guardadas só como hash; cada chamada de `import.addUsers` aceita até 500 usuários
  com senha.

O arquivo pode ser enviado pelo navegador, baixado de uma URL ou lido de uma pasta do servidor (`IMPORT_SERVER_DIR`).
Antes de importar aparece a lista de usuários, canais e contatos para escolher o que entra. Importar de novo o mesmo
arquivo não duplica nada. Os arquivos das mensagens e as fotos de perfil do Slack ficam na origem até serem baixados
pelos botões "Baixar arquivos pendentes" e "Baixar fotos pendentes". A importação nunca muda a senha, o e-mail ou o
nome de usuário de contas que já existem, e só acrescenta papéis que existem aqui. O papel de administrador só vai para
contas criadas pela importação, e só quando quem importa tem a permissão `assign-admin-role`. Avisos da conversão
(papel ignorado, nome de usuário ou de sala trocado por já existir) aparecem com os erros, nos detalhes da importação.

Uma pessoa do arquivo entra numa conta que já existe quando uma importação anterior da mesma origem a ligou a essa
conta (e a conta não tem outro e-mail), quando o e-mail dela é de uma conta que o confirmou (ou que o recebeu da
importação que a criou), ou pelo nome de usuário, quando a conta daqui ou a pessoa do arquivo não tem e-mail. O e-mail
de uma conta que não o confirmou não basta: a pessoa ganha outra conta, sem esse e-mail, e a importação avisa. Se a conta
for mesmo dela, marque "E-mail verificado" nela em Administração › Usuários e importe de novo: o que foi importado passa
para ela, e a conta criada no lugar é desativada. "-", "n/a" e outros valores que não são e-mail valem como sem e-mail.
Uma sala ligada por uma importação anterior só é usada de novo se ainda for do mesmo tipo (e, numa conversa direta, entre
as mesmas pessoas); senão a importação cria outra sala e avisa, e nada de um grupo privado vai para um canal público. A
lista de membros do Slack e o CSV só desativam contas que uma importação do mesmo tipo criou; a exportação completa do
Slack, só contas ligadas a ela por uma importação anterior. Nenhuma desativa quem importa nem o último administrador
ativo.

Contra arquivos feitos para derrubar o servidor: o texto de cada mensagem é cortado em 40.000 caracteres (o máximo do
Slack), com aviso; um .zip que descompactado passa de 64 MiB e de 100 vezes o próprio tamanho, ou que traz mais de 100
mil registros e mais de 2 por byte do .zip, é recusado com uma mensagem que diz o motivo. Numa pasta do servidor,
arquivos e pastas com nome fora do UTF-8 ficam de fora, com um aviso só.

Os downloads (URL, arquivos e fotos pendentes) recusam endereços da rede interna. Para liberar um servidor interno,
inclua `host:porta` em `IMPORT_ALLOWED_HOSTS`.

## Operação: conversas diretas restritas

Para equipes de operação (central de atendimento, por exemplo) dá para impedir que as pessoas da operação conversem
em particular entre si, sem tirar delas os canais da equipe e a conversa com supervisores e com o resto da empresa.

- Em Administração › Papéis e permissões, um papel global pode ser marcado como **Restrito em conversas diretas**.
  Duas pessoas com papel restrito não iniciam mensagem direta nem chamada uma com a outra; com quem não é restrito
  tudo continua igual. Uma DM em grupo é recusada quando junta duas pessoas restritas, mesmo aberta por um supervisor
  (para isso existe o grupo privado, que tem dono).
- O papel **operacao** (Operação) já vem criado e restrito, com permissões próprias: lê e entra em canais públicos,
  escreve onde é membro, abre DMs com quem não é restrito e apaga as próprias mensagens. Não cria canais, grupos,
  times nem discussões. Quem é da operação deve ter só esse papel, **sem o papel user**, que permitiria criar grupos
  privados entre operadores.
- A exceção é a permissão `start-dm-between-restricted` (por padrão, só admin): dê a um papel como
  `operacao-conversa-direta` para quem precisa falar em particular com a operação. Quem tem a exceção inicia a
  conversa e a chamada; o outro lado responde na conversa, mas não liga.
- DMs que já existiam entre duas pessoas restritas (de antes da regra, de uma importação ou de uma troca de papel)
  continuam com o histórico, a busca e os arquivos, mas não aceitam mensagens, reações nem chamadas. Discussões
  criadas numa DM seguem a mesma regra para quem participa dela. Nada é apagado.
- Quem tem papel restrito e é dono de uma sala privada não consegue trazer outra pessoa restrita para ela (convite,
  link de convite, membros de grupo, time ou discussão).
- `Direct_Restriction_Scope` (Configurações › Contas › Mensagens diretas) escolhe a regra: entre quaisquer pessoas com
  papel restrito (padrão) ou só entre quem tem o mesmo papel restrito (um papel restrito por equipe, e as equipes
  conversam entre si).
- O quadro **Conversas diretas restritas**, em Papéis e permissões, mostra os papéis restritos, quem tem a exceção,
  as brechas (pessoas restritas que também podem criar grupos privados, times ou discussões por outro papel) e
  quantas DMs antigas ficaram bloqueadas.

A web mostra cada bloqueio antes do clique (botões desativados com o motivo, conversa com o aviso no lugar do campo de
mensagem), e o servidor confere tudo de novo.

## Canais de avisos e “Ciente”

Num **canal de avisos** (📢) só algumas pessoas publicam e todos os membros leem. Crie em ✎ › Canal › Tipo de canal ›
📢 Canal de avisos, ou transforme um canal ou grupo existente em Informações › Editar (ou em Administração › Salas).

- Publicam os donos e moderadores da sala, os **publicadores** (no perfil da pessoa, dentro do canal, use “Tornar
  publicador”; permissão `set-publisher`) e quem tem `post-readonly` por um papel global (por exemplo um papel
  `avisos-publicador`, que publica em todos os canais de avisos).
- Quem lê não envia mensagens, não responde em thread, não envia arquivos, não edita mensagens antigas e não cria
  discussões no canal. Reações só quando o canal permite, e só com emojis da lista.
- **Pedir “Ciente”**: cada aviso pode pedir confirmação de leitura (o botão fica ligado no campo de mensagem de quem
  publica). Os membros clicam em “✔ Ciente”, o topo do canal mostra quantos avisos esperam a confirmação de cada um, e
  quem publica vê quem confirmou e quem falta. Funciona com a confirmação de leitura do chat ligada ou desligada.
- **Ocultar a lista de membros**: só donos e moderadores veem quem está no canal (inclusive pela lista do time e pelas
  confirmações de leitura).

## Active Directory / LDAP

Em Administração › LDAP / AD o chat se liga ao Active Directory (ou a outro servidor LDAP): quem entra na rede passa a
ter conta no chat, com os papéis, canais e times da sua operação, e quem sai ou é desativado no AD deixa de entrar.

- **Conexão**: URL (`ldap://` ou `ldaps://`), usuário de serviço só de leitura, Base DN e filtro de usuários. O botão
  “Usar padrões do Active Directory” preenche os atributos do AD (sAMAccountName, objectGUID, grupos aninhados,
  thumbnailPhoto). Para LDAPS com uma CA interna, cole o certificado da CA em `LDAP_CA_Certificate`. Deixe as contas
  desativadas no filtro de usuários (sem excluir por `userAccountControl`): assim a sincronização as desativa aqui.
- **Mapeamento**: regras de origem → papéis, canais e times, por grupo do AD (pelo nome ou pelo DN), por unidade
  organizacional (OU, em qualquer nível abaixo dela) ou para todos. Ficam nos mesmos mapas JSON de antes
  (`LDAP_Role_Mapping`, `LDAP_Channel_Mapping` e `LDAP_Team_Mapping`), com as chaves `"*"`, `"ou:<DN>"`,
  `"group:<DN>"`, `"group:<nome>"` ou só o nome do grupo; mapas antigos continuam valendo. Há um editor visual e o
  modo JSON.
  - Papéis padrão (`LDAP_Default_Roles`, `user`) não vão para quem recebe um papel restrito em conversas diretas.
  - Canais que não existem são criados como grupos privados, com o dono de `LDAP_Channels_Admin`; times precisam
    existir.
  - Com as remoções ligadas, quem sai do grupo ou da OU perde o papel, o canal ou o time mapeado; quem é dono,
    moderador, líder ou publicador da sala nunca é removido pela sincronização.
  - Para papéis privilegiados (como admin), use a chave pelo DN (`group:CN=...`): o nome de um grupo só é único dentro
    da OU. Uma regra por nome que serve para mais de um grupo do diretório não muda nada de quem está neles e aparece
    como erro na sincronização.
- **Sincronização**: “Sincronizar agora” ou em segundo plano (`LDAP_Background_Sync`, a cada 15 minutos por padrão,
  com uma expressão cron). Só uma sincronização roda por vez, mesmo com várias instâncias. O histórico guarda as
  últimas 100, com as mudanças, os erros e os avisos de cada uma.
  - Conta desativada no AD é desativada aqui e tem as sessões encerradas; reativada no AD, volta a funcionar. A
    sincronização só reativa o que ela mesma desativou: uma conta desativada à mão pelo administrador continua
    desativada.
  - Conta que some da busca (apagada no AD ou fora do filtro) é desativada, nunca apagada. Se a busca vier vazia, ou
    se for desativar mais que `LDAP_Sync_Max_Deactivation_Percent` (50%) das contas do LDAP (a partir de 10 contas),
    ninguém é desativado e a execução avisa para conferir o Base DN e o filtro.
  - A foto do AD vira o avatar, a menos que a pessoa tenha escolhido outro.
- **Testar usuário**: mostra, sem gravar nada, o que a sincronização faria com um login (grupos, regras, papéis,
  canais, times e se a pessoa fica restrita em conversas diretas).
- **Login**: a senha é conferida no AD. A senha local só vale quando o servidor LDAP está fora do ar
  (`LDAP_Login_Fallback`), nunca quando o AD recusa a senha ou a conta.

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
