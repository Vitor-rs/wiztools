@echo off
rem ===================================================================
rem  Instancia de ENSAIO do wiztools (usada pelo preview do Claude Code)
rem
rem  Sobe o servidor sobre uma COPIA do banco, numa porta que nao e a
rem  8420. A 8420 e o painel da recepcao: e o servidor que a escola esta
rem  usando, e o wizard.db dele e o banco de producao.
rem
rem  Sem isto, o preview subiria "deno run -A main.ts" puro - que abre o
rem  wizard.db vivo. Seriam dois processos escrevendo o mesmo arquivo
rem  SQLite, e qualquer teste meu cairia nos dados da escola.
rem
rem  As variaveis WIZ_DB e WIZ_PORT existem no main.ts so para isto.
rem  Com WIZ_DB setado o servidor tambem NAO escreve na pasta de backup.
rem ===================================================================
setlocal
cd /d "%~dp0.."

rem porta: a que o harness atribuir (PORT), senao a 8421 de sempre
if "%PORT%"=="" set PORT=8421

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
set WIZ_PORT=%PORT%
echo [ensaio] copia feita - subindo na porta %PORT% sobre wizard-ensaio.db
deno run -A main.ts
