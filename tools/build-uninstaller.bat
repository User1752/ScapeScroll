@echo off
rem Compila o desinstalador com o csc.exe que ja vem com o Windows (.NET Framework 4.x).
rem Nao descarrega nada e nao precisa de Node.
rem Resultado: dist\uninstall.exe  (copiar para a pasta do .exe do ScrollScape)
setlocal
cd /d "%~dp0.."
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo csc.exe nao encontrado. Instale o .NET Framework 4.x.
  exit /b 1
)
if not exist dist mkdir dist
set "ICON="
if exist build-assets\app-icon.ico set "ICON=/win32icon:build-assets\app-icon.ico"
"%CSC%" /nologo /target:exe /optimize+ /warnaserror- /codepage:65001 /out:dist\uninstall.exe %ICON% /r:System.Management.dll /r:Microsoft.CSharp.dll /r:System.Core.dll tools\uninstaller\Uninstall-ScrollScape.cs
if errorlevel 1 exit /b 1
echo.
echo OK: dist\uninstall.exe
endlocal
