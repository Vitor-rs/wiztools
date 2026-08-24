@echo off
rem ===================================================================
rem  Instancia de ENSAIO do wiztools
rem
rem  Sobe o servidor sobre uma COPIA do banco, na MESMA porta 8420.
rem
rem  UMA PORTA SO (ordem dele, 2026-08-23). Antes isto subia numa porta
rem  a parte (8421, e com autoPort no launch.json ia subindo: 8422...).
rem  O projeto tem UMA porta, a 8420: e a que iniciar.bat, iniciar-app.vbs,
rem  iniciar-sala.vbs, servidor.vbs e a regra do firewall conhecem.
rem
rem  O que protege os dados da escola NAO era a porta - e o WIZ_DB, que
rem  troca o arquivo do banco por uma copia e desliga a escrita na pasta
rem  de backup. O ensaio agora exige PARAR o servidor de verdade antes,
rem  e o servidor de verdade volta depois.
rem
rem  Na tela, o ensaio se anuncia sozinho: com WIZ_DB setado o app pinta
rem  uma faixa no topo dizendo que aquilo nao e o banco da recepcao.
rem ===================================================================
setlocal
cd /d "%~dp0.."

rem a 8420 tem de estar livre: se o servidor de verdade esta no ar, e ele
rem que precisa sair primeiro - subir por cima seria dois processos
rem escrevendo bancos diferentes e um deles morrendo no bind
netstat -ano | findstr /r /c:":8420 .*LISTENING" >nul
if not errorlevel 1 (
  echo [ensaio] a 8420 esta ocupada - pare o servidor de verdade antes de ensaiar
  exit /b 1
)

rem copia torta e pior que copia nenhuma: se ha escrita em andamento,
rem para e pede para tentar de novo (mesma guarda do backup no main.ts)
if exist wizard.db-journal (
  echo [ensaio] ha uma escrita em andamento no wizard.db - tente de novo em alguns segundos
  exit /b 1
)

copy /Y wizard.db wizard-ensaio.db >nul
if errorlevel 1 (
  echo [ensaio] nao consegui copiar o wizard.db
  exit /b 1
)

set WIZ_DB=wizard-ensaio.db
echo [ensaio] copia feita - subindo na 8420 sobre wizard-ensaio.db
deno run -A main.ts
