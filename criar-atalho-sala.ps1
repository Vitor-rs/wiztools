# criar-atalho-sala.ps1 — roda UMA VEZ em cada NOTEBOOK de sala de aula (Asus e Samsung).
#
# Cria o atalho "Wizard Sala" apontando para o iniciar-sala.vbs, que só abre a tela
# apontando para o Dell da recepção. O notebook não roda servidor nem tem banco: o banco
# vive num lugar só, senão cada máquina teria a sua cópia e os lançamentos não se
# encontrariam.
#
# Na RECEPÇÃO (Dell) não use este: lá é o criar-atalho.ps1, que sobe o servidor.
#
# Uso: clique com o botão direito neste arquivo -> "Executar com o PowerShell".
# Se o Windows bloquear por política de execução:
#   powershell -ExecutionPolicy Bypass -File criar-atalho-sala.ps1

$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$area = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$atalho = $ws.CreateShortcut("$area\Wizard Sala.lnk")
$atalho.TargetPath = "$pasta\iniciar-sala.vbs"
$atalho.WorkingDirectory = $pasta
$atalho.IconLocation = "$pasta\resources\wizard-icon.ico"
$atalho.Description = "Wizard - lançamento na sala de aula (usa o banco da recepção)"
$atalho.Save()

Write-Host "Atalho criado em: $area\Wizard Sala.lnk"
Write-Host ""
Write-Host "Este atalho abre a tela apontando para o Dell da recepcao."
Write-Host "O Dell precisa estar LIGADO e com o Wizard aberto."
Write-Host ""
Write-Host "Se o endereco do Dell mudar, edite a linha SERVIDOR no arquivo iniciar-sala.vbs."
