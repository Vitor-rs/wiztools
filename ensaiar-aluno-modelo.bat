@echo off
rem ===================================================================
rem  ENSAIO COM O ALUNO-MODELO - dois cliques.
rem
rem  Sobe o Wizard na 8420 de sempre, mas sobre uma COPIA do banco em que
rem  existe UM aluno so: o Joao da Silva (9001), inventado.
rem
rem  O wizard.db da recepcao NAO e tocado em momento nenhum. O que este
rem  script apaga e a copia - e a copia e refeita toda vez.
rem
rem  O que sobrevive da copia: o catalogo inteiro que voce montou a mao -
rem  livros, estagios com as licoes digitadas, materiais, exemplares
rem  numerados e o calendario letivo. Sai so a OPERACAO: alunos, aulas,
rem  presencas, entregas e os professores (nomes reais em repo publico).
rem
rem  Para voltar ao banco de verdade: feche esta janela e abra o Wizard
rem  como sempre (iniciar.bat ou o atalho da area de trabalho).
rem ===================================================================
setlocal
cd /d "%~dp0"

rem UMA PORTA SO (2026-08-23): a 8420 e a que iniciar.bat, iniciar-app.vbs,
rem iniciar-sala.vbs, servidor.vbs e a regra do firewall conhecem. Entao o
rem servidor de verdade precisa sair primeiro - subir por cima seriam dois
rem processos escrevendo bancos diferentes, e um deles morrendo no bind.
netstat -ano | findstr /r /c:":8420 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   A porta 8420 esta ocupada.
  echo   Feche o Wizard que esta aberto e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

rem copia torta e pior que copia nenhuma: se ha escrita em andamento no
rem banco, para e pede para tentar de novo (mesma guarda do backup)
if exist wizard.db-journal (
  echo   Ha uma escrita em andamento no wizard.db - tente de novo em alguns segundos.
  pause
  exit /b 1
)

if not exist wizard.db (
  rem sem banco de producao aqui: nasce um do zero, com o catalogo de fabrica
  echo   Nao achei wizard.db - criando um banco novo a partir do seed...
  set WIZ_DB=wizard-ensaio.db
  deno run -A main.ts --init
  if errorlevel 1 goto :erro
) else (
  echo   Copiando wizard.db para wizard-ensaio.db...
  copy /Y wizard.db wizard-ensaio.db >nul
  if errorlevel 1 goto :erro
)

echo   Montando o aluno-modelo...
deno run -A aluno-modelo.ts --db=wizard-ensaio.db
if errorlevel 1 goto :erro

echo.
echo   Pronto. Subindo o Wizard sobre a copia, com o Joao da Silva.
echo   A faixa no topo da tela avisa que este NAO e o banco da recepcao.
echo.
echo   FECHE ESTA JANELA para parar o ensaio e liberar a 8420.
echo.
rem o navegador abre num processo a parte, com atraso, porque o servidor
rem abaixo segura ESTA janela: e o que faz fechar a janela parar o ensaio.
rem Sem isso o servidor ficaria orfao e a 8420 presa para o iniciar.bat.
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" msedge --app=http://localhost:8420"
set WIZ_DB=wizard-ensaio.db
deno run -A main.ts
exit /b 0

:erro
echo.
echo   Algo deu errado acima - o wizard.db NAO foi tocado.
echo.
pause
exit /b 1
