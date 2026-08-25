@echo off
rem ===================================================================
rem  ENSAIO COM O ALUNO-MODELO - dois cliques.
rem
rem  Sobe o Wizard na 8421 (a porta do ENSAIO) sobre uma COPIA do banco em
rem  que existe UM aluno so: o Joao da Silva (9001), inventado.
rem
rem  O painel de verdade continua na 8420 e pode ficar aberto ao lado: sao
rem  dois servidores, dois bancos, duas abas. A da 8421 tem uma faixa
rem  listrada no topo dizendo que aquilo nao e o banco da recepcao.
rem
rem  O wizard.db da recepcao NAO e tocado em momento nenhum. O que este
rem  script apaga e a copia - e a copia e refeita toda vez.
rem
rem  O que sobrevive da copia: o catalogo inteiro que voce montou a mao -
rem  livros, estagios com as licoes digitadas, materiais, exemplares
rem  numerados e o calendario letivo. Sai so a OPERACAO: alunos, aulas,
rem  presencas, entregas e os professores (nomes reais em repo publico).
rem
rem  Para encerrar o ensaio: feche esta janela. O painel de verdade, na
rem  8420, nao e afetado em momento nenhum.
rem ===================================================================
setlocal
cd /d "%~dp0"

rem A 8421 e FIXA. Ocupada quer dizer que ja existe um ensaio no ar - entao
rem para e diz, em vez de escorregar para a 8422. Procurar a proxima porta
rem livre foi exatamente o que produziu a escalada ate a 8430.
rem A 8420 NAO e conferida: o painel de verdade pode continuar aberto.
netstat -ano | findstr /r /c:":8421 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   A porta 8421 ja esta ocupada - ha um ensaio no ar.
  echo   Feche a janela dele e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

if not exist wizard.db (
  rem sem banco de producao aqui: nasce um do zero, com o catalogo de fabrica
  echo   Nao achei wizard.db - criando um banco novo a partir do seed...
  del /q wizard-ensaio.db >nul 2>&1
  set WIZ_DB=wizard-ensaio.db
  deno run -A main.ts --init
  if errorlevel 1 goto :erro
  echo   Montando o aluno-modelo...
  deno run -A aluno-modelo.ts --db=wizard-ensaio.db
  if errorlevel 1 goto :erro
) else (
  rem A COPIA E FEITA PELO SQLITE, nao pelo `copy`: com o ensaio em porta propria
  rem o painel de verdade fica no ar durante a copia, e copiar arquivo de um
  rem SQLite aberto pega um estado possivelmente torto. O --de usa VACUUM INTO,
  rem que e o mesmo mecanismo do backup automatico do main.ts.
  echo   Copiando o banco e montando o aluno-modelo...
  deno run -A aluno-modelo.ts --de=wizard.db --db=wizard-ensaio.db
  if errorlevel 1 goto :erro
)

echo.
echo   Pronto. Subindo o Wizard sobre a copia, com o Joao da Silva.
echo   A faixa no topo da tela avisa que este NAO e o banco da recepcao.
echo.
echo   FECHE ESTA JANELA para parar o ensaio e liberar a 8421.
echo.
rem o navegador abre num processo a parte, com atraso, porque o servidor
rem abaixo segura ESTA janela: e o que faz fechar a janela parar o ensaio.
rem Sem isso o servidor ficaria orfao segurando a 8421.
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" msedge --app=http://localhost:8421"
set WIZ_DB=wizard-ensaio.db
deno run -A main.ts
exit /b 0

:erro
echo.
echo   Algo deu errado acima - o wizard.db NAO foi tocado.
echo.
pause
exit /b 1
