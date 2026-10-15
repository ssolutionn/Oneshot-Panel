$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$output = Join-Path $root "OBS_LOCAL"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$count = 0
foreach ($template in Get-ChildItem -LiteralPath (Join-Path $root "OFFLINE_TEMPLATES") -Filter "*.json") {
    $document = Get-Content -Raw -LiteralPath $template.FullName -Encoding UTF8 | ConvertFrom-Json
    $cards = @($document.sources | Where-Object { $_.name.StartsWith("CARD ") })
    if ($cards.Count -ne 10) { throw "Expected ten cards in $($template.Name)" }
    foreach ($source in $cards) {
        $image = [IO.Path]::GetFullPath((Join-Path $root $source.settings.file))
        if (-not (Test-Path -LiteralPath $image -PathType Leaf)) { throw "Missing image: $image" }
        $source.settings.file = $image
    }
    $target = Join-Path $output $template.Name
    [IO.File]::WriteAllText($target, ($document | ConvertTo-Json -Depth 100), $utf8)
    $count++
}
if ($count -eq 0) { throw "No offline templates found." }
Write-Host "Ready: $count OBS collections in OBS_LOCAL"
