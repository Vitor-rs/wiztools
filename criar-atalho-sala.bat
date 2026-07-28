@echo off
REM criar-atalho-sala.bat - NOTEBOOKS de sala (Asus e Samsung). De dois cliques aqui.
REM
REM Existe por causa da politica de execucao do Windows: nos computadores da escola o
REM PowerShell recusa rodar .ps1 clicado direto. O -ExecutionPolicy Bypass abaixo vale
REM SO para esta execucao - nao mexe na configuracao da maquina, que continua protegida
REM para todo o resto.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0criar-atalho-sala.ps1"
echo.
pause
