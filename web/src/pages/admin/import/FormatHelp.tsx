// Explicação de cada formato aceito, mostrada ao lado do formulário de nova importação.

const CSV_TREE = `exportacao.zip
├─ users.csv         usuario,email,nome
├─ channels.csv      canal,criador,public|private,membro1;membro2
├─ geral/            uma pasta para cada canal de channels.csv
│  └─ 2024-01.csv    autor,data,texto
├─ directmessages/   mensagens diretas (opcional)
│  └─ conversas.csv  de,para,data,texto
└─ contacts.csv      contatos do omnichannel (opcional)`;

const CSV_EXAMPLE = `users.csv        joao,joao@empresa.com,João Silva
channels.csv     geral,joao,public,joao;maria
geral/2024.csv   joao,1704106800000,"Bom dia, pessoal!"`;

const CONTACTS_EXAMPLE = `name,emails,phones,manager,id,empresa
Ana Souza,ana@cliente.com;ana.s@gmail.com,+55 11 99999-0000,maria,c-001,ACME`;

export function FormatHelp({ importerKey, canUsePath }: { importerKey: string; canUsePath: boolean }) {
  return (
    <aside className="card imp-help">
      {importerKey === 'csv' && (
        <>
          <h3>Como montar o .zip</h3>
          <pre className="code-block imp-tree">{CSV_TREE}</pre>
          <p className="small muted">Exemplos de linhas:</p>
          <pre className="code-block imp-tree">{CSV_EXAMPLE}</pre>
          <ul className="imp-help-list">
            <li>Só contacts.csv tem linha de cabeçalho; os outros arquivos começam direto nos dados.</li>
            <li>A data é em milissegundos desde 1970. Também vale em segundos ou no formato ISO (2024-01-01T14:00:00Z).</li>
            <li>Texto com vírgula, aspas ou quebra de linha vai entre aspas duplas.</li>
            <li>Autores e membros que não estão em users.csv precisam já ter conta aqui, com o mesmo nome de usuário.</li>
            <li>Uma pasta de mensagens sem linha em channels.csv é ignorada, com aviso, a não ser que o canal tenha vindo de uma importação CSV anterior.</li>
            <li>Tudo bem se o .zip tiver uma pasta em volta de tudo.</li>
            {canUsePath && <li>Pelo caminho no servidor, também dá para indicar uma pasta já descompactada.</li>}
          </ul>
        </>
      )}
      {importerKey === 'slack' && (
        <>
          <h3>Exportação do Slack</h3>
          <ol className="imp-help-list">
            <li>No Slack, abra as configurações do espaço de trabalho e vá em Importar/exportar dados › Exportar.</li>
            <li>Baixe o .zip e envie aqui sem descompactar.</li>
          </ol>
          <ul className="imp-help-list">
            <li>Vêm usuários, canais e, se a exportação tiver, grupos privados e mensagens diretas, com threads, reações, edições e mensagens fixadas.</li>
            <li>Os arquivos das mensagens não vêm no .zip. Depois de importar, use "Baixar arquivos pendentes" no histórico; faça isso logo, porque os links do Slack podem expirar.</li>
            <li>As fotos de perfil são baixadas em "Baixar fotos pendentes".</li>
            <li>O canal geral do Slack vira o canal padrão daqui.</li>
          </ul>
        </>
      )}
      {importerKey === 'slack-users' && (
        <>
          <h3>Lista de membros do Slack</h3>
          <ul className="imp-help-list">
            <li>No Slack: Gerenciar membros › Exportar lista de membros. Envie o .csv como veio.</li>
            <li>Colunas usadas: username, email, status, fullname e displayname.</li>
            <li>Status "Admin" vira administrador (só em conta nova, e se você pode dar esse papel), "Bot" vira bot e "Deactivated" cria a conta desativada.</li>
            <li>Linhas sem e-mail são ignoradas.</li>
          </ul>
        </>
      )}
      {importerKey === 'omnichannel_contact' && (
        <>
          <h3>Contatos do omnichannel</h3>
          <pre className="code-block imp-tree">{CONTACTS_EXAMPLE}</pre>
          <ul className="imp-help-list">
            <li>A primeira linha é o cabeçalho.</li>
            <li>Vários e-mails ou telefones vão separados por ponto e vírgula.</li>
            <li>manager é o nome de usuário de quem cuida do contato; id é opcional.</li>
            <li>As outras colunas viram campos personalizados do contato, se existirem em Atendimento › Campos.</li>
            <li>Um contato com o mesmo e-mail de um já existente completa o cadastro dele, sem duplicar.</li>
          </ul>
        </>
      )}
      <h3>Bom saber</h3>
      <ul className="imp-help-list">
        <li>Antes de importar você vê o que foi lido e escolhe o que entra.</li>
        <li>Contas com o mesmo e-mail de uma conta daqui são juntadas a ela.</li>
        <li>Importar o mesmo arquivo de novo atualiza o que já foi importado, sem duplicar.</li>
      </ul>
      <details className="imp-help-more">
        <summary>Ver detalhes</summary>
        <ul className="imp-help-list">
          <li>
            O mesmo nome de usuário só junta quando a conta é do mesmo tipo (pessoa ou bot) e os e-mails não se contradizem; senão o usuário entra com outro nome, com aviso.
          </li>
          <li>Nome de usuário, e-mail e senha de uma conta que já existe não mudam, e ela nunca ganha o papel de administrador pela importação.</li>
          <li>Um canal público com o nome de um canal daqui recebe as mensagens, sem mudar os membros. Um grupo privado com nome repetido vira outra sala, com outro nome.</li>
          <li>Usuários novos entram sem senha: definem uma em "Esqueci minha senha", ou marque o envio do e-mail na próxima etapa.</li>
        </ul>
      </details>
    </aside>
  );
}
