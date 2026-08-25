@echo off
rem ===================================================================
rem  Instancia de ENSAIO do wiztools
rem
rem  Sobe o servidor sobre uma COPIA do banco, na 8421 - a porta do
rem  ensaio. O painel de verdade continua na 8420 e pode ficar aberto.
rem
rem  A PORTA DO ENSAIO, IDA E VOLTA
rem  Em 2026-08-23 isto subia numa porta a parte e o launch.json pedia
rem  autoPort: o harness escolhia uma LIVRE a cada ensaio e a coisa foi
rem  subindo - 8421, 8422, 8423. Ordem dele: uma porta so. O ensaio
rem  passou a exigir que o servidor de verdade saisse antes.
rem  Em 2026-08-25 ele pediu a segunda porta de volta, para rodar os dois
rem  ao mesmo tempo. Nao e desfazer a decisao: a queixa era a FABRICA de
rem  portas, nao a segunda porta. Por isso a 8421 e FIXA, e o WIZ_PORT so
rem  vale junto do WIZ_DB - sem banco de ensaio a porta e 8420 e ponto.
rem
rem  O que protege os dados da escola nunca foi a porta: e o WIZ_DB, que
rem  troca o arquivo do banco por uma copia e desliga a escrita na pasta
rem  de backup. Na tela, o ensaio se anuncia sozinho com uma faixa
rem  listrada no topo dizendo QUAL banco esta aberto.
rem ===================================================================
setlocal
cd /d "%~dp0.."

rem a 8421 e fixa: ocupada quer dizer que ja ha um ensaio no ar. Para e
rem diz, em vez de escorregar para a 8422 - foi assim que a escalada
rem comecou da primeira vez.
netstat -ano | findstr /r /c:":8421 .*LISTENING" >nul
if not errorlevel 1 (
  echo [ensaio] a 8421 ja esta ocupada - feche o ensaio que esta no ar
  exit /b 1
)

rem a copia e feita pelo SQLITE (VACUUM INTO dentro do aluno-modelo.ts) e
rem nao por `copy`: com o painel de verdade no ar durante a copia, copiar
rem arquivo de um SQLite aberto pega um estado possivelmente torto.
deno run -A aluno-modelo.ts --de=wizard.db --db=wizard-ensaio.db
if errorlevel 1 exit /b 1

set WIZ_DB=wizard-ensaio.db
echo [ensaio] subindo na 8421 sobre wizard-ensaio.db
deno run -A main.ts
