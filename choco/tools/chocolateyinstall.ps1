$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = "https://github.com/tony1223/better-agent-terminal/releases/download/v$($env:ChocolateyPackageVersion)/__EXE_NAME__"
  checksum64     = '__CHECKSUM64__'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}
Install-ChocolateyPackage @packageArgs
