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
4. Dar dois cliques em `iniciar.bat`. Na primeira vez o Windows vai pedir para liberar o Deno
   no firewall — aceitar (isso permite acessar de outros computadores da escola).
5. Criar um atalho do `iniciar.bat` na área de trabalho (botão direito → Enviar para → Área de
   trabalho) e trocar o ícone se quiser. Pronto: clicou, abriu como um programa normal.

- **Acesso de outros computadores da rede**: `http://IP-do-desktop:8420` no navegador.
- **Atualizações**: o `iniciar.bat` faz `git pull` a cada abertura. Fechou e abriu = atualizado.
  Sem internet, ele apenas abre a versão que já está instalada.
- **Backup**: a cada dia, na primeira abertura, um snapshot do banco é salvo automaticamente em
  DOIS lugares: uma pasta oculta do computador (`%LOCALAPPDATA%\WizardBackup`) e, quando existir,
  o OneDrive (`OneDrive\WizardBackup` por padrão — destino preferido). A aba **Backup** do app
  permite escolher outra pasta do OneDrive e fazer uma cópia manual na hora.

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
| `iniciar.bat` | atalho de produção: atualiza, sobe o servidor e abre a janela |
