@echo off
rem ============================================================
rem  Wizard Recepcao - iniciar o aplicativo
rem  1) puxa a versao mais nova do GitHub (se tiver internet)
rem  2) sobe o servidor local (janela minimizada)
rem  3) abre o aplicativo numa janela propria do Edge
rem  Se o servidor ja estiver rodando, so abre a janela.
rem ============================================================
cd /d "%~dp0"
echo Buscando atualizacao...
git pull --ff-only
start "Wizard Servidor" /min cmd /c "deno run -A main.ts"
timeout /t 2 /nobreak >nul
start "" msedge --app=http://localhost:8420
