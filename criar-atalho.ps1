# criar-atalho.ps1 — roda UMA VEZ em cada computador (notebook e recepção) para criar
# o atalho "Wizard Recepção" na área de trabalho, apontando para o iniciar-app.vbs
# (abre sem terminal e sem barra do Edge, como um programa normal do Windows).
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
$atalho.Description = "Wizard Recepção"
$atalho.Save()

Write-Host "Atalho criado em: $area\Wizard Recepção.lnk"
Write-Host "Dica: clique com o botão direito no atalho -> Propriedades -> Alterar ícone,"
Write-Host "para trocar o ícone padrão de script por um logo, se quiser."
