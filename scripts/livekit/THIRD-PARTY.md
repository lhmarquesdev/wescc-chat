# Componentes de terceiros das chamadas em grupo

Nenhum binário fica no repositório. Os instaladores (`install-windows.ps1` e `install-linux.sh`) baixam as versões
fixadas em [`versions.json`](versions.json) das releases oficiais no GitHub e conferem o SHA-256 antes de instalar
qualquer coisa. O `livekit-client` vem do npm, na versão exata de `web/package.json`, conferida pelo
`package-lock.json`.

| Componente | Versão | Licença | Para que serve | Origem |
|---|---|---|---|---|
| LiveKit server | 1.13.9 | Apache-2.0 | o servidor de chamadas em grupo (serviço `wescc-livekit`) | https://github.com/livekit/livekit |
| LiveKit CLI (`lk`) | 2.19.0 | Apache-2.0 | só o teste de carga manual, antes de ir para produção | https://github.com/livekit/livekit-cli |
| `livekit-client` | a de `web/package.json` | Apache-2.0 | as chamadas em grupo no navegador | https://github.com/livekit/client-sdk-js |
| WinSW | 2.12.0 (`WinSW-x64.exe`) | MIT | roda o LiveKit como serviço do Windows (`wescc-livekit.exe`) | https://github.com/winsw/winsw |

O texto completo da Apache License 2.0 vem no arquivo `LICENSE` de cada pacote do LiveKit e está em
https://www.apache.org/licenses/LICENSE-2.0.

## LiveKit server 1.13.9 (NOTICE)

```text
Copyright 2023 LiveKit, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## LiveKit CLI (`lk`) 2.19.0 (NOTICE)

```text
Copyright 2023 LiveKit, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## livekit-client (NOTICE, igual nas versões 2.22.3 e 2.22.4)

```text
Copyright 2021 LiveKit, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## WinSW 2.12.0 (LICENSE.txt)

A release 2.12.0 não publica arquivo de checksums. O SHA-256 de `versions.json` foi calculado do `WinSW-x64.exe`
baixado da release oficial, e a transferência foi conferida pelo MD5 que o GitHub informa para o arquivo.

```text
MIT License

Copyright (c) 2008-2020 Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees, Inc., Oleg Nenashev and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
