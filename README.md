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
| `DATABASE_URL_FILE` | — | Arquivo com o endereço do banco; tem precedência sobre `DATABASE_URL` |
| `TLS_PFX_FILE` / `TLS_PFX_PASSPHRASE_FILE` | — | HTTPS próprio com o PFX da TI e o arquivo com a senha dele (ou `TLS_PFX_PASSPHRASE`) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` / `TLS_CA_FILE` | — | HTTPS próprio com certificado e chave em PEM (com os dois, vale o PFX) |
| `HTTP_REDIRECT_PORT` | — | Portas HTTP que redirecionam para o `SITE_URL`, separadas por vírgula (ex.: `80,3000`) |
| `INTERNAL_PORT` | `3080` | Só com HTTPS próprio: porta em `127.0.0.1` para os webhooks do servidor de chamadas |
| `TRUST_PROXY` | `false` com HTTPS próprio, `true` sem | Proxies cujo `X-Forwarded-For` vale: `true`, `false` ou endereços e faixas separados por vírgula |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET_FILE` | — | Servidor de chamadas em grupo (o instalador do LiveKit grava os valores) |

Senhas e chaves podem vir de arquivo: `DATABASE_URL_FILE`, `TLS_PFX_PASSPHRASE_FILE` e `LIVEKIT_API_SECRET_FILE`
apontam para um arquivo com o valor (espaços e quebras de linha no fim são ignorados) e têm precedência sobre
`DATABASE_URL`, `TLS_PFX_PASSPHRASE` e `LIVEKIT_API_SECRET`. Um arquivo que não dá para ler impede o chat de subir.

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

No Windows, o chat roda como serviço com o instalador de `scripts\windows` (veja a seção abaixo).

## HTTPS e serviço do Windows

Fora de `localhost`, o navegador só libera câmera, microfone, push e o app instalável com o site em HTTPS. O chat
serve HTTPS sozinho, sem IIS nem proxy reverso, com o certificado que a TI emitir (PFX exportado do AD CS, ou PEM).
Sem nenhuma variável `TLS_*`, tudo fica como antes: HTTP na porta `PORT`.

- **Certificado**: `TLS_PFX_FILE` com `TLS_PFX_PASSPHRASE_FILE` (o arquivo com a senha do PFX), ou `TLS_CERT_FILE` e
  `TLS_KEY_FILE` (PEM, chave sem senha; `TLS_CA_FILE` opcional com a cadeia). Use
  `SITE_URL=https://<nome do certificado>` e `PORT=443`.
- **Problemas no certificado** impedem o chat de subir, com o motivo na tela e no log: arquivo não encontrado, senha
  do PFX que não confere, certificado e chave que não combinam, PFX com criptografia antiga (exporte de novo com
  AES256-SHA256), chave PEM com senha, cadeia fora de ordem (o certificado do chat vem primeiro em `TLS_CERT_FILE`,
  depois as intermediárias) ou arquivo trocado (PFX em `TLS_CERT_FILE`, PEM em `TLS_PFX_FILE`). Ao subir, e depois
  uma vez por dia, o chat confere o certificado que está servindo e registra a validade; avisa (nível `warn`) quando
  faltam menos de 30 dias, quando venceu, quando ainda não começou a valer (data de início no futuro, ou o relógio
  deste computador atrasado), quando ele não vale para o nome do `SITE_URL` e quando o nome só está no CN, sem SAN
  (o Chrome e o Edge recusam).
- **Renovação sem reiniciar**: grave o certificado novo no mesmo caminho (e a senha nova no arquivo da senha, se ela
  mudou). Em até 1 minuto o chat passa a usá-lo e registra "Certificado HTTPS recarregado.". Um arquivo com problema,
  um certificado vencido, um que ainda não começou a valer ou um que não vale para o nome do `SITE_URL` é recusado e o
  certificado anterior continua valendo, com o motivo no log em nível `warn`. O que ainda não começou a valer entra
  sozinho na hora em que passa a valer, sem precisar gravar o arquivo de novo.
- **Redirecionamento**: `HTTP_REDIRECT_PORT=80,3000` deixa essas portas em HTTP só para redirecionar (308) para o
  mesmo caminho no `SITE_URL`. O destino vem sempre do `SITE_URL`, nunca do endereço que o navegador pediu.
- **Webhooks do servidor de chamadas**: com HTTPS próprio, o chat também escuta em `127.0.0.1:3080`
  (`INTERNAL_PORT`), só para `POST /sfu-webhook`, porque o LiveKit não confere o certificado em `127.0.0.1`. Essa
  porta nunca é liberada no firewall e não pode ser a mesma de `PORT` nem de `HTTP_REDIRECT_PORT` (o chat não sobe).
  `PORT` ou `INTERNAL_PORT` vazios valem o padrão; um valor que não é porta (1 a 65535) impede o chat de subir.
- **IP de quem acessa**: com HTTPS próprio, o `X-Forwarded-For` é ignorado (`TRUST_PROXY=false`) e vale o IP da
  conexão (bloqueio de login, limites de requisições e auditoria). Atrás de um proxy reverso (sem `TLS_*`), o padrão
  continua `true`; para aceitar só os seus proxies, liste-os: `TRUST_PROXY=127.0.0.1,10.0.0.0/8` (máscara em
  pontos também vale, desde que contínua: `10.0.0.0/255.0.0.0`).
- Um erro de configuração ao subir (`TRUST_PROXY`, arquivo `*_FILE` que não existe ou sem permissão de leitura,
  porta inválida) sai só com a mensagem, em uma linha no `wescc-chat.err.log`.
- Os logs de requisição escondem os parâmetros `access_token` e `join_request` (`***`).

**Serviço do Windows.** `scripts\windows\install-chat-service.ps1` instala o chat compilado como o serviço "Wescc
Chat" (`wescc-chat`), com o WinSW (versão e SHA-256 fixados em `scripts\livekit\versions.json`), pela conta virtual
`NT SERVICE\wescc-chat`, com início automático atrasado e reinício em 5 s se o processo cair. Rode no PowerShell 5.1
ou mais novo, como Administrador, com o chat compilado numa pasta fixa fora de `C:\Users` (por exemplo
`C:\Wescc\app`, depois de `npm ci` e `npm run build`) e o Node.js 22 instalado para todos os usuários:

```powershell
# Primeira instalação, ainda sem certificado: HTTP na porta 3000, como hoje
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -AppDir C:\Wescc\app `
  -SiteUrl http://<servidor>:3000 -LanCidr 10.10.0.0/16,10.20.0.0/16

# Quando a TI entregar o certificado: HTTPS na 443, e as portas 80 e 3000 passam a redirecionar
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 `
  -SiteUrl https://chat.<domínio> -PfxFile C:\Temp\chat.pfx

# Só mostra o que seria feito, sem mudar nada
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -SiteUrl https://chat.<domínio> `
  -PfxFile C:\Temp\chat.pfx -WhatIf

# Refaz a definição do serviço com as escolhas salvas (por exemplo depois de instalar o servidor de chamadas)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Reconfigure

# Remove o serviço (com -RemoveSecrets, apaga também os segredos do chat)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Uninstall
```

- O instalador pode rodar de novo quantas vezes for preciso. As escolhas ficam em `C:\Wescc\chat\install.json` (sem
  segredos) e o que vier na linha de comando substitui o que estava salvo. Outros parâmetros: `-Port`,
  `-RedirectPorts`, `-CertFile` e `-KeyFile` (PEM), `-NodeExe`, `-UploadDir`, `-InstallDir`, `-Proxy <url>` e
  `-Offline <pasta>` (com o `WinSW-x64.exe` já baixado, para quem não acessa o GitHub). Veja `Get-Help` no script.
- **Permissões das pastas**: o serviço roda o que está em `-AppDir` e em `C:\Wescc\chat`, então só SYSTEM e os
  Administradores podem mudar essas pastas (o serviço só lê o chat e escreve nos logs e nos arquivos enviados).
  `C:\Wescc` fica com os Administradores como donos: os outros usuários leem, mas não criam, renomeiam nem apagam
  pastas ali. Da primeira vez isso percorre todo o `-AppDir` (com o `node_modules`) e pode levar alguns minutos.
  Depois, para atualizar o chat (`git pull`, `npm ci`, `npm run build`), use um PowerShell como Administrador, dentro
  da própria pasta, e rode o instalador com `-Reconfigure` (ele reinicia o serviço com a versão nova). Uma versão
  compilada em outra pasta e movida para lá (`Move-Item`, ou arrastada no Explorer no mesmo disco) ou copiada com
  `robocopy /SEC` mantém as permissões da pasta de onde veio: o instalador confere a cada vez o que o serviço roda
  (`server\dist`, `web\dist`, `node_modules`) e, se outra conta pode alterar algo, avisa e refaz as permissões da
  pasta inteira. Se a versão passou por uma pasta em que outros usuários escreviam, compile de novo dentro do
  `-AppDir`.
- `C:\Wescc\chat` e `C:\Wescc\secrets` são criadas pelo instalador. Se já existirem antes da primeira vez com algo
  criado por outra conta (no `C:\` qualquer usuário cria pastas), ou com um link ou junção dentro, ele para sem mudar
  nada e pede para tirar a pasta do caminho (`Rename-Item`): quem criou um arquivo pode continuar com ele aberto
  depois que as permissões mudam. Os segredos são sempre gravados em arquivos novos.
- O instalador recusa um `-AppDir` dentro de `C:\Users`, uma pasta de rede ou um link (junção) no caminho, uma pasta
  fora de `C:\Wescc` cuja pasta de cima outro usuário pode renomear, e um `node.exe` que outro usuário pode trocar
  (instale o Node.js para todos os usuários, em `C:\Program Files\nodejs`).
- **Remover**: `-Uninstall` para e remove o serviço, as regras do firewall do grupo "Wescc Chat", as reservas de
  porta que o instalador fez (as anotadas em `install.json`) e o acesso do serviço a `C:\Wescc\secrets`. Ficam os
  logs, os arquivos enviados e `install.json` em `C:\Wescc\chat`, e o `-AppDir`. Com `-RemoveSecrets`, apaga também
  o certificado, a senha do PFX e o endereço do banco; o segredo do servidor de chamadas fica.
- **Segredos**: a senha do PFX e o endereço do banco (`postgres://chat:<senha>@127.0.0.1:5432/chat`) são pedidos na
  tela, sem eco (Enter mantém o atual), e gravados em `C:\Wescc\secrets`, pasta que só SYSTEM, os Administradores e o
  serviço leem. O certificado é copiado para lá. A definição do serviço só tem os caminhos (`*_FILE`), nunca os
  valores. `-Reconfigure` não pergunta nada, a não ser que venha um certificado novo.
- O certificado é conferido antes de ser copiado e de o serviço mudar, com o próprio chat
  (`node server\dist\index.js --check-tls`): senha, chave, validade e o nome do `-SiteUrl` no SAN. Com HTTPS, a
  porta do chat não pode ser a 3080, a dos webhooks.
- **Portas**: o instalador para quando a porta do chat, as de redirecionamento ou a 3080 estão em uso, e diz por quem
  (no Windows, IIS, WinRM, SSTP e o Gateway de Área de Trabalho Remota costumam usar 443 e 80, pelo HTTP.sys). Quando
  a porta cai numa faixa reservada pelo Hyper-V ou pelo WSL, ele a reserva para o chat e reinicia o `winnat` (o
  Docker Desktop pode perder a rede por alguns segundos).
- **Rede e firewall**: avisa quando a rede do computador está como Pública (o firewall bloqueia as chamadas) e cria
  as regras de entrada do grupo "Wescc Chat" só para as portas do chat, só das redes de `-LanCidr` e só nos perfis
  Domínio e Privado.
- No fim ele inicia o serviço e espera `<SiteUrl>/health` responder. Logs em `C:\Wescc\chat\logs`
  (`wescc-chat.out.log` e `wescc-chat.err.log`, até 5 arquivos de 10 MB). No dia a dia: `Restart-Service wescc-chat`,
  `Stop-Service wescc-chat` e `Get-Service wescc-chat`.
- Script baixado da internet: rode `Unblock-File .\scripts\windows\install-chat-service.ps1` ou chame com
  `powershell -ExecutionPolicy Bypass -File ...`.
- Se o chat não sobe, o fim do `wescc-chat.err.log` diz por quê. "A porta ... já está em uso": veja
  `netsh http show servicestate` e `Get-NetTCPConnection -LocalPort <porta>`. "Sem permissão para usar a porta": veja
  `netsh int ipv4 show excludedportrange protocol=tcp`. Se o serviço inicia e para logo em seguida sem nada no log, o
  antivírus ou o AppLocker pode ter bloqueado o `node.exe` ou o `wescc-chat.exe`: peça à TI para liberar pelo hash.

**Ligar o HTTPS muda o endereço do chat.** Sair de `http://<servidor>:3000` para `https://chat.<domínio>` é, para o
navegador, outro site. Faça a troca fora do horário das operações e avise as equipes no dia anterior. No dia:

1. **Login**: todo mundo precisa entrar de novo uma vez, porque a sessão fica guardada no navegador por endereço.
2. **Push e app instalado**: as notificações push e o app instalado ficam presos ao endereço antigo. Cada pessoa abre
   o endereço novo e instala de novo ("Instalar app").
3. **Preferências do navegador**: câmera, microfone e alto-falante das chamadas, e outras escolhas guardadas no
   navegador, voltam ao padrão.
4. **SSO**: a URL de ACS do SAML e as URLs de callback do OAuth cadastradas no provedor saem do `SITE_URL` e precisam
   mudar no mesmo dia. Se a URL do site foi salva em Administração › Configurações › Geral, ela vale mais que o
   `SITE_URL`: troque lá também.
5. **Links antigos**: com `HTTP_REDIRECT_PORT=80,3000` (o padrão do instalador ao ligar o HTTPS), links e favoritos
   antigos continuam funcionando.
6. **Certificado**: peça à TI um certificado "Servidor Web" do AD CS com o nome DNS do chat no SAN. Exporte o PFX com
   AES256-SHA256 (`Export-PfxCertificate -CryptoAlgorithmOption AES256_SHA256`) ou converta para PEM. Confira, num
   computador do domínio em cada local, que a raiz do AD CS é confiável (GPO).
7. **PostgreSQL**: no servidor, publique o banco só em `127.0.0.1:5432` e com uma senha de verdade, num
   `docker-compose.override.yml` (o `docker-compose.yml` do repositório não muda). O endereço do banco vai para
   `C:\Wescc\secrets\database-url.txt` (o instalador pergunta).
8. **Computador do servidor**: ninguém usa no dia a dia. Quem entra nele pode ler os arquivos e a memória do serviço.

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
- Fora de `localhost`, o navegador só libera câmera e microfone com o site em HTTPS (veja HTTPS e serviço do
  Windows).

## Chamadas em grupo

As chamadas com mais de duas pessoas passam por um servidor de mídia, o LiveKit, que roda no mesmo computador do chat
como o serviço "Wescc LiveKit" (`wescc-livekit`). As chamadas 1:1 continuam como estão.

- O navegador fala com o LiveKit só através do chat, em `/sfu`, com o mesmo endereço e o mesmo certificado HTTPS. A
  mídia vai direto para o computador do servidor, em UDP 7882 a 7885 (ou TCP 7881 quando o UDP está bloqueado), só
  das redes da empresa. Não há TURN, STUN nem acesso à internet.
- Versões e SHA-256 ficam em `scripts/livekit/versions.json`; licenças em `scripts/livekit/THIRD-PARTY.md`. Nenhum
  binário fica no repositório.

### Instalação no Windows

No computador do chat, no PowerShell 5.1 ou mais novo, como Administrador, com o Node.js 22 instalado (ele só gera a
configuração):

```powershell
# Primeiro só mostra o que seria feito, sem mudar nada
powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -NodeIp 10.10.0.5 `
  -LanCidr 10.10.0.0/16,10.20.0.0/16 -WhatIf

# Instala (ou atualiza) o serviço
powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -NodeIp 10.10.0.5 `
  -LanCidr 10.10.0.0/16,10.20.0.0/16

# Liga o chat ao servidor de chamadas
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Reconfigure
```

- `-NodeIp` é o IP fixo deste computador na rede da empresa, o endereço que os PCs das filiais alcançam. `-LanCidr`
  são a rede local e as redes de todas as filiais (VPN) que fazem chamadas. Os dois só são obrigatórios na primeira
  vez: as escolhas ficam em `C:\Wescc\livekit\install.json` (sem segredos), e o que vier na linha de comando
  substitui o que estava salvo.
- O LiveKit e o WinSW são baixados das releases do GitHub e conferidos pelo SHA-256; se não batem, o instalador para
  com "O arquivo baixado não confere com o hash esperado. Nada foi instalado.". Sem acesso ao GitHub, use
  `-Proxy http://proxy.empresa.local:8080` (só o endereço: o instalador entra no proxy com a sua conta do Windows, e
  um `-Proxy` com usuário e senha é recusado, porque ficaria no histórico do PowerShell), ou baixe em outro computador
  `https://github.com/livekit/livekit/releases/download/v1.13.9/livekit_1.13.9_windows_amd64.zip` e
  `https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe` e rode com `-Offline <pasta>`. Os
  arquivos da pasta são copiados para uma pasta temporária do Administrador e conferidos lá; o que vai para
  `C:\Wescc\livekit` é sempre a cópia conferida.
- As faixas de `-LanCidr` vão separadas por vírgula (`-LanCidr 10.10.0.0/16,10.20.0.0/16`). Com espaço no lugar da
  vírgula, o PowerShell recusa a linha de comando (os parâmetros só valem pelo nome).
- Na primeira vez ele gera a chave da API (`API` seguido de 12 letras e números) e um segredo de 32 bytes. O segredo
  fica em `C:\Wescc\secrets\livekit-api-secret.txt` (leem SYSTEM, os Administradores e o serviço do chat) e no
  `C:\Wescc\livekit\livekit.yaml` (leem SYSTEM, os Administradores e `NT SERVICE\wescc-livekit`); nunca aparece na
  tela nem na linha de comando. `C:\Wescc\livekit\chat-livekit.env` tem só o endereço, a chave e o caminho do
  segredo: é dele que o `install-chat-service.ps1 -Reconfigure` lê.
- Pode rodar de novo: a chave e o segredo continuam os mesmos e, se nada mudou, o serviço nem reinicia. Quando algo
  muda (versão nova em `versions.json`, outra faixa, outro limite), o serviço reinicia e as chamadas em andamento
  reconectam sozinhas em alguns segundos.
- Se algo falha com o serviço parado (disco cheio, antivírus, o Firewall do Windows desligado), o instalador o inicia
  de novo com o que já estava instalado e diz o que houve. Os programas novos só tomam o lugar dos antigos depois de
  conferidos ao lado deles, e as regras novas do firewall entram antes de as antigas saírem.
- **Webhooks**: o LiveKit avisa o chat das entradas e saídas em `http://127.0.0.1:3080/sfu-webhook` (o chat com HTTPS
  próprio). Enquanto o chat está em HTTP, o instalador usa a porta do chat, lida de `C:\Wescc\chat\install.json`.
  **Depois de ligar o HTTPS do chat, rode `install-windows.ps1` de novo** (sem parâmetros) e o
  `install-chat-service.ps1 -Reconfigure`.
- Outros parâmetros: `-MaxMbps` (limite de banda do LiveKit; padrão 480, metade de uma placa de 1 Gbps),
  `-MaxTracks` (limite de faixas de áudio e vídeo, entrando e saindo; padrão 400 por processador lógico, até 8000,
  como o próprio LiveKit; `-MaxTracks 0` volta ao padrão), `-WebhookUrl`, `-InstallDir` (padrão
  `C:\Wescc\livekit`; sempre um caminho completo, com a letra do disco) e `-NodeExe`. Veja `Get-Help` no script.
- `C:\Wescc\livekit` e `C:\Wescc\secrets` ficam com dono Administradores e acesso só de SYSTEM, dos Administradores
  e do serviço que precisa deles (com outro `-InstallDir`, o `C:\Wescc\livekit` do `chat-livekit.env` também), e
  `C:\Wescc` fica como o instalador do chat a deixa: só os Administradores criam ou renomeiam pastas nela. Como no
  instalador do chat, uma dessas pastas que já existia sem essa proteção, com algo criado ou alterável por outra
  conta, ou com um link ou junção dentro, faz o instalador parar sem mudar nada e pedir para tirá-la do caminho
  (`Rename-Item`). A chave, o segredo e as escolhas salvas só valem de uma pasta que o próprio instalador já tinha
  protegido.
- `-InstallDir` é uma pasta só do servidor de chamadas: o instalador recusa a raiz de um disco, `C:\Wescc` (ou uma
  pasta acima dela), uma pasta dentro de `C:\Wescc\secrets`, uma pasta com arquivos que não são dele e uma pasta
  cuja pasta de cima outra conta pode renomear.
- O firewall ganha duas regras de entrada no grupo "Wescc LiveKit" ("Wescc LiveKit mídia UDP 7882-7885" e "Wescc
  LiveKit mídia TCP 7881"), só das redes de `-LanCidr`, nos perfis Domínio e Privado. A 7880 nunca é aberta.
- Logs em `C:\Wescc\livekit\logs` (`wescc-livekit.out.log` e `wescc-livekit.err.log`, até 5 arquivos de 10 MB). No
  dia a dia: `Get-Service wescc-livekit` e `Restart-Service wescc-livekit`.

### Instalação no Linux

```bash
sudo scripts/livekit/install-linux.sh --node-ip 10.10.0.5 --lan-cidr 10.10.0.0/16,10.20.0.0/16 --dry-run
sudo scripts/livekit/install-linux.sh --node-ip 10.10.0.5 --lan-cidr 10.10.0.0/16,10.20.0.0/16
```

- O mesmo roteiro do Windows, com o pacote `linux_amd64`: o binário em `/opt/wescc/livekit/livekit-server`, o
  usuário de sistema `wescc-livekit`, a configuração em `/etc/wescc/livekit.yaml` e o segredo em
  `/etc/wescc/livekit-api-secret` (os dois `root:wescc-livekit`, 0640; o usuário do chat, `--chat-user`, padrão
  `wescc-chat`, ganha leitura do segredo por ACL), o serviço systemd `wescc-livekit.service` e
  `/etc/sysctl.d/60-wescc-livekit.conf`, com buffers de UDP de 16 MB (abaixo de 5 MB o LiveKit avisa e perde
  pacotes com muita gente).
- `--webhook-url`: padrão `http://127.0.0.1:3080/sfu-webhook` (chat com HTTPS próprio); com o chat em HTTP atrás do
  nginx, `http://127.0.0.1:<porta do chat>/sfu-webhook`. Outros: `--max-mbps`, `--max-tracks` (como o `-MaxTracks`
  do Windows), `--offline <pasta>`, `--proxy <url>` e `--node <caminho do node>`. As escolhas ficam em
  `/etc/wescc/livekit-install.conf`.
- `--proxy` leva só o endereço do proxy: a linha de comando de um programa fica visível para os outros usuários do
  servidor (`ps`), e o instalador recusa um `--proxy` com usuário e senha (com ou sem `http://` na frente). Um proxy
  que pede senha vai pela variável `https_proxy`, digitada sem eco:

  ```bash
  read -rsp 'Proxy (http://usuário:senha@proxy.empresa.local:8080): ' https_proxy && echo && export https_proxy
  sudo --preserve-env=https_proxy scripts/livekit/install-linux.sh --node-ip 10.10.0.5 --lan-cidr 10.10.0.0/16
  unset https_proxy
  ```
- O firewall não é alterado: o instalador mostra os comandos do `ufw` e do `firewalld` para liberar UDP 7882-7885 e
  TCP 7881 só das redes de `--lan-cidr`.
- Log: `journalctl -u wescc-livekit -f`.

O chat no Linux, como serviço systemd na porta 443 com HTTPS próprio e ligado ao servidor de chamadas:

```ini
# /etc/systemd/system/wescc-chat.service
[Unit]
Description=Wescc Chat
After=network-online.target wescc-livekit.service
Wants=network-online.target

[Service]
User=wescc-chat
WorkingDirectory=/opt/wescc/app/server
Environment=NODE_ENV=production PORT=443 SITE_URL=https://chat.<domínio> HTTP_REDIRECT_PORT=80
Environment=TLS_CERT_FILE=/etc/wescc/tls/chat.crt TLS_KEY_FILE=/etc/wescc/tls/chat.key
Environment=DATABASE_URL_FILE=/etc/wescc/database-url
EnvironmentFile=/etc/wescc/chat-livekit.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
# Portas 443 e 80 sem rodar como root
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

Depois: `sudo systemctl daemon-reload && sudo systemctl enable --now wescc-chat`. Quando `install-linux.sh` rodar de
novo, reinicie o chat se ele avisar que gravou `/etc/wescc/chat-livekit.env`.

### Remover o servidor de chamadas

No Windows, no PowerShell como Administrador:

```powershell
# Primeiro só mostra o que seria feito
powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Uninstall -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Uninstall
# Tira o LiveKit do chat ("Servidor de chamadas não configurado.")
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Reconfigure
# De novo, para apagar o segredo, que o chat já não usa
powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Uninstall
```

- Para e remove o serviço `wescc-livekit`, apaga as regras do grupo "Wescc LiveKit" do firewall, desfaz as reservas
  de porta que o instalador fez (as de outros ficam; para uma reserva de um administrador numa porta do LiveKit, ele
  mostra o comando `netsh` que a desfaz) e apaga `livekit-server.exe`, `wescc-livekit.exe`, `wescc-livekit.xml`,
  `livekit.yaml` e `chat-livekit.env`.
- O segredo (`C:\Wescc\secrets\livekit-api-secret.txt`) só sai quando o `wescc-chat.xml` do serviço do chat já não
  aponta para ele: antes do `-Reconfigure`, o chat não subiria sem ele.
- Ficam em `C:\Wescc\livekit` os logs e o `install.json` (para instalar de novo com as mesmas escolhas); apague a
  pasta quando não precisar mais deles.

No Linux:

```bash
sudo scripts/livekit/install-linux.sh --uninstall --dry-run
sudo scripts/livekit/install-linux.sh --uninstall
sudo systemctl restart wescc-chat
```

- Para e desativa o serviço e apaga `wescc-livekit.service`, o `livekit-server`, `/etc/wescc/livekit.yaml`, o
  segredo, `/etc/sysctl.d/60-wescc-livekit.conf` e o usuário e o grupo `wescc-livekit`. O
  `/etc/wescc/chat-livekit.env` fica só com um comentário: o serviço do chat, com `EnvironmentFile=`, continua
  subindo, agora sem chamadas em grupo.
- Se o serviço do chat ainda aponta para o segredo (`LIVEKIT_API_SECRET_FILE` no próprio `.service`, num arquivo
  `.d/*.conf` dele ou num arquivo de `EnvironmentFile=` que não seja o `chat-livekit.env`), o segredo fica até essa
  linha sair e o `--uninstall` rodar de novo.
- O instalador nunca mexeu no firewall: no fim ele mostra os comandos `ufw delete` e `firewall-cmd
  --remove-rich-rule` das regras que sugeriu. Ficam `/etc/wescc/livekit-install.conf` (as escolhas, sem segredos) e
  os buffers de UDP maiores, até o próximo boot.

### Portas

| Porta | Onde | Aberta para | Para quê |
| --- | --- | --- | --- |
| 443/tcp | chat | rede local e filiais (VPN) | HTTPS, `/api`, `/websocket` e a sinalização das chamadas em `/sfu` |
| 80/tcp (opcional) | chat | rede local e filiais | redireciona para o HTTPS |
| 7882–7885/udp | LiveKit | rede local e filiais | mídia (ICE/UDP; uma porta por núcleo num PC de 4 núcleos) |
| 7881/tcp | LiveKit | rede local e filiais | mídia quando o UDP está bloqueado (ICE/TCP) |
| 7880/tcp | LiveKit | **só 127.0.0.1** | API e sinalização, alcançadas só pelo chat |
| 3080/tcp | chat | **só 127.0.0.1** | webhooks do LiveKit, com o chat em HTTPS próprio |

A 7880 e a 3080 nunca são liberadas no firewall. O LiveKit escuta as portas UDP só nos endereços do servidor que
estão em `-LanCidr` (as placas do Hyper-V, do WSL, do Docker e de clientes de VPN ficam de fora).

### Teste de conexão

Em Admin › Chamadas, **Testar minha conexão** confere, a partir do PC de quem clica, o servidor de chamadas, a conexão
de mídia, o caminho da mídia (UDP é o ideal; TCP funciona, com mais atraso), o envio de áudio e o de vídeo. Rode em um
PC de cada site (matriz e cada filial) depois de instalar e sempre que a rede mudar. O resultado esperado é "Tudo
certo para chamadas."; os outros resultados dizem o que pedir à TI (veja Problemas comuns).

### Proxy reverso

Só quando o chat fica atrás de um (sem HTTPS próprio). O `livekit-client` manda o pedido de entrada, com a oferta SDP
compactada, na URL do `/sfu`: as URLs são longas, e a conexão é um WebSocket que fica aberto a chamada toda.

- **IIS com ARR**: instale o recurso "Protocolo WebSocket" e aumente os limites de URL para pelo menos 32768:

  ```xml
  <system.webServer>
    <security>
      <requestFiltering>
        <requestLimits maxQueryString="32768" maxUrl="32768" />
      </requestFiltering>
    </security>
  </system.webServer>
  ```

- **nginx**:

  ```nginx
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  server {
    # ... listen 443 ssl, certificado ...
    large_client_header_buffers 4 32k;
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 3600s;
    }
  }
  ```

- Com o chat em HTTP atrás do proxy, os webhooks vão para a porta do chat: `-WebhookUrl
  http://127.0.0.1:3000/sfu-webhook` (no Linux, `--webhook-url`).

### Rede da empresa

- **Proxy web**: um proxy explícito, PAC ou WPAD precisa ter o endereço do chat na lista de exceções. Senão o
  WebSocket passa pelo `CONNECT` do proxy, e proxies que inspecionam TLS costumam quebrar o WebSocket.
- **Chrome gerenciado**: as políticas `WebRtcIPHandling` (`disable_non_proxied_udp`) e `WebRtcUdpPortRange`, comuns
  em call center, derrubam o UDP ou os candidatos locais. Peça à TI para liberar UDP até o computador do chat.
- **VPN com NAT**: `-NodeIp` precisa ser o endereço que a filial alcança. Filiais com faixas privadas sobrepostas (duas
  filiais em `192.168.1.0/24`, por exemplo) obrigam NAT, e um `-NodeIp` só não atende as duas: é preciso um segundo
  endereço no servidor (com as duas faixas em `-LanCidr`) ou um TURN. Combine com o time do chat antes.
- **Nenhum STUN público**: nas chamadas em grupo o navegador não recebe servidores STUN e o LiveKit não consulta a
  internet para descobrir o próprio endereço.

### Fones

Num salão de call center, quem entra em chamadas usa fone de ouvido com microfone perto da boca. Alto-falante aberto
faz eco para todos da chamada.

### Problemas comuns

| Sintoma | O que conferir |
| --- | --- |
| "Servidor de chamadas não configurado." | Se `C:\Wescc\livekit\chat-livekit.env` existe e se o `install-chat-service.ps1 -Reconfigure` rodou depois dele (no Linux: `EnvironmentFile=/etc/wescc/chat-livekit.env` no serviço do chat e o chat reiniciado) |
| "Sem resposta de http://127.0.0.1:7880." | O serviço `wescc-livekit` (`Get-Service wescc-livekit`), o log em `C:\Wescc\livekit\logs`, e se o antivírus ou o AppLocker bloqueou `livekit-server.exe` ou `wescc-livekit.exe` (libere pelo SHA-256 de `versions.json`) |
| Teste de conexão: "A mídia passa só por TCP." | UDP 7882 a 7885 no firewall da filial ou na VPN |
| Teste de conexão: "O navegador não alcança o servidor de chamadas." | Se o chat abre por HTTPS e se o endereço do chat está na lista de exceções do proxy |
| As chamadas caem quando o PC do servidor fica ocioso | A economia de energia da placa de rede, o Modern Standby e o plano de energia |
| Ninguém novo consegue entrar, mas a CPU está folgada | O log do LiveKit com "node has exceeded its configured limit": o limite de faixas (`num_tracks`, 400 por processador lógico; `-MaxTracks`) ou de banda (`-MaxMbps`) do `livekit.yaml` foi atingido |

### Checklist da TI antes de ir para produção

- [ ] **Certificado**: o chat em HTTPS com o certificado do AD CS (veja HTTPS e serviço do Windows); sem HTTPS o
      navegador não libera câmera nem microfone. Depois de ligar o HTTPS, `install-windows.ps1` de novo e
      `install-chat-service.ps1 -Reconfigure`.
- [ ] **Portas**: no firewall de cada filial e na VPN, TCP 443 (e 80, se usada), UDP 7882 a 7885 e TCP 7881 até o
      `-NodeIp`. A 7880 e a 3080, nunca.
- [ ] **Proxy e Chrome**: o endereço do chat nas exceções do proxy; `WebRtcIPHandling` e `WebRtcUdpPortRange`
      conferidas.
- [ ] **Computador do servidor**: IP fixo; ligado o tempo todo; a rede como Domínio ou Privada; economia de energia da
      placa desligada (Gerenciador de Dispositivos › placa de rede › Gerenciamento de Energia: "Permitir que o
      computador desligue este dispositivo para economizar energia" desmarcado); sem suspensão nem Modern Standby;
      atualizações e reinícios fora do horário das operações (reiniciar derruba todas as chamadas); ninguém usa no
      dia a dia.
- [ ] **Antivírus, AppLocker e WDAC**: liberar pelo SHA-256 (também em `versions.json`) o `livekit-server.exe`
      (`4699597551a8a0a34beef0004a6c693082459c0dd8bcad264b2a453a1ee6f400`) e o `wescc-livekit.exe`, que é o WinSW
      2.12.0 (`05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`).
- [ ] **Teste de conexão** em um PC de cada site: "Tudo certo para chamadas.".
- [ ] **Fones** com microfone para quem faz chamadas no salão.
- [ ] **Teste de carga** abaixo aprovado.

### Teste de carga (Explorer, antes de ir para produção)

No próprio computador do servidor, fora do horário das operações, com o `lk` 2.19.0 (a versão de `versions.json`).
O `lk` roda no mesmo PC que o LiveKit, então o resultado é conservador.

- [ ] **1. Baixar o `lk`** (PowerShell como Administrador):

  ```powershell
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $zip = "$env:TEMP\lk_2.19.0_windows_amd64.zip"
  Invoke-WebRequest -UseBasicParsing -OutFile $zip `
    https://github.com/livekit/livekit-cli/releases/download/v2.19.0/lk_2.19.0_windows_amd64.zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne '544C3CB752341BDBABA3FAB2FB9A5A096925559AADD4699FB15031358F9C0870') {
    throw 'O arquivo baixado não confere com o hash esperado.'
  }
  # Na pasta temporária da sua conta, que outros usuários do PC não alteram
  $lkDir = "$env:TEMP\wescc-lk"
  if (Test-Path $lkDir) { Remove-Item -Recurse -Force $lkDir }
  Expand-Archive $zip -DestinationPath $lkDir
  if ((Get-FileHash "$lkDir\lk.exe" -Algorithm SHA256).Hash -ne 'EF98551595E205E4C252FB40A6FFEE1ECB4E38922BC5EE79B2C2490CC1524639') {
    Remove-Item -Recurse -Force $lkDir
    throw 'O lk.exe não confere com o hash esperado.'
  }
  ```

- [ ] **2. Abrir quatro janelas do PowerShell como Administrador** e, em cada uma, carregar a chave e o segredo na
  sessão (nunca digitados na linha de comando; somem ao fechar a janela):

  ```powershell
  cd "$env:TEMP\wescc-lk"
  $env:LIVEKIT_API_KEY = (Select-String -Path C:\Wescc\livekit\chat-livekit.env -Pattern '^LIVEKIT_API_KEY=(.+)$').Matches[0].Groups[1].Value
  $env:LIVEKIT_API_SECRET = (Get-Content -Raw -LiteralPath C:\Wescc\secrets\livekit-api-secret.txt).Trim()
  ```

- [ ] **3. Criar as salas** (o LiveKit não cria salas sozinho; sem `--empty-timeout` uma sala vazia fecha em 2
  minutos; nomes fora de `wc_*` ficam fora da limpeza automática do chat):

  ```powershell
  .\lk room create --url http://127.0.0.1:7880 --empty-timeout 600 loadtest1
  .\lk room create --url http://127.0.0.1:7880 --empty-timeout 600 loadtest2
  .\lk room create --url http://127.0.0.1:7880 --empty-timeout 600 loadtest3
  .\lk room create --url http://127.0.0.1:7880 --empty-timeout 600 loadtest4
  ```

- [ ] **4. Rodar as quatro cargas ao mesmo tempo**, uma em cada janela:

  ```powershell
  # Janela 1, reunião: 30 pessoas, 16 câmeras
  .\lk load-test --url http://127.0.0.1:7880 --room loadtest1 --video-publishers 16 --audio-publishers 14 --subscribers 30 --duration 5m
  # Janela 2, transmissão: uma voz para 300 ouvintes
  .\lk load-test --url http://127.0.0.1:7880 --room loadtest2 --audio-publishers 1 --subscribers 300 --duration 5m
  # Janelas 3 e 4: duas reuniões de 15 pessoas, 8 câmeras cada
  .\lk load-test --url http://127.0.0.1:7880 --room loadtest3 --video-publishers 8 --audio-publishers 7 --subscribers 15 --duration 5m
  .\lk load-test --url http://127.0.0.1:7880 --room loadtest4 --video-publishers 8 --audio-publishers 7 --subscribers 15 --duration 5m
  ```

  No `lk` 2.19.0 quem publica não recebe nada: só os `--subscribers` fazem o LiveKit repassar a mídia e só eles
  medem a perda de pacotes. Por isso cada reunião tem um assinante por pessoa. O `lk` conecta 5 participantes por
  segundo (os 300 ouvintes levam 1 minuto); os 5 minutos contam depois de "Finished connecting to room".

  As quatro cargas somam cerca de 1.711 faixas no LiveKit, entrando e saindo (30 + 900, 1 + 300 e 2 × (15 + 225)).
  Antes de começar, confira o limite com `Select-String -Path C:\Wescc\livekit\livekit.yaml -Pattern num_tracks`:
  são 400 por processador lógico, 1600 num PC de 4. Abaixo de 1800, rode antes `install-windows.ps1 -MaxTracks 2000`
  (o resto da configuração fica como está), senão o teste reprova pelo limite e não pelo PC. Depois do teste, deixe
  assim se ele foi aprovado ou volte com `-MaxTracks 0`.

- [ ] **5. Acompanhar o servidor** numa quinta janela (CPU do LiveKit em % do total do PC e memória):

  ```powershell
  $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $lkPid = (Get-Process livekit-server).Id
  while ($true) {
    $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='livekit-server'"
    '{0:HH:mm:ss}  CPU {1,5:N1} %  RAM {2,6:N0} MB' -f (Get-Date), ($p.PercentProcessorTime / $cores), ($p.WorkingSetPrivate / 1MB)
    Start-Sleep -Seconds 5
  }
  ```

  A rede: Gerenciador de Tarefas › Desempenho › Ethernet. No fim, `(Get-Process livekit-server).Id` tem de ser o
  mesmo `$lkPid` do começo (o serviço não reiniciou).

- [ ] **6. Medir o chat de outro PC** durante a carga, com um usuário de teste sem 2FA (a senha é pedida na tela):

  ```powershell
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $chat = 'https://chat.<domínio>'
  $cred = Get-Credential -Message 'Usuário de teste do chat'
  $login = Invoke-RestMethod -Method Post -Uri "$chat/api/v1/login" -ContentType 'application/json' `
    -Body (@{ user = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json)
  $h = @{ 'X-User-Id' = $login.data.userId; 'X-Auth-Token' = $login.data.authToken }
  $health = @(); $me = @()
  foreach ($i in 1..300) {
    $health += [int](Measure-Command { Invoke-RestMethod -Uri "$chat/health" | Out-Null }).TotalMilliseconds
    $me += [int](Measure-Command { Invoke-RestMethod -Uri "$chat/api/v1/me" -Headers $h | Out-Null }).TotalMilliseconds
    Start-Sleep -Seconds 1
  }
  function P95($v) { ($v | Sort-Object)[[math]::Ceiling($v.Count * 0.95) - 1] }
  "health p95: $(P95 $health) ms; me p95: $(P95 $me) ms"
  Invoke-RestMethod -Method Post -Uri "$chat/api/v1/logout" -Headers $h | Out-Null
  ```

- [ ] **7. Aprovado** quando, ao mesmo tempo: o `livekit-server` fica abaixo de 70 % da CPU total; todos os resumos
  do `lk` mostram menos de 2 % em "Total Pkt. Loss" e nenhum erro; o p95 do chat fica abaixo de 300 ms; o serviço
  não reiniciou. Se o `lk` mostrar erros de conexão e o log do LiveKit trouxer "node has exceeded its configured
  limit" com a CPU abaixo de 70 %, quem barrou foi o limite do `livekit.yaml` (faixas ou banda), não o PC: anote e
  fale com o time do chat antes de mudar os limites.
- [ ] **8. Anotar na planilha de go-live**: CPU (pico e média), memória, rede, os resumos do `lk`, os p95, os núcleos
  do PC, o `-MaxMbps` e a versão do LiveKit.
- [ ] **9. Limpar**: `.\lk room delete --url http://127.0.0.1:7880 loadtest1` (e `loadtest2` a `loadtest4`), fechar
  as janelas do PowerShell e apagar o `lk`: `Remove-Item -Recurse -Force "$env:TEMP\wescc-lk", "$env:TEMP\lk_2.19.0_windows_amd64.zip"`.
- [ ] **10. Limites**: só depois de um teste aprovado `Calls_Max_Participants` pode passar de 30 (até 50), em
  Administração › Configurações › Videoconferência. Reprovado: baixe `Calls_Max_Participants` e
  `Calls_Max_Total_Participants` e repita o teste.

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
