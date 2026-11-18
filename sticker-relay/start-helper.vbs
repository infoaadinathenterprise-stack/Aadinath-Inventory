' Starts the sticker helper in the background with no window.
' setup.ps1 puts a shortcut to this file in the Startup folder, so the helper
' starts every time you log in to the laptop.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c """ & here & "\run-helper.cmd""", 0, False
