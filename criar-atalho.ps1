# criar-atalho.ps1 - roda UMA VEZ em cada computador (notebook e recepcao).
#
# Faz TRES coisas, e a segunda e a que resolve o icone do Edge na barra de tarefas:
#   1. cria o atalho "Wizard Recepcao" na area de trabalho, com o icone da escola;
#   2. poe o SERVIDOR na inicializacao do Windows, para ele estar sempre no ar;
#   3. explica o passo do "instalar como aplicativo", que e o que da icone proprio.
#
# POR QUE O ICONE DA BARRA ERA DO EDGE (diagnostico de 2026-08-18):
#   O atalho da area de trabalho SEMPRE teve o icone certo. O que aparecia com a logo do
#   Edge era a JANELA na barra de tarefas: "msedge --app=" abre uma janela que pertence ao
#   Edge, e o Windows usa a identidade dele no botao. Quem da identidade propria e instalar
#   o site como APLICATIVO.
#   So que o aplicativo instalado abria "pagina nao disponivel": ele vai direto na URL e NAO
#   sobe o servidor. Os dois problemas eram o mesmo - servidor fora do ar.
#   Com o servidor na inicializacao, o aplicativo instalado funciona E fica com o icone certo.
#
# Uso: botao direito neste arquivo -> "Executar com o PowerShell".
# Se o Windows bloquear por politica de execucao:
#   powershell -ExecutionPolicy Bypass -File criar-atalho.ps1

$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell

# ---- 1. atalho na area de trabalho -------------------------------------------------
$area = [Environment]::GetFolderPath('Desktop')
$atalho = $ws.CreateShortcut("$area\Wizard Recepcao.lnk")
$atalho.TargetPath = "$pasta\iniciar-app.vbs"
$atalho.WorkingDirectory = $pasta
$atalho.IconLocation = "$pastaesources\wizard-icon.ico"
$atalho.Description = "Wizard Recepcao"
$atalho.Save()
Write-Host "1/3  Atalho criado: $area\Wizard Recepcao.lnk"

# ---- 2. servidor na inicializacao do Windows ---------------------------------------
# Pasta Startup do usuario: nao pede administrador e sobe junto com a sessao dele.
$startup = [Environment]::GetFolderPath('Startup')
$svc = $ws.CreateShortcut("$startup\Wizard - servidor.lnk")
$svc.TargetPath = "$pasta\servidor.vbs"
$svc.WorkingDirectory = $pasta
$svc.IconLocation = "$pastaesources\wizard-icon.ico"
$svc.Description = "Sobe o servidor do Wizard ao entrar no Windows"
$svc.Save()
Write-Host "2/3  Servidor registrado na inicializacao: $startup\Wizard - servidor.lnk"

# sobe agora tambem, para nao precisar reiniciar
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$pasta\servidor.vbs`"" -WindowStyle Hidden
Write-Host "     (servidor iniciado agora, sem precisar reiniciar)"

# ---- 3. o passo do icone ------------------------------------------------------------
Write-Host ""
Write-Host "3/3  FALTA UM PASSO MANUAL, uma vez so por computador:"
Write-Host "     abra o app, clique nos tres pontinhos do Edge (...) -> Aplicativos ->"
Write-Host "     'Instalar este site como um aplicativo'."
Write-Host "     A partir dai a JANELA passa a ter a logo da escola na barra de tarefas,"
Write-Host "     e o atalho do aplicativo vai funcionar sempre, porque o servidor agora"
Write-Host "     sobe junto com o Windows."
Write-Host ""
