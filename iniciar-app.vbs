' iniciar-app.vbs — abre o Wizard Recepção como um programa normal do Windows: sem
' terminal, sem barra de navegador do Edge. Aponte o ATALHO DA ÁREA DE TRABALHO para
' ESTE arquivo (não para o iniciar.bat, que é só para uso manual/desenvolvimento e
' mostra uma janela do servidor). Para criar o atalho automaticamente, rode uma vez
' criar-atalho.ps1.
Set sh = CreateObject("WScript.Shell")
pasta = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = pasta

' 1) busca atualização (silencioso; sem internet ou sem Git instalado, só segue)
sh.Run "cmd /c git pull --ff-only", 0, True

' 2) sobe o servidor Deno em segundo plano, sem NENHUMA janela — nem minimizada.
'    Se já tiver um servidor rodando (app já aberto antes), essa tentativa falha
'    baixinho (porta já em uso) e o servidor existente continua servindo normal.
sh.Run "cmd /c deno run -A main.ts", 0, False

' 3) dá tempo do servidor subir e abre o app numa janela própria do Edge
WScript.Sleep 1800
sh.Run "msedge --app=http://localhost:8420", 1, False
