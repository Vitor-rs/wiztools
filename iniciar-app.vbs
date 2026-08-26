' iniciar-app.vbs - abre o Wizard como um programa normal do Windows: sem terminal e sem
' barra de navegador. Aponte o ATALHO DA AREA DE TRABALHO para ESTE arquivo (nao para o
' iniciar.bat, que e so para uso manual e mostra a janela do servidor).
'
' Ele agora ESPERA A PORTA RESPONDER antes de abrir a tela. O codigo antigo dormia 1800ms
' e torcia: em maquina fria o servidor ainda nao estava de pe e o Edge abria em "pagina
' nao disponivel" - o mesmo sintoma que ele via no PWA.
Option Explicit
Dim sh, pasta, i
Set sh = CreateObject("WScript.Shell")
pasta = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = pasta

If Not PortaViva() Then
  sh.Run "cmd /c git pull --ff-only", 0, True
  ' --producao: o comando cru abre o banco de MOCK desde 2026-08-26. Este e o atalho da
' RECEPCAO, entao ele pede o banco da escola por escrito.
sh.Run "cmd /c deno run -A main.ts --producao", 0, False
  For i = 1 To 60
    WScript.Sleep 500
    If PortaViva() Then Exit For
  Next
End If

' --app= abre uma janela sem barra de navegacao. O icone da BARRA DE TAREFAS so fica com a
' logo da escola depois de instalar como aplicativo (veja criar-atalho.ps1).
sh.Run "msedge --app=http://localhost:8420", 1, False

Function PortaViva()
  Dim x
  PortaViva = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", "http://localhost:8420/", False
  x.Send
  If Err.Number = 0 And x.Status >= 200 Then PortaViva = True
  On Error GoTo 0
End Function
