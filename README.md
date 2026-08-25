# wiztools — Wizard Recepção

Painel local da recepção da Wizard Naviraí: alunos, turmas, horários e impressão das
fichas de frequência (blocos de hora). Servidor Deno + SQLite, zero dependências
externas — roda offline, os dados ficam na máquina.

## Rodar (desenvolvimento)

```
deno run -A main.ts        →  http://localhost:8420
deno run -A main.ts --init →  cria wizard.db do zero (SÓ na primeira vez — ver aviso abaixo)
```

## Colocar em produção (desktop da recepção)

1. Instalar [Git](https://git-scm.com/download/win) e [Deno](https://deno.com) (aceitar os padrões).
2. Clonar o repositório numa pasta fixa, ex.: `C:\wiztools`:
   `git clone https://github.com/Vitor-rs/wiztools.git C:\wiztools`
3. Copiar o `wizard.db` de produção para dentro da pasta (o banco NÃO vem pelo Git — de propósito).
   Transferência fácil: o notebook publica o banco em `OneDrive\WizardBackup\wizard-recepcao.db`;
   no desktop, espere o OneDrive sincronizar, copie esse arquivo para `C:\wiztools` e renomeie
   para `wizard.db`.
4. Dar dois cliques em `iniciar.bat` uma vez, só pra confirmar que sobe (a janela do servidor
   aparece — normal aqui, é só pra teste). Na primeira vez o Windows vai pedir para liberar o
   Deno no firewall — aceitar (isso permite acessar de outros computadores da escola). Feche
   essa janela depois de conferir.
5. Rodar `criar-atalho.ps1` uma vez (botão direito → Executar com o PowerShell): cria o atalho
   **"Wizard Recepção"** na área de trabalho, já com o ícone da Wizard, apontando para
   `iniciar-app.vbs`. Esse é o atalho do dia a dia — abre **sem nenhum terminal na tela** e sem
   barra de navegador, só a janela do
   app, como um programa normal do Windows.
6. (Opcional, mas recomendado) Com o app aberto, no Edge: `⋯` → Aplicativos → **Instalar este
   site como aplicativo**. Uma vez por computador. Sem isso, a janela do app já usa o ícone da
   Wizard (não o do Edge) — mas com essa instalação, o Windows passa a tratar o Wizard como um
   programa de verdade também na **barra de tarefas** (ícone próprio lá também, não o do Edge).

- **Acesso de outros computadores da rede**: `http://IP-do-desktop:8420` no navegador.
- **Atualizações**: o atalho faz `git pull` a cada abertura. Fechou e abriu = atualizado.
  Sem internet, ele apenas abre a versão que já está instalada.
- **Backup**: a cada dia, na primeira abertura, um snapshot do banco é salvo automaticamente em
  DOIS lugares: uma pasta oculta do computador (`%LOCALAPPDATA%\WizardBackup`) e, quando existir,
  o OneDrive (`OneDrive\WizardBackup` por padrão — destino preferido). A aba **Backup** do app
  permite escolher outra pasta do OneDrive e fazer uma cópia manual na hora. A pasta escolhida é
  gravada de forma portável (relativa à raiz do OneDrive), então funciona igual no notebook e na
  recepção mesmo com usuários do Windows diferentes — não é preciso configurar em cada máquina.

## As três máquinas da escola (rede 192.168.3.x)

O banco vive **num lugar só**: o Dell da recepção. Os notebooks não rodam servidor nem têm cópia
do banco — se cada um tivesse a sua, a presença lançada na sala nunca chegaria à recepção.

| Máquina | Nome do Windows | IP | Papel no app | Atalho |
|---|---|---|---|---|
| Dell 24 All-in-One | `WIZARD-DESKTOP-` | `.121` (cabo) / `.122` (Wi-Fi) | **Entrada Recep** (dropdown P/✕/–) | `criar-atalho.ps1` |
| Notebook Asus | `ASUS-WIZARD-NAV` | `.6` | **Presença** (entrada/saída) | `criar-atalho-sala.ps1` |
| Notebook Samsung | `DESKTOP-QC59NKL` | `.65` | **Presença** (entrada/saída) | `criar-atalho-sala.ps1` |

Quem decide o papel é o **IP de quem abre a tela** (lista `ESTACOES` no `main.ts`), não a máquina
que serve — todos falam com o mesmo servidor, então usar o hostname faria todo mundo virar "Dell".
A aba que não é da estação some da barra lateral. No rodapé da barra aparece qual estação é;
em amarelo quando o IP não está cadastrado.

Máquina desconhecida (IP novo do DHCP, celular) entra como **sala**, que é o perfil mais restrito.
Para forçar em fase de teste: `?papel=sala`, `?papel=recepcao` ou `?papel=auto` na URL — fica
gravado naquela máquina.

> **Política de execução:** o Dell e o Samsung recusam rodar `.ps1` clicado direto. Por isso cada
> script tem um `.bat` de dois cliques ao lado, que chama o PowerShell com
> `-ExecutionPolicy Bypass`. Esse bypass vale **só para aquela execução** — a configuração da
> máquina não é alterada e continua protegida para todo o resto. Use sempre os `.bat`.

### Instalar na recepção (Dell) — é quem manda

1. Passos 1 a 6 da seção acima (é a máquina que roda o servidor e guarda o banco).
2. `liberar-firewall.bat` → **botão direito → Executar como administrador**, uma vez. Abre a porta
   8420 para a rede local; sem isso o Dell só responde a si mesmo e os notebooks não conectam.
3. `criar-atalho.bat` → cria o atalho **"Wizard Recepção"**.
4. Reservar o IP do Dell no roteador (IP fixo). Com DHCP o endereço pode trocar e os notebooks
   perdem o servidor.

### Instalar nos notebooks (Asus e Samsung)

1. Instalar só o **Git** (não precisa de Deno: o notebook não roda servidor).
2. `git clone https://github.com/Vitor-rs/wiztools.git C:\wiztools`
3. `criar-atalho-sala.bat` → cria o atalho **"Wizard Sala"**.
4. Se o IP do Dell mudar, editar a linha `SERVIDOR` no `iniciar-sala.vbs`.

O Dell precisa estar **ligado e com o Wizard aberto** para os notebooks funcionarem.

### As duas portas

| Porta | O quê | Quem conhece |
|---|---|---|
| **8420** | o painel de verdade, sobre o `wizard.db` | `iniciar.bat`, `iniciar-app.vbs`, `iniciar-sala.vbs`, `servidor.vbs`, a regra do firewall e os notebooks |
| **8421** | o ensaio, sobre uma cópia | `ensaiar-aluno-modelo.bat` e `.claude/ensaio.cmd` |

A 8421 só existe quando há `WIZ_DB` — sem banco de ensaio a porta é 8420 e ponto, para que nenhuma
variável esquecida no ambiente faça a recepção acordar num número que o firewall não liberou. As
duas são FIXAS: ocupada, o ensaio recusa e diz, em vez de escorregar para a 8422.

### Tempo real

As telas conversam por WebSocket: lançou na sala, a recepção vê na hora, e vice-versa. Se a
conexão cair, o navegador reconecta sozinho e ainda há uma verificação a cada 15s como rede de
segurança.

## Fluxo de trabalho

- O **desktop da recepção** tem o único `wizard.db` que vale (produção). Dados são editados lá.
- O notebook é só desenvolvimento: mexeu no código → testou → `git push`. A recepção recebe na
  próxima abertura do app.

## ⚠️ Avisos importantes

- **NUNCA** rode `--init` num banco em uso: ele recria o `wizard.db` do zero pelo `seed.sql`
  (dados de julho/2026) e **apaga tudo que foi editado depois**. Mudança de schema em banco
  vivo = migração aditiva (`ALTER TABLE`), nunca reseed.
- O `wizard.db` fica fora do Git (`.gitignore`) e fora da pasta do OneDrive (sincronizador +
  SQLite aberto corrompe o arquivo — o backup diário é uma CÓPIA, e isso é seguro).

## Arquivos

| Arquivo | Papel |
|---|---|
| `main.ts` | servidor Deno + toda a regra de negócio (API em `/api/*`) |
| `app.html` | interface única (Início, Alunos, Turmas, Horários, Impressão) |
| `blocos.js` | renderização dos blocos de hora (impressão e prévias — fonte única) |
| `resources/print.css` | layout A4 paisagem das fichas |
| `schema.sql` / `seed.sql` | estrutura do banco / carga inicial histórica |
| `iniciar.bat` | inicia mostrando a janela do servidor — uso manual/desenvolvimento |
| `iniciar-app.vbs` | RECEPÇÃO: sobe o servidor sem janela nenhuma — atalho de produção do Dell |
| `iniciar-sala.vbs` | NOTEBOOKS: só abre a tela apontando para o Dell (não sobe servidor) |
| `criar-atalho.bat` / `.ps1` | roda uma vez no Dell pra criar o atalho "Wizard Recepção" |
| `criar-atalho-sala.bat` / `.ps1` | roda uma vez em cada notebook pra criar o atalho "Wizard Sala" |
| `liberar-firewall.bat` | roda uma vez no Dell, como admin: abre a porta 8420 para a rede |
| `ensaiar-aluno-modelo.bat` | dois cliques: copia o banco, monta o aluno fictício e sobe o app na cópia |
| `aluno-modelo.ts` | esvazia um banco de cópia e monta o aluno fictício de desenvolvimento |
| `modelo-dados-aluno.xlsx` | o modelo de dados em planilha: uma aba por tabela do banco |
| `exportar-modelo-xlsx.py` | refaz essa planilha quando o esquema mudar (dev; precisa de openpyxl) |

## Banco de trabalho com um aluno fictício

O `wizard.db` da recepção tem gente real e a operação de verdade. Para desenvolver e testar sem
tocar nele existe o **aluno-modelo**: um banco com o catálogo inteiro (livros, estágios, materiais,
calendário) e **um único aluno inventado** — João da Silva, matrícula 9001, Kids 2 3rd Edition,
terças e quintas às 13:00, matriculado em 13/04/2026.

**Dois cliques em `ensaiar-aluno-modelo.bat`.** Ele copia o `wizard.db`, monta o João na cópia e
sobe o app em cima dela — **na 8421**, sem encostar no painel de verdade, que continua na 8420. Os
dois rodam ao mesmo tempo, em duas abas: `localhost:8420` é a escola, `localhost:8421` é o ensaio,
com uma faixa listrada no topo dizendo qual banco está aberto. Fechar a janela preta encerra o
ensaio. O `wizard.db` não é tocado em momento nenhum.

À mão, se preferir:

```
deno run -A aluno-modelo.ts --de=wizard.db --db=wizard-ensaio.db
set WIZ_DB=wizard-ensaio.db  &&  deno run -A main.ts     → http://localhost:8421
```

A cópia é feita por dentro, com `VACUUM INTO`, e não por `copy`: com o painel de verdade no ar,
copiar o arquivo de um SQLite aberto pode pegar um estado torto. É o mesmo mecanismo que o backup
automático do `main.ts` usa antes de cada migração.

Ele apaga toda a operação, preserva o catálogo e reconstrói o João com frequência até hoje: faltas,
reposições, anteposições, duas aulas de tarefa e um primeiro dia com duas lições na mesma hora — o
bastante para as telas de planejamento, progresso e encaminhamentos terem o que mostrar.

O catálogo sobrevive inteiro, inclusive o **trabalho editorial**: se o estágio já tem lições
digitadas, elas ficam como estão — a fórmula do modelo só entra quando não há nenhuma.

Três travas, porque o script apaga dados: `--db` é obrigatório, `wizard.db` é recusado pelo nome, e
a porta 8420 precisa estar livre (ele sobe o servidor sozinho para construir pelas rotas do app).

O **`modelo-dados-aluno.xlsx`** é esse mesmo banco exportado: uma aba por tabela, 42 no total, com
um índice na frente agrupado por assunto. Serve para ler o modelo de dados inteiro sem abrir o
SQLite — e para ver, tabela a tabela, tudo o que uma única matrícula toca. Quando o esquema mudar,
refaça a planilha com `python exportar-modelo-xlsx.py wizard-ensaio.db modelo-dados-aluno.xlsx`
(ferramenta de desenvolvimento; o app em si continua sem dependência nenhuma).
