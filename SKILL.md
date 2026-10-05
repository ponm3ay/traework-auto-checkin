---
name: traework-auto-checkin
description: 自动完成 TraeWork CN 每日签到领取积分。当用户要求自动签到、每日签到、查看签到状态、排查签到失败、或配置打开 TRAE IDE 时自动执行签到的定时任务时使用。不用于其他网站或应用的签到。
---

# TraeWork 每日自动签到

自动读取本机 TRAE 登录态，调用 TraeWork 签到接口，完成每日签到并领取积分。脚本是幂等的，已签到时直接跳过，可高频重复执行。

## 文件说明

- `scripts/checkin.js` —— 签到核心脚本（解密登录态 + 调用签到 API）
- `scripts/run_checkin.cmd` —— 执行入口，优先用系统 Node.js，无 Node 时自动回退 Trae 内置 Electron Node（`ELECTRON_RUN_AS_NODE=1`）
- `scripts/run_checkin_silent.vbs` —— 静默启动入口（无窗口），供 Windows 计划任务调用

## 执行签到

在 Windows 上运行：

```powershell
& "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin\scripts\run_checkin.cmd"
```

输出含义：

- `今日已签到（每日签到奖励 N 积分），账户可用积分 X` —— 今日签到已完成（本机或其他任意端签过都算），积分已计入账户，退出码 0
- `签到成功，获得 N 积分，账户可用积分 X` —— 本次运行真正完成了签到领取，退出码 0
- `本设备今日已签到过...` —— 设备级限制（官方客户端同款行为），退出码 0
- `登录态无效或已过期，请先在 TRAE 中登录` —— 退出码 2，需用户重新登录 TRAE
- `签到失败` —— 退出码 1，按下方故障排查处理

运行日志写入 `%LOCALAPPDATA%\traework-auto-checkin\checkin.log`。日志与输出绝不包含 token。

手动指定 Trae 可执行文件（可选）：

```powershell
$env:TRAE_EXE = "D:\Trae CN\Trae CN.exe"; & "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin\scripts\run_checkin.cmd"
```

## 技术原理

1. 从 `%APPDATA%\<Trae 数据目录>\User\globalStorage\storage.json` 读取 `iCubeAuthInfo://icube.cloudide`（加密登录态）与 `telemetry.machineId`、`telemetry.devDeviceId`。自动探测 `TRAE SOLO CN`、`Trae CN`、`TRAE SOLO`、`Trae` 等候选目录，取登录态最新鲜（mtime 最大）的一个；也可用环境变量 `TRAE_STORAGE_JSON` 直接指定 storage.json 路径。
2. 解密登录态（AES-128-CBC + SHA-512 密钥派生）得到 token、userId、userRegion。
3. 先查状态 `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status`；仅在 `checked_in=false && did_checked_in=false` 时调用 `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim` 领取积分（与 TraeWork 官方客户端的触发条件完全一致），claim 后回查状态确认真实生效。
4. 状态字段语义（源自 TraeWork 客户端源码，勿混淆）：
   - `checked_in` —— **账号级**：本账号今日已在任意端完成签到（true 即跳过）
   - `did_checked_in` —— **设备级**：本设备今日已操作过签到（true 时官方客户端也不再 claim）
   - `credits` —— **每日签到奖励额度**（如 100 积分/天），不是账户余额
   - `extra_credits` —— 会员/升级每日加成额度
   - 已签状态下调用 claim 会返回 code 0 但不发放积分（幂等空操作），所以不能用"claim 返回 code 0"判断签到成功
5. 账户真实余额通过 `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage` 查询（`usage_summary.total_amount - consumed_amount`），仅用于输出展示。
6. 请求头必须包含 `Authorization`（`Cloud-IDE-JWT` 形式）、`X-User-Region`、`X-User-Id`、`X-Machine-Id`、`X-Device-Id`，缺设备 ID 头会返回 9004。
7. 遇到 9074（服务器限流）或网络异常时自动重试，最多 3 次，指数退避加随机抖动。

## 配置定时任务（每次打开 TRAE IDE 时自动签到）

Windows 计划任务无法直接以「应用启动」为触发器，采用等效方案：登录时触发 + 白天每 30 分钟重复触发。脚本幂等，打开 IDE 后最迟 30 分钟内自动完成签到。注册计划任务需要管理员权限，在提升的 PowerShell 中执行（非管理员会话会报 Access denied）：

```powershell
$skill = "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin"
$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$skill\scripts\run_checkin_silent.vbs`""
$trig1   = New-ScheduledTaskTrigger -AtLogOn
$trig2   = New-ScheduledTaskTrigger -Daily -At 08:00
$trig2.Repetition = (New-ScheduledTaskTrigger -Once -At 08:00 -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "TraeWorkAutoCheckin" -Action $action -Trigger $trig1,$trig2 -Settings $settings -Description "TraeWork daily auto check-in" -Force
```

立即手动触发一次验证：

```powershell
Start-ScheduledTask -TaskName "TraeWorkAutoCheckin"
```

查看/删除任务：

```powershell
Get-ScheduledTask -TaskName "TraeWorkAutoCheckin"
Unregister-ScheduledTask -TaskName "TraeWorkAutoCheckin" -Confirm:$false
```

若 `Register-ScheduledTask` 因权限失败，回退启动文件夹方案（每次登录自动运行、无窗口）：

```powershell
$skill = "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin"
Copy-Item "$skill\scripts\run_checkin_silent.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\TraeWorkAutoCheckin.vbs"
```

## 前置条件

- 已在 TRAE 中登录账号（storage.json 中存在加密登录态）
- Windows 系统，运行时依赖系统 Node.js 或 Trae 自带 Electron（二选一即可，脚本自动探测）

## 故障排查

- **误以为"签到失败"** —— 先核对三点：status 的 `credits` 是每日奖励额度而非余额；`checked_in=true` 表示账号今日已在任意端（TraeWork/TraeCode 客户端或本脚本）签到成功；真实余额看输出里的"账户可用积分"或 TraeWork 客户端积分页。
- **claim 返回成功但积分未到账** —— 服务器已知异常（社区有相同反馈）：可能被标记已签但未发放。本脚本 claim 后会回查状态核实，若发现未真实生效会自动重试；次日再观察，持续异常可向官方社区反馈。
- **退出码 2 / 登录态无效** —— 在 TRAE 中重新登录后重跑；若刚登录仍报错，确认脚本探测到的数据目录与当前使用的产品一致（用 `TRAE_STORAGE_JSON` 显式指定 storage.json）。
- **错误码 9004（参数缺失）** —— 确认请求头含 `X-Machine-Id` 与 `X-Device-Id`（脚本已内置）；换新设备登录后需等 storage.json 更新。
- **错误码 9074（限流）** —— 服务端高峰限流，脚本会自动重试；仍失败则低峰期再试或调大 `checkin.js` 中的 `MAX_ATTEMPTS`。
- **网络异常** —— 检查代理/防火墙是否放行 `api.trae.cn`。
- **cmd 闪退或乱码** —— 直接用 PowerShell 运行 `run_checkin.cmd` 查看报错；脚本文件必须保持纯 ASCII（cmd 按 GBK 解析中文注释会吞字节导致命令损坏）。

## 安全约束

- 对 storage.json 只读，绝不修改登录态文件。
- 绝不在输出、日志或对话中打印 token / 登录态明文。
- 只请求 `api.trae.cn` 的签到与积分查询接口，不做其他网络访问。
