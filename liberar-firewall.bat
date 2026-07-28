@echo off
REM liberar-firewall.bat - roda UMA VEZ, so no DELL da recepcao (o que serve o sistema).
REM
REM CLIQUE COM O BOTAO DIREITO -> "Executar como administrador".
REM
REM O QUE ISTO FAZ: abre a porta 8420 do Windows Firewall para conexoes que chegam da
REM rede local. Sem isso o Dell responde so a ele mesmo e os notebooks da sala nao
REM conseguem abrir a tela - o navegador fica "carregando" e nao vai.
REM
REM ESCOPO: so a porta 8420, so TCP, so entrada. Nao desliga o firewall, nao mexe em
REM nenhuma outra regra e nao expoe a maquina para fora da escola (o roteador nao
REM encaminha 192.168.x.x para a internet).
REM
REM Para desfazer depois:
REM   netsh advfirewall firewall delete rule name="Wizard 8420"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Precisa ser ADMINISTRADOR.
  echo  Feche esta janela, clique com o botao direito neste arquivo
  echo  e escolha "Executar como administrador".
  echo.
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="Wizard 8420" >nul 2>&1
netsh advfirewall firewall add rule name="Wizard 8420" dir=in action=allow protocol=TCP localport=8420
echo.
echo  Porta 8420 liberada. Os notebooks ja conseguem acessar este computador.
echo.
pause
