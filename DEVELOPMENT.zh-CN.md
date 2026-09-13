# systemd VS Code 扩展 — 开发指南（中文）

> 本文面向想理解、修改、扩展或维护本项目的开发者，按「设计思路 → 编码方法 →
> 维护方法」的顺序，把关键决策与实现细节讲清楚。

## 目录

1. [整体设计思路](#1-整体设计思路)
2. [VS Code 扩展的运行模型](#2-vs-code-扩展的运行模型)
3. [数据管线：从 man 页生成指令索引](#3-数据管线从-man-页生成指令索引)
4. [核心模块逐个拆解](#4-核心模块逐个拆解)
5. [编码方法：每个功能是怎么实现的](#5-编码方法每个功能是怎么实现的)
6. [测试方法](#6-测试方法)
7. [构建、打包与发布](#7-构建打包与发布)
8. [后续维护：常见任务的完整步骤](#8-后续维护常见任务的完整步骤)
9. [常见坑与注意事项](#9-常见坑与注意事项)

## 1. 整体设计思路

### 1.1 目标拆解

需求分成两类：

| 类别 | 需求 | 本质 |
| --- | --- | --- |
| 编辑 | 语法高亮、补全、模板、帮助 | 「语言服务」——与文件内容交互 |
| 使用 | 状态/部署/日志等命令 + 面板 | 调用 `systemctl`/`journalctl` 并展示结果 |

第一类占大头，且可完全离线、可测试；第二类叠加一层最小可用的命令/UI。优先级：
**编辑功能优先、命令与面板从简**。

### 1.2 核心洞察：把「知识」变成「数据」

补全与悬停需要一个庞大且精确的知识库：systemd 有几百条指令，每条指令属于哪个
`[Section]`、作用于哪类文件、允许哪些取值、文档在哪一页——手写是灾难，必须自动
生成。来源选择 man 页 XML（而非 `.gperf`）：它天然包含**说明文字**（悬停需要），
结构规整（`<variablelist>` 的 `<varlistentry>` 与指令一一对应），指令/节/man 页
引用/取值示例都在同一节点里。

于是整个扩展的地基就是：**一个 Python 脚本 → 一份 JSON → TypeScript 运行时查表**。

### 1.3 数据模型：作用域（scope）解决节名冲突

同名的 `[Section]` 在不同文件类型里含义不同（`[Service]` 在 unit 文件与 `.dnssd`
文件里是两回事；`[Match]`/`[Link]` 同时出现在 `.network` 与 `.link`）。若全局只存
「节名 → 指令」，必然冲突。解法是引入 scope：

```jsonc
{
  "scopes": { "unit": { "sections": { "Unit": [...], "Service": [...] } } },
  "fileTypes": { "service": { "scope": "unit", "sections": ["Unit","Install","Service"], "doc": "systemd.service" } },
  "filenames": { "journald.conf": { "scope": "config:journald.conf", "sections": ["Journal"], "doc": "journald.conf" } }
}
```

运行时查询链路：**文件 → (扩展名/文件名) → fileType/filename → scope + 合法节 →
当前 `[Section]` → 指令列表**。识别文件、识别节、查指令三件事解耦，新增文件类型
只需改数据，不改代码。

## 2. VS Code 扩展的运行模型

- **`activate(context)` / `deactivate()`**：入口/出口。`activate` 里注册 provider
  与命令。
- **`package.json` 的 `contributes`**：静态声明扩展贡献了什么——语言、语法、
  片段、命令、设置、菜单。
- **Provider**：VS Code 在特定时机回调你的代码——`CompletionItemProvider`
  （打字）、`HoverProvider`（悬停）、`DocumentLinkProvider`（Ctrl+Click 链接）。
  注意 `DefinitionProvider` 是「跳转到定义」（文档内导航），**不能**打开网页——
  它会报 "Unable to resolve resource"。打开外部网页用 `DocumentLinkProvider`。
- **`activationEvents`**：决定扩展何时被激活。
- **`DocumentSelector`**：决定 provider 对哪些文件生效。

### 2.1 激活策略

```jsonc
"activationEvents": ["onLanguage:systemd", "onStartupFinished"]
```

`onStartupFinished` 是因为 drop-in 配置（`/etc/systemd/xxx.conf.d/*.conf`）常被
VS Code 识别成 `ini`/`plaintext`，而非我们的 `systemd` 语言。为让这些 `.conf`
也有补全，provider 注册到了 `**/*.conf` glob 上——而 glob 生效要求扩展先被激活。
代价是常驻内存，但本扩展数据懒加载，可接受。

`activate` 的结构是：**与数据无关的部分无条件注册**（命令、日志、树视图、unit
文件操作、CodeLens、状态栏），**语言特性（补全/悬停/链接）也无条件注册但在未加载
数据时直接返回**；随后在后台做版本检测并 `setActiveVersion()`（远程主机的
`systemctl --version` 往返很慢，不能阻塞激活）。host 变化时重跑版本检测并刷新。

## 3. 数据管线：从 man 页生成指令索引

文件：`scripts/generate-data.py`。

一条指令在 man 页里形如（简化）：

```xml
<refsect1><title>Options</title>
  <variablelist class='unit-directives'>
    <varlistentry>
      <term><varname>Type=</varname></term>
      <listitem><para>Configures ... One of <option>simple</option>, <option>exec</option>, ...</para></listitem>
    </varlistentry>
  </variablelist>
</refsect1>
```

需要提取：

- **指令名**：`<varname>` 去尾部 `=` 与 `<replaceable>` 占位。一个 `varlistentry`
  可能用**多个 `<term>`** 记录多条指令（`Before=`/`After=`），必须遍历所有
  `<term>`（早期只取第一个，导致 `After=` 丢失）。
- **所属节**：向上找到 `[X] Section Options` 标题；找不到回退到页默认值。
- **摘要**：把 `<listitem>` 前几段渲染成 **Markdown**（`<option>`/`<varname>`/
  `<filename>`/`<literal>` → 反引号代码段）。
- **取值**：覆盖三种句式——`one of …` 的 `<option>`、`special value(s) …` 的
  `<literal>`、`takes a boolean`（布尔集 `yes/no/true/false/on/off`，且与特殊值
  **合并**，如 `ProtectSystem=` = `full`/`strict` + 布尔）。
- **取值说明**：从 "If/When set to `X`, …" 提取每个取值的说明存为 `valueDocs`。
- **版本**：`<xi:include href="version-info.xml" xpointer="vX"/>` 里的 `X` 即
  "Added in version X"，存为 `addedIn`。

三个必须处理的坑：

1. **自定义 XML 实体**（`&FALLBACK_HOSTNAME;` 等，定义在
   `man/custom-entities.ent.in`）：`ET.parse` 不解析，需先读实体文件做正则替换。
2. **ElementTree 无 `getparent()`**：回溯节标题要自建 parent map。
3. **节名冲突**：用 scope 路由（`SCOPE_ROUTING` + `config:<page>`）。

`merge_directives` 按指令名去重、合并取值、互补摘要。每个源码检出输出一份
`data/directives-v<N>.json`，并生成 `data/manifest.json`。

## 4. 核心模块逐个拆解

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 纯类型定义（Directive / ScopeData / FileTypeInfo / DirectivesData / Manifest） |
| `src/data.ts` | 加载 manifest、按版本加载数据、文件识别、节识别、指令查询 |
| `src/version.ts` | 目标机器 systemd 版本检测与选择 |
| `src/remote.ts` | SSH 主机 + ssh/sudo 命令封装（buildCommand）、scope、homeDir、deployedUnits |
| `src/context.ts` | 把光标所在行解析成「注释/节头/键/值」 |
| `src/completion.ts` | 补全 provider |
| `src/help.ts` | 悬停 + 文档链接（Ctrl+Click）provider |
| `src/commands.ts` | 编辑器级 systemctl/journalctl 命令（复用 remote.ts） |
| `src/tree.ts` | Units 面板三视图（Target / Loaded / Installed）+ 相关命令 |
| `src/unitfile.ts` | 查看 / 编辑 / 新建 / 部署 unit 文件；快照缓存；documentScope |
| `src/codelens.ts` | 编辑器状态 + 操作 CodeLens |
| `src/logs.ts` | 实时日志（systemd-log 虚拟文档） |
| `src/statusbar.ts` | 状态栏（host · scope · 版本） |
| `src/process.ts` | child_process 封装（spawn/exec，支持 stdin）；在日志通道记录命令 |
| `src/logger.ts` | "systemd Toolkit" 日志通道（扩展日志 + 命令记录） |
| `src/extension.ts` | 组装：注册 provider、命令、树视图、CodeLens、状态栏 |

依赖单向：`extension.ts` 依赖所有模块；功能模块依赖 `data.ts`/`context.ts`；
`types.ts` 被所有人依赖；无环。

### 4.1 `src/data.ts` — 数据层

```ts
loadManifest(): Manifest | undefined
setActiveVersion(version): boolean   // 惰性加载某版本数据
resolveFile(document): ResolvedFile | undefined
sectionAt(document, position): string | undefined
findDirective(scope, section, name): Directive
```

多版本核心是「先选版本、再查数据」：`setActiveVersion()` 把某个版本的
`directives-v<N>.json` 惰性 `require` 进模块级变量，之后查询都用它。

`resolveFile` 匹配顺序：扩展名在 `fileTypes`？→ 文件名在 `filenames`？→ 扩展名是
`.conf`（读首节反查 config scope，处理 drop-in）？→ 都不是 `undefined`。

`sectionAt` 从光标行往上扫最近的 `^\s*\[([^\]]+)\]\s*$`，简单可靠。

### 4.2 `src/context.ts` — 行解析

输出 `LineContext { lineText, beforeCursor, afterCursor, inSection, key, inValue, inComment }`。
判断朴素：去空白后行首 `#`/`;` → 注释；`[` → 节头；光标前有 `=` → 值位置（`=`
前是 key）；否则 → 键位置。这种「只看当前行 + 光标相对位置」的启发式对 INI 风格
文件足够，避免写完整语法分析器。

## 5. 编码方法：每个功能是怎么实现的

### 5.1 语法高亮（TextMate）

文件：`syntaxes/systemd.tmLanguage.json`。三条核心 pattern：注释、节头、键=值
（第 3 个捕获组内嵌 `#value` 子模式做「值内部」二次高亮）。`scopeName`
（`source.systemd`）是语法唯一标识，`package.json` 把语言 id `systemd` 绑到它。

### 5.2 补全（`src/completion.ts`）

`provideCompletionItems` 流程：`resolveFile` → 非 systemd 文件返回；`lineContext`
→ 注释返回；`inSection` → 节名补全；`inValue` → 取值补全；否则 → 指令补全。

要点：**必须精确设 `item.range`**（否则 VS Code 按默认规则替换整个「单词」，
`ExecStart` 只补出 `Exec`）；`insertText = name + '='`（补全指令带 `=`，光标落到
值位置，衔接取值补全）；`triggerCharacters = ['=', '[', '.']`。

### 5.3 悬停与 Ctrl+Click（`src/help.ts`）

悬停用 `document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9_]*/)` 取鼠标
下完整单词（**不能用** `lineContext.key`，因为悬停位置 ≠ 光标位置）。

Ctrl+Click 用 `DocumentLinkProvider`：为每个已知指令键打 `DocumentLink`，`target`
指向 `https://…/systemd.service.html#Type=`（`=` 要 URL 编码成 `%3D`，freedesktop.org
锚点即 `<a id="Type=">`）。**不要**用 `DefinitionProvider`（会报 "Unable to
resolve resource"）。

依赖跳转：`help.ts` 对 `After=`/`Wants=`/`WantedBy=` 等依赖指令的取值，若目标已
部署（`isUnitDeployed`），生成指向 `systemd-unit:` 快照 URI 的 `DocumentLink`，
并后台 `preloadSnapshots` 预热直接依赖，使 Ctrl+Click 秒开。

### 5.4 命令集成、授权与远程 SSH

要点：

- **推断单元名**：`path.basename(activeEditor.document.fileName)` 匹配
  `/\.(service|socket|...)$/` 就用它，否则 `showInputBox`。
- **输出**：命令在集成终端中运行；**systemd Toolkit** 日志通道记录每条命令
  （`process.ts` 的 `exec`）+ 扩展生命周期/错误日志——纯诊断，不混入命令的原始输出。
- **子进程**：用 `spawn`/`exec`（`process.ts`），避免 shell 拼接；日志命令在
  `--follow` 流式。
- **授权**：`start/stop/restart/enable/disable/daemon-reload` 需要 root，会加
  `systemd-toolkit.authMethod`（`sudo`/`pkexec`）前缀；因命令都在集成终端中运行（提供
  TTY），交互认证可用。`status`/`logs` 无需提权。
- **远程**：`src/remote.ts` 的 `buildCommand(base, args, elevate, scope)` 统一
  构造——先加提权前缀、再在最外层包 `ssh <host>`。ssh 带 ControlMaster 选项
  （`ControlMaster=auto` + `ControlPath` + `ControlPersist=60`），复用一条连接，
  大幅降低远程延迟。
- **唯一命令链路**：面板（`tree.ts`）、文件（`unitfile.ts`）、CodeLens
  （`codelens.ts`）、日志（`logs.ts`）都复用 `buildCommand` + `exec`，没有第二条
  命令构造/执行路径——这是保持一致的根基。

### 5.5 作用域（system/user）与 documentScope

`systemd-toolkit.scope`（`system`|`user`）决定管理哪个 systemd 实例。`remote.ts` 的
`systemctlArgs`/`journalctlArgs` 在 user 作用域统一加 `--user`（`--version` 除外），
且 `buildCommand` 在 user 作用域**永不提权**（sudo 会切到 root 的用户实例）。

**会话 scope vs 文档 scope** 是两个层面：

- 会话 scope：面板（Units 视图）遵循它，由 `scope()` 读取、`setSessionScope()`
  切换（不改配置默认值）。
- 文档 scope：编辑器里的 CodeLens/命令以**文档自身的 scope** 为准
  （`documentScope()`）——临时编辑副本携带打开时的 scope；快照在
  `systemd-unit:` URI 里编码 scope；普通文件按路径推断（`scopeFromPath`：
  `/systemd/user/`、`~/.config/systemd/user/` → user，`/systemd/system/` → system，
  无法判断时回退到会话 scope）。

这样即使会话切到 user，仍在编辑 `/etc/systemd/system/foo.service` 时，CodeLens
的 status/start/stop/logs/deploy 仍针对 **system** 实例执行。快照缓存也按
`scope:unit` 键隔离。

### 5.6 Units 面板（`src/tree.ts`）

三个 `TreeDataProvider`，各注册一个视图：

- **TargetProvider**（`systemd.target`）——两个可点击项：当前 host（点它
  `systemd.switchHost`）、当前 scope（点它 `systemd.switchScope`）。
- **SystemdUnitsProvider**（`systemd.units`，视图名 Loaded）——`list-units --all`，
  列表/树切换（按 unit 类型分组，空组也显示）、显示/隐藏 inactive、名称过滤。
- **InstalledUnitsProvider**（`systemd.installed`，默认折叠）——`list-unit-files`
  与 `list-units` 的**差集**（已安装但未加载），懒加载，独立列表/树/过滤，树的分
  组带 `New` 按钮（`systemd.units.newUnit` 按 `unitType` 新建）。

**为什么要 Installed 视图**：systemd 的 GC（`src/core/unit.c` 的 `unit_may_gc`）
会卸载 inactive 且未被引用的 unit。于是刚 `deploy` 的 inactive unit 被 `show` 等
命令**瞬时**加载后又被卸载，永远不稳定地出现在 `list-units` 里；只有
`list-unit-files` 能可靠看到它。所以「已安装但未加载」的 unit 必须靠这个差集视图
呈现。

**状态化按钮**：`view/item/context` 菜单的 `when` 只能匹配条目的 `contextValue`。
`UnitItem` 把状态编码进 `contextValue = unit:<run>:<enable>`：

- `<run>` = `active` / `inactive` / `failed` / `transition` / `masked`
  （由 LoadState+ActiveState 推导，`masked` 覆盖 `inactive`）；
- `<enable>` = `enabled` / `disabled` / `other`（由 UnitFileState 推导）。

然后 `package.json` 用正则 `when` 按需显隐（`=~` 遵循标准 JS 正则）：

```text
Start    viewItem =~ /^unit:inactive/
Stop     viewItem =~ /^unit:active/
Restart  viewItem =~ /^unit:(active|failed)/
Enable   viewItem =~ /:disabled$/
Disable  viewItem =~ /:enabled$/
Status/Logs/ViewFile/EditFile  viewItem =~ /^unit:/
```

`masked`/`transition` 不匹配任何 run 动作、`other`/`masked` 不匹配 enable/disable，
自然落到「只显示 Logs/Status/View/Edit」。Loaded 视图因此需要 join 一次
`list-unit-files` 拿到 UnitFileState（`listUnitFileStates()`，与
`list-installed-not-loaded` 共用）。

### 5.7 查看 / 编辑 / 新建 / 部署 unit 文件（`src/unitfile.ts`）

- **查看**：`systemctl cat` 快照进虚拟文档（`systemd-unit:/<scope>/<unit>`），只读，
  带缓存与并发去重。
- **编辑**：取 `FragmentPath`（`systemctl show -p FragmentPath --value`），读进
  `TEMP_DIR` 下的同名临时文件（保留 `.service` 等扩展名，语言特性全可用），登记
  `pendingEdits: doc URI → {unit, fragmentPath, scope}`；关标签页时删除临时文件。
- **新建**：问名字 → 在 `TEMP_DIR` 建空文件 → 登记 pending edit → 插入对应类型
  snippet（`snippets/units.json`）。
- **部署**（`deployCurrentFile`）：
  - 临时编辑 → 写回 `FragmentPath`；若是 vendor 文件（`/usr/lib/systemd/` 或
    `/lib/systemd/`），改写覆盖文件到 unit 目录（systemd 推荐做法）；
  - 普通 `.service` 等文件 → 写入 `/etc/systemd/system/<name>`（user 作用域
    `~/.config/systemd/user/<name>`）；
  - 覆盖目标已存在文件 → 先确认；
  - 写成功后 `systemctl daemon-reload`（遵循 scope）；任何失败显示错误并拒绝。

**deploy 与 enable 是正交的两个阶段**：deploy = 装文件 + `daemon-reload`（**不**
start、**不** enable）；enable = 按 `[Install]` 段创建 `.wants` 符号链接。与之
相关，unit 状态有几个**正交维度**：LoadState（loaded/not-found/masked/…）、
ActiveState（active/inactive/failed/…）、SubState（running/dead/…）、
UnitFileState（enabled/disabled/static/masked/…）。`systemctl status` 退出码
0=active、3=inactive/failed、4=不存在，但 3 仍会把完整状态头打到 stdout——所以
判断状态要**看 stdout**，不能只看退出码。

### 5.8 CodeLens（`src/codelens.ts`）

一次 `systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState <unit>`
拿到全部四维状态（`queryUnitState`），据此渲染：

- `loadState` 为 `not-found`/`unknown` → **未部署**，只有 `Deploy`；
- 否则 **已部署**：
  - 状态标签始终显示（`ActiveState (SubState)`）；
  - run 动作（`loadState !== 'masked'` 时）：active → Stop+Restart；failed →
    Restart；inactive → Start；其余（activating/deactivating/reloading/unknown）
    → 无；
  - enable/disable：`enabled` → Disable；`disabled` → Enable；其余无；
  - Logs 始终显示；
  - 文件动作：只读预览 → `Edit`；可编辑副本 → `Deploy`。

`unitForDocument` 只解析 `file`/`untitled` scheme（`systemd-log` 等虚拟文档返回
`undefined`），所以实时日志视图**不显示 CodeLens**。

### 5.9 实时日志（`src/logs.ts`）

`LogContentProvider`（scheme `systemd-log`）在 `provideTextDocumentContent` 里
**同步** `spawn` `journalctl -u <unit> --follow --no-pager -n 300`（经
`buildCommand`，自动感知 SSH/scope），立即返回已缓冲内容（无输出时显示
"Waiting for log output…"，而不是卡在 "Opening"）。数据到达后按 500ms 节流触发
`onDidChange` 刷新，缓冲上限 256KB（超出裁剪并丢弃不完整的首行）。`showLogs` 记录
`unit → scope` 供 `spawn` 使用；关标签页 `stop(unit)` 杀进程，扩展卸载 `stopAll`。

### 5.10 状态栏（`src/statusbar.ts`）

`StatusBarItem.text` 显示 `host · scope · vNNN`（只用 codicon 兼容的纯文本），
点击弹 QuickPick 切换 host 或 scope。`onHostChanged`/`onScopeChanged`/版本切换后
`refresh`。注意状态栏文本**只支持 codicon**，不支持自定义 SVG——所以不放
`resources/systemd.svg`，只放纯文本。

## 6. 测试方法

本项目不引入测试框架，而是**「mock 掉 vscode 模块」做轻量单测**。数据层与补全
逻辑的核心不依赖 UI，只要 mock 出用到的几个符号即可在 Node 里直接跑：

```js
const vscode = { EventEmitter, Uri, workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: {...}, commands: {...} };
// 拦截 require('vscode') / './remote' / './commands' / './unitfile'
```

关键教训：**mock 必须忠实复现真实 API 语义**（如 `getText(range)` 必须返回区间内
文本），否则「测试通过 ≠ 代码正确」。测试覆盖：`resolveFile`/`sectionAt`/
`findDirective`、补全分支、悬停内容与 URL 编码、CodeLens 状态矩阵、面板
`contextValue` 编码与 `when` 正则覆盖。

## 7. 构建、打包与发布

```sh
npm install          # typescript / @types/vscode / @types/node / @vscode/vsce
npm run compile      # tsc → out/
npm run generate     # 重新生成 data/directives-v<N>.json + manifest.json
npm run package      # vsce → .vsix
```

`tsconfig.json` 关键项：`module: commonjs`（扩展必须）、`target: ES2021`、
`outDir: out`、`strict: true`、`resolveJsonModule: true`、`skipLibCheck: true`。

`.vscodeignore` 的坑：`vsce package` 会打进**所有未排除**的文件。曾误排 `data/**`，
导致运行时找不到数据。**打包后务必 `npx vsce ls` 核对**。正确策略：排除 `src/`、
`scripts/`、`*.map`、`tsconfig.json` 等源码，保留 `out/`、`data/`、`syntaxes/`、
`snippets/`、`language-configuration.json`、`package.json`、`README.md`、
`README.zh-CN.md`、`DEVELOPMENT.md`、`DEVELOPMENT.zh-CN.md`、`resources/`。

发布：本地 `code --install-extension systemd-toolkit-0.1.0.vsix`；市场发布需改
`publisher`（当前占位 `local`）并 `vsce login` + `vsce publish`。

## 8. 后续维护：常见任务的完整步骤

### 8.1 新增一个受支持的 systemd 版本

数据按版本分包（`data/directives-v<N>.json`）。惯例是每个 stable 系列取最新补丁：

```sh
git -C ~/devel/systemd/systemd worktree add /tmp/systemd-v262 v262
cd ~/devel/systemd/vscode.ext
python3 scripts/generate-data.py \
  /tmp/systemd-v258.10 /tmp/systemd-v259.9 /tmp/systemd-v260.5 /tmp/systemd-v261.3 /tmp/systemd-v262
git -C ~/devel/systemd/systemd worktree remove /tmp/systemd-v262
# 同步 package.json 的 systemdSupportedVersions（min/max）
npm run compile && npm run package
```

版本键取 `meson.version` 的前导数字（`258.10` → `258`），与 `systemctl --version`
首行一致，补丁级差异不影响匹配。两个「单一事实来源」：
`data/manifest.json`（运行时判定依据）与 `package.json.systemdSupportedVersions`
（面向人/市场的声明，生成脚本不自动同步它，需手动改）。

### 8.2 升级/更新某个版本的指令集

```sh
python3 scripts/generate-data.py ~/devel/systemd/systemd
npm run compile && npm run package
```

> 确认 `generate-data.py` 顶部的 `SKIP_PAGES`/`PAGE_DEFAULT_SECTIONS`/`CONFIG_FILES`
> 是否需随新版本增删（新版本若新增某类配置文件，需加对应路由）。

### 8.3 新增一种文件类型

以 `.xyz`（指令来自 `systemd.xyz`）为例：`generate-data.py` 里加
`SCOPE_ROUTING`/`PAGE_DEFAULT_SECTIONS`/`CONFIG_FILES` 路由；`package.json`
`contributes.languages[].extensions` 加 `".xyz"`；如需命令/按钮，在
`src/commands.ts` 的 `UNIT_EXT` 与 `package.json` 菜单 `when` 里加 `.xyz`；重新
`npm run generate && npm run compile && npm run package`。

### 8.4 新增一条命令

`package.json` `contributes.commands` 加声明；`src/commands.ts`（或 `tree.ts`/
`unitfile.ts`）`registerCommands` 里 `reg('systemd.xxx', ...)` 注册；如需按钮，在
`menus.editor/title`（编辑器）或 `menus.view/item/context`（面板，注意配
`viewItem` 的 `when` 正则）加一项。

### 8.5 修改补全/悬停逻辑

改**数据**（指令归属/取值）→ 改 `generate-data.py` 重新生成；改**行为**（触发/
展示）→ 改 `src/completion.ts`/`src/help.ts` 后编译。分清这两层。

### 8.6 调试扩展

项目已带 `.vscode/launch.json`（`type: extensionHost` +
`--extensionDevelopmentPath=${workspaceFolder}` + `preLaunchTask` 编译）与
`.vscode/tasks.json`（`npm: compile`）。步骤：

1. `code ~/devel/systemd/vscode.ext` 打开目录。
2. 按 `F5` → 先编译，再**弹出新窗口**（标题栏带 `[Extension Development Host]`）。
3. 新窗口里打开 `foo.service` 验证补全/悬停/Ctrl+Click，命令面板搜 `systemd:`。
4. 回原窗口打断点（`src/*.ts`），新窗口触发操作即命中；Run and Debug 视图看调用
   栈、Debug Console 求值。
5. 改代码后一般无需重启：新窗口执行 **Developer: Reload Window**（或重新 `F5`）。

注意：本扩展 `activate` 是 async，会先解析指令数据版本——自动匹配目标机器的
systemd 版本；当目标无 systemd 或版本不受支持时，弹出选择器让你挑选。先在 Debug
Console 确认有 `systemd extension activated (data v...)` 日志（否则说明未加载
数据，例如你取消了选择器）。数据 JSON 是 `require` 缓存的，改数据后需重新 `F5`
（Reload Window 不会重读）。

官方参考：[Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension)、
[Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)、
[Node.js Debugging](https://code.visualstudio.com/docs/nodejs/nodejs-debugging)。

## 9. 常见坑与注意事项

1. **`.vscodeignore` 误删运行时文件**：打包后 `npx vsce ls` 核对。
2. **`when` 子句正则转义**：JSON 里写 `\\.` 才是实际 `\.`；`=~` 遵循 JS 正则
   （支持 `|`/`()` 分组，不支持 lookahead）。
3. **补全必须设 `item.range`**：否则替换范围错误，补全会吞字。
4. **悬停用 `getWordRangeAtPosition` 而非行解析**：悬停位置 ≠ 光标位置。
5. **ElementTree 无父指针**：回溯节标题自建 parent map。
6. **man 页 XML 有自定义实体**：不预处理 `ET.parse` 报 `undefined entity`。
7. **数据懒加载**：别在 `activate` 就 `require` 大 JSON，首次补全/悬停需要时再加载。
8. **`require` 相对路径**：编译后 `__dirname` 是 `out/`，数据用
   `path.join(__dirname, '..', 'data', ...)` 定位。
9. **`systemctl status` 退出码不可靠**：3 也输出完整状态，判断要读 stdout。
10. **`list-units` 不包含未加载 unit**：GC 会卸载 inactive unit，只有
    `list-unit-files` 可靠——Installed 视图的差集即为此设。
11. **user 作用域永不提权**：sudo 会切到 root 的用户实例。
12. **状态栏只支持 codicon**：自定义 SVG 只能用于视图/容器图标。

## 附：最小可运行的心智模型

> **一个 Python 脚本把 systemd man 页编译成 JSON 知识库；TypeScript 运行时通过
> 「文件类型 → 作用域 → 当前节 → 指令」四级查询，用三个 provider（补全/悬停/
> 文档链接）把知识库接进编辑体验；再用 `buildCommand` 这一条命令链路把
> `systemctl`/`journalctl` 接进命令、面板、CodeLens 与实时日志。**

理解并保持这条主线，之后无论怎么迭代都不会迷路。
