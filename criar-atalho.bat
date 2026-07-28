@echo off
REM criar-atalho.bat - RECEPCAO (Dell). De dois cliques neste arquivo.
REM
REM Existe por causa da politica de execucao do Windows: nos computadores da escola o
REM PowerShell recusa rodar .ps1 clicado direto. O -ExecutionPolicy Bypass abaixo vale
REM SO para esta execucao - nao mexe na configuracao da maquina, que continua protegida
REM para todo o resto.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0criar-atalho.ps1"
echo.
pause
