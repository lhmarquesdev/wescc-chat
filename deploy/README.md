# Deploy da homologação

A action **Deploy Homologação** publica a revisão atual da `main` em
https://homolog-wescchat.wescctech.com.br. No GitHub, abra **Actions → Deploy Homologação → Run workflow**
e selecione `main`. O deploy é manual; pushes e pull requests não executam código no servidor.

O job usa o runner exclusivo `srvtimedevhml-wescchat-hml`, com o label
`wescchat-homologacao-srvtimedevhml`, no servidor `srvtimedevhml`. O runner executa como `sup_wescc`
e precisa de Git, Docker Compose, Python 3, curl e flock. O runner não requer sudo para os deploys.

O workflow compila a imagem com o SHA do commit enquanto a versão atual atende, faz um `pg_dump`
verificado e atualiza somente o serviço `app`. Confere a saúde pelo Nginx/HTTPS, a imagem em execução
e o identificador do frontend. O LiveKit permanece no mesmo container. A troca do container do chat
interrompe brevemente as conexões WebSocket e a sinalização das chamadas; escolha uma janela adequada.

As configurações permanecem em `/opt/wescchat-hml-config/compose.yml`, `wescchat.env` e nos arquivos
do LiveKit. Não copie esses arquivos para o repositório nem para artifacts do GitHub.
PostgreSQL, uploads, Nginx e certificados não são recriados pelo workflow.

Backups do banco ficam em `/opt/wescchat-hml-config/backups/`, com permissão restrita,
e não são enviados ao GitHub. A imagem anterior é preservada. Em caso de falha na publicação,
o script tenta restaurar a imagem anterior; as migrações de banco **não são desfeitas automaticamente**.
Migrações incompatíveis podem exigir recuperação manual a partir do backup. Os backups e imagens
não são apagados pelo workflow; acompanhe o espaço em disco do servidor.

Para executar os mesmos passos diretamente no servidor, com um checkout limpo da revisão atual:

```bash
bash deploy/homologacao.sh "$(git rev-parse HEAD)" "$PWD"
```
