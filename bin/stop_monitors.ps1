$project = 'C:\Users\regai\Projects\OddsAggregator'

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -match [regex]::Escape($project)
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }