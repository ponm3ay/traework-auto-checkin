' Run checkin script silently (no console window).
' Used by the Windows Scheduled Task. Logs:
' %LOCALAPPDATA%\traework-auto-checkin\checkin.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & scriptDir & "\run_checkin.cmd""", 0, False
