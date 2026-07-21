# criar-atalho.ps1 — roda UMA VEZ em cada computador (notebook e recepção) para criar
# o atalho "Wizard Recepção" na área de trabalho, apontando para o iniciar-app.vbs
# (abre sem terminal e sem barra do Edge, como um programa normal do Windows), já com
# o ícone da Wizard em vez do ícone padrão de script.
#
# Uso: clique com o botão direito neste arquivo -> "Executar com o PowerShell".
# Se o Windows bloquear por política de execução, rode no PowerShell:
#   powershell -ExecutionPolicy Bypass -File criar-atalho.ps1

$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$area = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$atalho = $ws.CreateShortcut("$area\Wizard Recepção.lnk")
$atalho.TargetPath = "$pasta\iniciar-app.vbs"
$atalho.WorkingDirectory = $pasta
$atalho.IconLocation = "$pasta\resources\wizard-icon.ico"
$atalho.Description = "Wizard Recepção"
$atalho.Save()

Write-Host "Atalho criado em: $area\Wizard Recepção.lnk"
Write-Host ""
Write-Host "Dica para o ícone do Edge sumir também da BARRA DE TAREFAS (não só da janela):"
Write-Host "abra o app, clique nos tres pontinhos do Edge (...) -> Aplicativos -> 'Instalar"
Write-Host "este site como aplicativo'. E uma vez so por computador; depois disso o Windows"
Write-Host "trata o Wizard como um programa de verdade, com icone proprio na barra."
