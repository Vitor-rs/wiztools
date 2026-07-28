' iniciar-sala.vbs — atalho dos NOTEBOOKS (Asus e Samsung, salas de aula).
'
' Diferença para o iniciar-app.vbs: este NÃO sobe servidor e NÃO usa banco nenhum.
' O banco vive num lugar só, o Dell da recepção; o notebook apenas abre a tela apontando
' para lá. Se cada notebook subisse o próprio servidor, cada um teria a sua cópia do
' banco e a presença lançada na sala nunca chegaria à recepção.
'
' O Dell precisa estar LIGADO e com o Wizard aberto para isto funcionar.
'
' Para trocar o endereço do Dell (IP novo do roteador), mude só a linha SERVIDOR abaixo.
SERVIDOR = "http://192.168.3.121:8420"

Set sh = CreateObject("WScript.Shell")
pasta = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = pasta

' busca atualização do código (silencioso). O notebook não roda o servidor, mas manter o
' repositório em dia evita confusão quando alguém abrir o projeto ali.
sh.Run "cmd /c git pull --ff-only", 0, True

' abre direto na tela da sala. O papel também é decidido pelo servidor a partir do IP
' (ver ESTACOES no main.ts); o ?papel=sala aqui é o cinto de segurança para quando o
' roteador entregar um IP diferente ao notebook.
sh.Run "msedge --app=" & SERVIDOR & "/?papel=sala", 1, False
