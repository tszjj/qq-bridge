' 静默启动 qq-bridge（不弹窗）。
' 用途：当桥接需要脱离当前终端/会话长期常驻时，用 explorer 调用本脚本，
' 让进程挂在 explorer 下而不是发起它的那个 shell 下。
' 日常启动整栈仍请用 start-all.bat。
Option Explicit
Dim fso, sh, base, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
cmd = "cmd /c """"" & "C:\Program Files\nodejs\node.exe" & """ src\bridge.js >> logs\service.out.log 2>> logs\service.err.log"""
sh.Run cmd, 0, False
