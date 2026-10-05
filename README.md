# traework-auto-checkin

> TRAE / TraeWork CN 每日自动签到 —— 自动领取每日签到积分，支持"打开 IDE 即签到"的定时任务方案

无需手动打开客户端点签到。脚本自动读取本机 TRAE 登录态，调用 TraeWork 官方签到接口完成每日积分领取，并可注册 Windows 计划任务实现全自动签到。

## 功能特性

- **零依赖**：纯 Node.js 标准库实现，无需 `npm install`；没有 Node 时自动回退使用 TRAE 内置的 Electron 运行时
- **幂等安全**：已签到自动跳过，可高频重复执行；claim 后回查状态，防止服务器"假成功"
- **隐私优先**：登录态文件只读、绝不修改；日志与输出绝不包含 token / 登录态明文
- **自动化**：一条命令注册 Windows 计划任务（登录时 + 白天每 30 分钟），打开 IDE 后最迟 30 分钟内自动完成签到
- **真实反馈**：区分账号级 / 设备级签到状态，显示每日奖励额度与账户真实余额

## 工作原理

```
storage.json (TRAE 登录态)
        │  AES-128-CBC + SHA-512 密钥派生解密
        ▼
token / userId / userRegion
        │
        ▼
POST /trae/api/v2/ug/checkin_credits/status   ── 查询签到状态
        │  仅在 checked_in=false && did_checked_in=false 时
        ▼
POST /trae/api/v2/ug/checkin_credits/claim    ── 领取积分
        │  回查 status 确认真实生效
        ▼
POST /trae/api/v2/pay/ide_user_ent_usage      ── 查询账户真实余额（展示用）
```

### 状态字段语义（源自 TraeWork 客户端源码分析，勿混淆）

| 字段 | 语义 |
|---|---|
| `checked_in` | **账号级**：本账号今日已在任意端完成签到（true 即跳过领取） |
| `did_checked_in` | **设备级**：本设备今日已操作过签到（true 时官方客户端也不再领取） |
| `credits` | 每日签到奖励额度（如 100 积分/天），**不是账户余额** |
| `extra_credits` | 会员 / 升级每日加成额度 |

> 注意：账号已签到时调用 claim 接口会返回 `code=0` 但不发放积分（幂等空操作），因此不能以"claim 返回成功"判断签到完成，必须依据 `checked_in` 状态。

## 安装

### 方式一：作为 TRAE 全局技能（推荐）

```powershell
git clone https://github.com/ponm3ay/traework-auto-checkin.git
Copy-Item -Recurse traework-auto-checkin "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin"
```

之后在 TRAE 对话中说"帮我签到 / 配置自动签到"即可触发技能。

### 方式二：独立使用

克隆或下载本仓库后直接运行 `scripts\run_checkin.cmd`，无需安装技能。

## 使用

### 手动签到

```powershell
& ".\scripts\run_checkin.cmd"
```

输出示例：

```
[2026/10/5 08:00:12] 签到成功，获得 100 积分，账户可用积分 6514.67
[2026/10/5 12:30:00] 今日已签到（每日签到奖励 100 积分），账户可用积分 6490.25
```

| 输出 | 含义 | 退出码 |
|---|---|---|
| `今日已签到（每日签到奖励 N 积分）...` | 今日签到已完成（本机或其他任意端签过都算），积分已计入账户 | 0 |
| `签到成功，获得 N 积分...` | 本次运行真正完成了签到领取 | 0 |
| `本设备今日已签到过...` | 设备级限制（官方客户端同款行为） | 0 |
| `登录态无效或已过期` | 需在 TRAE 中重新登录 | 2 |
| `签到失败` | 按下文排查 | 1 |

运行日志写入 `%LOCALAPPDATA%\traework-auto-checkin\checkin.log`。

### 注册定时任务（每次打开 TRAE IDE 时自动签到）

Windows 计划任务无法直接以"应用启动"为触发器，本项目采用等效方案：**登录时触发 + 每天 08:00 起每 30 分钟重复**。脚本幂等，打开 IDE 后最迟 30 分钟内自动完成签到。需在**管理员** PowerShell 中执行：

```powershell
$skill = "$env:USERPROFILE\.trae-cn\skills\traework-auto-checkin"
$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$skill\scripts\run_checkin_silent.vbs`""
$trig1   = New-ScheduledTaskTrigger -AtLogOn
$trig2   = New-ScheduledTaskTrigger -Daily -At 08:00
$trig2.Repetition = (New-ScheduledTaskTrigger -Once -At 08:00 -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "TraeWorkAutoCheckin" -Action $action -Trigger $trig1,$trig2 -Settings $settings -Description "TraeWork daily auto check-in" -Force
```

管理计划任务：

```powershell
Start-ScheduledTask -TaskName "TraeWorkAutoCheckin"      # 立即执行一次
Get-ScheduledTask -TaskName "TraeWorkAutoCheckin"        # 查看状态
Unregister-ScheduledTask -TaskName "TraeWorkAutoCheckin" -Confirm:$false   # 删除
```

若注册计划任务权限不足，可用启动文件夹方案（登录自动运行、无管理员权限要求）：

```powershell
Copy-Item ".\scripts\run_checkin_silent.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\TraeWorkAutoCheckin.vbs"
```

## 故障排查

- **误以为"签到失败"** —— `status.credits` 是每日奖励额度而非余额；`checked_in=true` 表示账号今日已在任意端签到成功；真实余额看输出中的"账户可用积分"。
- **claim 返回成功但积分未到账** —— 服务器已知异常（社区有相同反馈）：可能被标记已签但未发放。本脚本 claim 后会回查状态核实，发现未真实生效会自动重试（默认 3 次，指数退避）。
- **退出码 2 / 登录态无效** —— 在 TRAE 中重新登录后重跑；多产品共存时可用环境变量 `TRAE_STORAGE_JSON` 显式指定 storage.json 路径。
- **错误码 9004（参数缺失）** —— 请求头需含 `X-Machine-Id` 与 `X-Device-Id`（脚本已内置）。
- **错误码 9074（限流）** —— 服务端高峰限流，脚本自动重试；仍失败可在 `checkin.js` 中调大 `MAX_ATTEMPTS`。
- **cmd 闪退或乱码** —— 用 PowerShell 运行 `run_checkin.cmd` 查看报错；`.cmd` 文件须保持纯 ASCII（cmd 按 GBK 解析中文注释会损坏命令）。

## 安全与隐私

- 对 `storage.json` **只读**，绝不修改登录态文件
- 绝不在输出、日志中打印 token / 登录态明文
- 只请求 `api.trae.cn` 的签到与积分查询接口，不做其他网络访问
- 凭证始终保存在本机（`%APPDATA%\<TRAE 数据目录>\User\globalStorage\storage.json`），本仓库不含任何账号信息

## 文件结构

```
traework-auto-checkin/
├── README.md                     # 说明文档
├── LICENSE                       # MIT 许可证
├── SKILL.md                      # TRAE 技能定义（name + description + 使用说明）
└── scripts/
    ├── checkin.js                # 签到核心脚本（解密登录态 + 调用签到 API）
    ├── run_checkin.cmd           # Windows 执行入口（Node / TRAE Electron 双运行时探测）
    └── run_checkin_silent.vbs    # 静默启动（无窗口），供计划任务调用
```

## 前置条件

- Windows 系统，已登录 TRAE / TraeWork CN 账号
- Node.js（推荐）或 TRAE 自带 Electron 运行时（二选一，自动探测）

## 参考

- [TraeWork每日自动签到 - TRAE 官方中文社区](https://forum.trae.cn/t/topic/178479)（本项目在其基础上修复了状态字段误判、假成功校验、路径硬编码等问题）

## License

[MIT](./LICENSE) © 2026 [ponm3ay](https://github.com/ponm3ay)
