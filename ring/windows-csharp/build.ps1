$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$gacM = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL'
$gac64 = 'C:\Windows\Microsoft.NET\assembly\GAC_64'

$refs = @(
    (Join-Path $gacM 'PresentationFramework\v4.0_4.0.0.0__31bf3856ad364e35\PresentationFramework.dll'),
    (Join-Path $gac64 'PresentationCore\v4.0_4.0.0.0__31bf3856ad364e35\PresentationCore.dll'),
    (Join-Path $gacM 'WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll'),
    (Join-Path $gacM 'System.Xaml\v4.0_4.0.0.0__b77a5c561934e089\System.Xaml.dll')
)
foreach ($ref in $refs) {
    if (-not (Test-Path -LiteralPath $ref)) { throw "找不到依赖：$ref" }
}

$out = Join-Path $root '幻梦圆环.exe'
$sources = Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter '*.cs' | ForEach-Object { $_.FullName }
$args = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/codepage:65001',
    ('/out:' + $out),
    ('/win32manifest:' + (Join-Path $root 'app.manifest')),
    '/r:System.dll',
    '/r:System.Core.dll'
)
foreach ($ref in $refs) { $args += ('/r:' + $ref) }
$args += $sources

& $csc @args
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
Get-Item -LiteralPath $out | Select-Object FullName, Length, LastWriteTime

