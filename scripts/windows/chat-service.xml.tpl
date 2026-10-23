<?xml version="1.0" encoding="utf-8"?>
<!--
  Serviço do Windows do Wescc Chat (WinSW 2.x). Gerado por scripts\windows\install-chat-service.ps1 a partir de
  chat-service.xml.tpl: não edite à mão, rode o instalador de novo (com -Reconfigure para manter as escolhas).
  Nenhum segredo fica aqui: senhas e chaves estão em C:\Wescc\secrets e o chat lê os arquivos (*_FILE).
-->
<service>
  <id>wescc-chat</id>
  <name>Wescc Chat</name>
  <description>Chat interno Wescc (servidor Node.js).</description>
  <executable>{{NODE_EXE}}</executable>
  <arguments>"{{ENTRY}}"</arguments>
  <workingdirectory>{{WORK_DIR}}</workingdirectory>
  <startmode>Automatic</startmode>
  <!-- Depois dos serviços do sistema e do banco, que costumam subir junto com o Windows. -->
  <delayedAutoStart/>
  <!-- O WinSW manda Ctrl+C (SIGINT no Node) e espera o chat encerrar as conexões antes de matar o processo. -->
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>{{LOG_DIR}}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
{{ENV}}
</service>
