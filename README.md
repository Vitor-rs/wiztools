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
| `iniciar-app.vbs` | inicia SEM nenhuma janela — é para onde aponta o atalho de produção |
| `criar-atalho.ps1` | roda uma vez em cada máquina pra criar o atalho da área de trabalho |
