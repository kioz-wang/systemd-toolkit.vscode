# systemd Toolkit

为编辑 systemd 单元（unit）、网络及守护进程配置文件提供语言支持，并集成
`systemctl` / `journalctl`：Units 面板、CodeLens、实时日志、unit 文件部署——
本地与 SSH 远程均可。

## 功能

### 编辑

- **语法高亮** — 支持单元文件（`.service`、`.socket`、`.timer`、`.path`、
  `.mount`、`.swap`、`.automount`、`.target`、`.slice`、`.scope`、`.device`）、
  网络文件（`.network`、`.netdev`、`.link`、`.nspawn`、`.dnssd`、
  `.dns-delegate`）以及守护进程配置文件（`journald.conf`、`logind.conf`、
  `resolved.conf`、`system.conf` 等）。
- **指令补全** — 依据当前 `[Section]` 与文件类型推断可用指令。例如在 `.service`
  文件的 `[Service]` 节内会提示 `ExecStart`、`Type`、`Restart` 等，而不会出现
  socket 或 timer 的选项。
- **取值补全** — 对可枚举指令（`Type=`、`Restart=`、`KillMode=`、布尔型等），在
  `=` 之后提示允许的取值。
- **节（Section）补全** — 输入 `[` 时列出该文件合法的节名。
- **悬停文档** — 悬停在指令上显示一段摘要、允许的取值以及上游 man 页链接。
- **Ctrl+Click** — 打开在线 HTML man 页（定位到该指令）；对依赖类指令
  （`After=`、`Wants=`、`WantedBy=`、`Requires=` 等）的取值，在目标已部署时跳转到
  该 unit 的只读预览。
- **代码片段（Snippet）** — 提供 service、oneshot、timer、socket、mount、
  automount、path、slice、target 等单元模板（例如输入 `service` 触发）。

### 命令

| 命令 | 动作 |
| --- | --- |
| `systemd: Show Unit Status` | `systemctl status <unit>` |
| `systemd: Start / Stop / Restart / Reload Unit` | `systemctl <action> <unit>` |
| `systemd: Enable / Disable Unit` | `systemctl enable/disable <unit>` |
| `systemd: Reload Daemon` | `systemctl daemon-reload` |
| `systemd: Show Unit Logs` | 实时 `journalctl -u <unit> --follow` |
| `systemd: Deploy Unit File` | 写文件 + `daemon-reload` |

单元名从当前活动编辑器推断（如 `sshd.service`），无法推断时弹出输入框。输出默认
写入 **systemd** 输出通道；开启 `systemd.runInTerminal` 后改为在集成终端中运行。

### Units 面板

**systemd** 活动栏容器包含三个视图：

- **Target** — 显示当前 host 与 unit 作用域（点击可切换）。**Refresh** 按钮位于
  此视图，并同时刷新全部三个视图。
- **Loaded** — 当前加载到内存中的 unit（`systemctl list-units`），带**列表/树
  切换**、**显示/隐藏 inactive** 开关与**名称过滤**。两种模式都用图标与颜色显示
  每个 unit 的状态。
- **Installed** — 在 `list-unit-files` 中但**尚未加载**的 unit（默认折叠，展开时
  才懒加载），拥有独立的列表/树切换与过滤。刚部署但处于 inactive 的 unit 会在这里
  出现（systemd 会把 inactive 的 unit 从 `list-units` 中垃圾回收掉）。

对 unit 的操作是**按状态动态显示**的（与 CodeLens 同一套矩阵）：

| 状态 | 操作 |
| --- | --- |
| active | Stop、Restart、Logs |
| inactive | Start、Logs |
| failed | Restart、Logs |
| 过渡态 / masked | 仅 Logs |
| enabled | + Disable |
| disabled | + Enable |

每个 unit 还提供 Status、View Unit File、Edit Unit File。**Installed** 树的每个
分组都有 **New** 按钮，可新建该类型的 unit。

### 编辑器 CodeLens

对 unit 文件，编辑器显示按状态动态变化的 CodeLens：

- **未部署** → 只有一个 **Deploy** 操作；
- **已部署** → 实时状态（如 `active (running)`），然后：
  - active → Stop + Restart；inactive → Start；failed → Restart；
  - enabled → Disable；disabled → Enable；
  - **Logs**，以及 **Edit**（只读预览）/ **Deploy**（可编辑副本）。

**Deploy** 写文件并执行 `systemctl daemon-reload`：

- 已编辑的 unit 写回其 `FragmentPath`（若 fragment 是 `/usr/lib/systemd/` 或
  `/lib/systemd/` 下的 vendor 文件，则改写覆盖文件到 unit 目录）；
- 新文件写入 `/etc/systemd/system/<name>`（user 作用域为
  `~/.config/systemd/user/<name>`）；
- 覆盖目标上已存在的文件会先弹确认框。

Deploy **不会** start 或 enable 该 unit——那是独立的步骤（`Start` / `Enable`）。

### 实时日志

**Show Unit Logs** 打开一个只读标签页，流式显示
`journalctl -u <unit> --follow -n 300`（本地或 SSH）。内容持续刷新，做了节流与
大小上限，标签页关闭时终止后台进程。日志视图不显示 CodeLens。

### 状态栏

状态栏显示当前目标（`host · scope · vNNN`）；点击它可切换本次会话的 host 或 scope。

### 远程（SSH）与作用域（scope）

- `systemd.host` — 要操作的 SSH 别名（来自 `~/.ssh/config`）；留空 = 本机。远程
  命令复用一条多路复用的 SSH 连接。
- `systemd.scope` — `system`（默认）或 `user`（`systemctl --user`）。user 作用域
  部署到 `~/.config/systemd/user/`，且永不提权。

Target 视图与状态栏切换的是**会话级**设置，不改动配置默认值。面板跟随会话；而
编辑器 CodeLens 跟随**文件自身**的作用域（`/etc/systemd/system/` 下的文件始终按
system 处理）。

## 支持的 systemd 版本

本版本附带 **systemd 258、259、260、261**（每个系列的最新稳定补丁）的指令数据。
启动时扩展检测目标机器（遵循 `systemd.host`）的版本（`systemctl --version`）：

- 精确匹配 → 加载该版本数据；
- 不支持 → 显示错误并禁用语言功能；
- 检测失败 → 回退到最新支持版本并给出警告。

可通过 `systemd.versionOverride` 强制指定版本。

## 设置

- `systemd.docSource` — `online`（默认）或 `man`。
- `systemd.onlineDocBase` — `online` 模式使用的基础 URL。
- `systemd.systemctlPath` / `systemd.journalctlPath` — 二进制文件路径。
- `systemd.host` — 要操作的 SSH 别名（留空 = 本机）。
- `systemd.scope` — `system` | `user`。
- `systemd.sshPath` — `ssh` 二进制路径。
- `systemd.runInTerminal` — 在终端而非输出通道中运行命令。
- `systemd.authMethod` — 提权方式：`sudo`（默认）/ `pkexec` / `none`。
- `systemd.versionOverride` — 强制指令数据版本。

## 指令数据是如何生成的

补全与悬停数据由 `scripts/generate-data.py` 从 systemd 源码树的 man 页（DocBook
XML）生成。详见 `DEVELOPMENT.zh-CN.md`。

## 构建

```sh
npm install
npm run compile
npm run package   # → systemd-toolkit-0.1.0.vsix
```

## 许可与署名

本扩展采用 **LGPL-2.1-or-later** 许可（见 `LICENSE`）。图标所用的 systemd logo
版权归 Tobias Bernard（GNOME）所有，采用 **CC BY-SA 4.0** 许可——详见
`THIRD_PARTY_NOTICES.md`。

本扩展**与 systemd 官方无隶属关系，亦未获得其背书**。

## 说明与局限

- 布尔型指令补全为 `yes/no/true/false/on/off`。
- 时间跨度（`5min`、`1h 30min`）和大小（`512M`）等取值暂为自由文本，未自动补全。
- 需要 root 的命令按 `systemd.authMethod`（默认 `sudo`）在终端里提权运行，以便
  交互式认证。
