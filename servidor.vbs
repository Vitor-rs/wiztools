' servidor.vbs - sobe o servidor do Wizard SEM NENHUMA JANELA e sem duplicar.
'
' POR QUE ESTE ARQUIVO EXISTE (2026-08-18):
' O atalho da area de trabalho ja tinha o icone certo, mas a JANELA na barra de tarefas
' aparecia com o icone do Edge. A causa: "msedge --app=" abre uma janela que pertence ao
' Edge, e o Windows usa a identidade do Edge para o botao da barra. Quem resolve isso e
' instalar o site como APLICATIVO (PWA) - ai a janela ganha identidade e icone proprios.
' So que o PWA abria "pagina nao disponivel", porque ele vai direto na URL e NAO sobe o
' servidor. Ou seja: os dois problemas eram o mesmo problema.
' Com este arquivo rodando na inicializacao do Windows, o servidor esta sempre no ar e o
' PWA funciona - com o icone certo na barra.
Option Explicit
Dim sh, pasta, i, ok
Set sh = CreateObject("WScript.Shell")
pasta = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = pasta

' ja esta no ar? entao nao faz nada (duas instancias brigariam pela porta e pelo banco)
If PortaViva() Then WScript.Quit 0

' busca atualizacao, em silencio; sem internet ou sem Git, apenas segue
sh.Run "cmd /c git pull --ff-only", 0, True
' 0 = sem janela nenhuma; False = nao espera terminar (o servidor fica rodando)
sh.Run "cmd /c deno run -A main.ts", 0, False

' espera a porta responder de verdade - ate 30s. O "sleep 1800" antigo era um chute:
' em maquina fria o Deno demora mais, e o navegador abria antes de existir servidor.
ok = False
For i = 1 To 60
  WScript.Sleep 500
  If PortaViva() Then
    ok = True
    Exit For
  End If
Next
WScript.Quit 0

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
