# systemd VS Code Extension — Development Guide

> For developers who want to understand, modify, extend, or maintain this
> project. It follows the order "design rationale → implementation → maintenance".

## Contents

1. [Overall design](#1-overall-design)
2. [The VS Code extension model](#2-the-vs-code-extension-model)
3. [Data pipeline: generating the directive index from man pages](#3-data-pipeline-generating-the-directive-index-from-man-pages)
4. [Module walkthrough](#4-module-walkthrough)
5. [Implementation: how each feature works](#5-implementation-how-each-feature-works)
6. [Testing](#6-testing)
7. [Build, package, publish](#7-build-package-publish)
8. [Maintenance: common tasks step by step](#8-maintenance-common-tasks-step-by-step)
9. [Pitfalls & notes](#9-pitfalls--notes)

## 1. Overall design

### 1.1 Goals

The requirements split into two kinds:

| Kind | Needs | Nature |
| --- | --- | --- |
| Editing | syntax highlighting, completion, snippets, help | a "language service" — interacts with file content |
| Usage | status/deploy/logs commands + panel | invoke `systemctl`/`journalctl` and show results |

The first is the bulk and is fully offline/testable; the second is a thin layer.
Priority: **editing first, commands/panel minimal**.

### 1.2 Core insight: turn "knowledge" into "data"

Completion and hover need a large, precise knowledge base: systemd has hundreds
of directives, each belonging to a `[Section]`, applying to a file type, with
allowed values and a man-page reference — hand-writing this is a disaster, so it
must be generated. The source is the **man-page XML** (not `.gperf`): it
naturally contains the *descriptions* hover needs, is regular (each
`<varlistentry>` in a `<variablelist>` is one directive), and keeps directive /
section / man-page ref / value examples in the same node.

So the whole extension rests on: **one Python script → one JSON → TypeScript
runtime table lookups**.

### 1.3 Data model: scopes resolve section-name collisions

The same `[Section]` name means different things in different file types
(`[Service]` in a unit file vs. a `.dnssd` file; `[Match]`/`[Link]` in both
`.network` and `.link`). A single global "section → directives" table would
collide. The fix is **scopes**:

```jsonc
{
  "scopes": { "unit": { "sections": { "Unit": [...], "Service": [...] } } },
  "fileTypes": { "service": { "scope": "unit", "sections": ["Unit","Install","Service"], "doc": "systemd.service" } },
  "filenames": { "journald.conf": { "scope": "config:journald.conf", "sections": ["Journal"], "doc": "journald.conf" } }
}
```

Runtime lookup chain: **file → (extension/filename) → fileType/filename → scope +
valid sections → current `[Section]` → directives**. File recognition, section
recognition and directive lookup are decoupled; adding a file type only changes
data, not code.

## 2. The VS Code extension model

- **`activate(context)` / `deactivate()`**: entry/exit. `activate` registers all
  providers and commands.
- **`package.json` `contributes`**: statically declares what the extension
  contributes — languages, grammars, snippets, commands, settings, menus.
- **Providers**: VS Code calls you back at specific moments —
  `CompletionItemProvider` (typing), `HoverProvider` (hover),
  `DocumentLinkProvider` (Ctrl+Click). Note `DefinitionProvider` is
  "go to definition" (in-editor navigation) and **cannot** open a web page — it
  errors with "Unable to resolve resource". Use `DocumentLinkProvider` for
  external links.
- **`activationEvents`**: decides when the extension activates.
- **`DocumentSelector`**: decides which files a provider applies to.

### 2.1 Activation strategy

```jsonc
"activationEvents": ["onLanguage:systemd", "onStartupFinished"]
```

`onStartupFinished` exists because drop-in config files
(`/etc/systemd/xxx.conf.d/*.conf`) are often classified as `ini`/`plaintext`,
not our `systemd` language. To give them completion too, providers are
registered on a `**/*.conf` glob — and that glob only works if the extension is
already activated. The cost is a resident extension; acceptable because data is
lazy-loaded.

`activate` registers the data-independent parts unconditionally (commands, logs,
tree views, unit-file ops, CodeLens, status bar), and the language providers
(completion/hover/links) are also registered unconditionally but no-op while no
directive data is loaded; then it detects the version in the background and calls
`setActiveVersion()` (a `systemctl --version` round-trip to a remote host is too
slow to block activation). Host changes re-run version detection and refresh.

## 3. Data pipeline: generating the directive index from man pages

File: `scripts/generate-data.py`. A directive in a man page looks like this
(simplified):

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

Extracted per directive:

- **name**: `<varname>` minus trailing `=` and `<replaceable>` placeholders. A
  `varlistentry` may use **multiple `<term>`s** (`Before=`/`After=`), so all
  `<term>`s must be iterated (an early version took only the first and lost
  `After=`).
- **section**: walk up to the nearest `[X] Section Options` heading; fall back to
  the page default.
- **summary**: render the first `<listitem>` paragraphs to **Markdown**
  (`<option>`/`<varname>`/`<filename>`/`<literal>` → backticked code).
- **values**: cover three sentence shapes — `one of …` `<option>`, `special
  value(s) …` `<literal>`, and `takes a boolean` (boolean set
  `yes/no/true/false/on/off`, **merged** with special values, so
  `ProtectSystem=` = `full`/`strict` + booleans).
- **value docs**: from "If/When set to `X`, …", stored as `valueDocs`.
- **version**: the `X` in `<xi:include href="version-info.xml" xpointer="vX"/>`
  ("Added in version X"), stored as `addedIn`.

Three pitfalls that must be handled:

1. **Custom XML entities** (`&FALLBACK_HOSTNAME;` etc., defined in
   `man/custom-entities.ent.in`): `ET.parse` won't resolve them — preprocess by
   substituting readable text.
2. **ElementTree has no `get_parent()`**: build a parent map to walk up.
3. **Section-name collisions**: route via scopes (`SCOPE_ROUTING` +
   `config:<page>`).

`merge_directives` dedupes by name, merges value sets, fills in missing
summaries. Each source checkout emits one `data/directives-v<N>.json` and a
`data/manifest.json` is written.

## 4. Module walkthrough

| File | Responsibility |
| --- | --- |
| `src/types.ts` | pure types (Directive / ScopeData / FileTypeInfo / DirectivesData / Manifest) |
| `src/data.ts` | load manifest, per-version data, file/section recognition, directive lookup |
| `src/version.ts` | target systemd version detection & selection |
| `src/remote.ts` | SSH host + ssh/sudo wrapping (buildCommand), scope, homeDir, deployedUnits |
| `src/context.ts` | parse the cursor line into comment/section/key/value |
| `src/completion.ts` | completion provider |
| `src/help.ts` | hover + document links (Ctrl+Click) provider |
| `src/commands.ts` | editor-level systemctl/journalctl commands (reuse remote.ts) |
| `src/tree.ts` | the three panel views (Target / Loaded / Installed) + their commands |
| `src/unitfile.ts` | view / edit / new / deploy unit files; snapshot cache; documentScope |
| `src/codelens.ts` | editor status + action CodeLens |
| `src/logs.ts` | live logs (systemd-log virtual documents) |
| `src/statusbar.ts` | status bar (host · scope · version) |
| `src/process.ts` | child_process wrapper (spawn/exec, stdin support); records commands in the log |
| `src/logger.ts` | the "systemd Toolkit" log channel (extension logs + command records) |
| `src/extension.ts` | assembly: register providers, commands, tree, CodeLens, status bar |

Dependencies are one-way: `extension.ts` depends on everything; feature modules
depend on `data.ts`/`context.ts`; `types.ts` is depended on by all; no cycles.

### 4.1 `src/data.ts`

```ts
loadManifest(): Manifest | undefined
setActiveVersion(version): boolean   // lazily load one version's data
resolveFile(document): ResolvedFile | undefined
sectionAt(document, position): string | undefined
findDirective(scope, section, name): Directive
```

Multi-version loading is "select version, then query": `setActiveVersion()`
lazily `require`s the version's `directives-v<N>.json` into a module variable.

`resolveFile` order: extension in `fileTypes`? → filename in `filenames`? →
extension is `.conf` (read first section to reverse-map a config scope, for
drop-ins)? → else `undefined`.

`sectionAt` scans upward from the cursor line for the nearest
`^\s*\[([^\]]+)\]\s*$` — simple and reliable.

### 4.2 `src/context.ts`

Outputs `LineContext { lineText, beforeCursor, afterCursor, inSection, key,
inValue, inComment }`. Judgement is naive: leading `#`/`;` → comment; `[` →
section header; a `=` before the cursor → value position (text before `=` is the
key); otherwise → key position. This "current line + cursor position" heuristic
avoids writing a full parser and is enough for INI-style files.

## 5. Implementation: how each feature works

### 5.1 Syntax highlighting (TextMate)

File: `syntaxes/systemd.tmLanguage.json`. Three core patterns: comment, section
header, `key=value` (with a nested `#value` sub-pattern for second-level
highlighting inside the value). `scopeName` (`source.systemd`) is the grammar's
identity; `package.json` binds language id `systemd` to it.

### 5.2 Completion (`src/completion.ts`)

`provideCompletionItems` flow: `resolveFile` → not a systemd file, return;
`lineContext` → comment, return; `inSection` → section-name completion;
`inValue` → value completion; otherwise → directive completion.

Points to remember: **always set `item.range` precisely** (otherwise VS Code
replaces the whole "word" and `ExecStart` only completes to `Exec`);
`insertText = name + '='` (carry the `=`, dropping the cursor at the value
position to chain value completion); `triggerCharacters = ['=', '[', '.']`.

### 5.3 Hover & Ctrl+Click (`src/help.ts`)

Hover uses `document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9_]*/)`
to get the full word under the mouse (**not** `lineContext.key`, because the
hover position ≠ the cursor position).

Ctrl+Click uses `DocumentLinkProvider`: emit a `DocumentLink` for each known
directive key, with `target` pointing to
`https://…/systemd.service.html#Type=` (`=` URL-encoded to `%3D`; freedesktop.org
emits `<a id="Type=">`). **Do not** use `DefinitionProvider` (errors with
"Unable to resolve resource").

Dependency jumps: for dependency directives (`After=`/`Wants=`/`WantedBy=`/…),
`help.ts` emits a `DocumentLink` to the `systemd-unit:` snapshot URI when the
target is deployed (`isUnitDeployed`), and background-`preloadSnapshots` warms
direct dependencies so Ctrl+Click opens instantly.

### 5.4 Command integration, auth & SSH

- **Infer unit name**: `path.basename(activeEditor.document.fileName)` if it
  matches `/\.(service|socket|...)$/`, else `showInputBox`.
- **Output**: commands run in an integrated terminal; the **systemd Toolkit**
  log channel records each command line (`process.ts` `exec`) plus extension
  lifecycle/error logs — diagnostics only, no raw command output.
- **Subprocesses**: `spawn`/`exec` (`process.ts`), no shell string concat; log
  commands stream with `--follow`.
- **Auth**: `start/stop/restart/enable/disable/daemon-reload` need root. They are
  prefixed with `systemd.authMethod` (`sudo`/`pkexec`); because commands run in
  an integrated terminal (which provides a TTY), interactive auth works.
  `status`/`logs` don't elevate.
- **Remote**: `src/remote.ts`'s `buildCommand(base, args, elevate, scope)`
  builds argv uniformly — elevation prefix first, then `ssh <host>` outermost.
  ssh uses ControlMaster options (`ControlMaster=auto` + `ControlPath` +
  `ControlPersist=60`) to reuse one connection, the main latency win for remote
  hosts.
- **Single command path**: panel (`tree.ts`), files (`unitfile.ts`), CodeLens
  (`codelens.ts`), logs (`logs.ts`) all reuse `buildCommand` + `exec`; there is
  no second command-construction/execution path.

### 5.5 Scope (system/user) & documentScope

`systemd.scope` (`system`|`user`) decides which systemd instance to manage.
`remote.ts`'s `systemctlArgs`/`journalctlArgs` prepend `--user` in user scope
(except `--version`), and `buildCommand` **never elevates** in user scope (sudo
would switch to root's user instance).

**Session scope vs document scope** are two layers:

- Session scope: the panel follows it — read by `scope()`, switched by
  `setSessionScope()` (without changing the config default).
- Document scope: editor CodeLens/commands follow the *file's own* scope
  (`documentScope()`) — a temp edit carries the scope it was opened with; a
  snapshot encodes scope in its `systemd-unit:` URI; a plain file infers from
  path (`scopeFromPath`: `/systemd/user/`, `~/.config/systemd/user/` → user,
  `/systemd/system/` → system, ambiguous → session scope).

So even after switching the session to user, editing
`/etc/systemd/system/foo.service` still runs status/start/stop/logs/deploy
against the **system** instance. The snapshot cache is keyed by `scope:unit`.

### 5.6 Units panel (`src/tree.ts`)

Three `TreeDataProvider`s, one view each:

- **TargetProvider** (`systemd.target`) — two clickable items: current host
  (click → `systemd.switchHost`), current scope (click → `systemd.switchScope`).
- **SystemdUnitsProvider** (`systemd.units`, view "Loaded") — `list-units --all`,
  list/tree toggle (grouped by unit type, empty groups shown), show/hide
  inactive, name filter.
- **InstalledUnitsProvider** (`systemd.installed`, collapsed by default) — the
  **difference** between `list-unit-files` and `list-units` (installed but not
  loaded), lazy-loaded, own list/tree/filter, tree groups carry a **New** button
  (`systemd.units.newUnit` by `unitType`).

**Why an Installed view**: systemd's GC (`unit_may_gc` in `src/core/unit.c`)
unloads inactive, unreferenced units. A freshly deployed inactive unit is
*transiently* loaded by `show`-like commands and then unloaded again, so it never
stably appears in `list-units`; only `list-unit-files` sees it. Hence the
difference view.

**State-dependent buttons**: the `view/item/context` menu `when` can only match
the item's `contextValue`. `UnitItem` encodes state as
`contextValue = unit:<run>:<enable>`:

- `<run>` = `active` / `inactive` / `failed` / `transition` / `masked` (derived
  from LoadState+ActiveState; `masked` overrides `inactive`);
- `<enable>` = `enabled` / `disabled` / `other` (from UnitFileState).

Then `package.json` uses regex `when` clauses (`=~` follows standard JS regex):

```text
Start    viewItem =~ /^unit:inactive/
Stop     viewItem =~ /^unit:active/
Restart  viewItem =~ /^unit:(active|failed)/
Enable   viewItem =~ /:disabled$/
Disable  viewItem =~ /:enabled$/
Status/Logs/ViewFile/EditFile  viewItem =~ /^unit:/
```

`masked`/`transition` match no run action and `other`/`masked` match no
enable/disable, so they naturally show only Logs/Status/View/Edit. The Loaded
view therefore joins one `list-unit-files` call to obtain UnitFileState
(`listUnitFileStates()`, shared with the installed diff).

### 5.7 View / edit / new / deploy unit files (`src/unitfile.ts`)

- **View**: `systemctl cat` snapshot into a virtual document
  (`systemd-unit:/<scope>/<unit>`), read-only, cached and deduped.
- **Edit**: resolve `FragmentPath` (`systemctl show -p FragmentPath --value`),
  read it into a same-named temp file under `TEMP_DIR` (keeping the `.service`
  extension so language features stay active), record `pendingEdits:
  doc URI → {unit, fragmentPath, scope}`; the temp file is deleted on tab close.
- **New**: prompt for a name → create an empty temp file → record the pending
  edit → insert the type's snippet (`snippets/units.json`).
- **Deploy** (`deployCurrentFile`):
  - temp edit → write back to `FragmentPath`; if it's a vendor file
    (`/usr/lib/systemd/` or `/lib/systemd/`), write an override to the unit dir
    instead (systemd's recommended approach);
  - a plain `.service` file → `/etc/systemd/system/<name>` (user scope
    `~/.config/systemd/user/<name>`);
  - overwriting an existing file on the target → confirm first;
  - after a successful write, `systemctl daemon-reload` (honouring scope); any
    failure reports an error and refuses.

**deploy and enable are orthogonal stages**: deploy = install the file +
`daemon-reload` (does **not** start, does **not** enable); enable = create the
`.wants` symlink per the `[Install]` section. Relatedly, unit state has several
**orthogonal dimensions**: LoadState (loaded/not-found/masked/…), ActiveState
(active/inactive/failed/…), SubState (running/dead/…), UnitFileState
(enabled/disabled/static/masked/…). `systemctl status` exits 0=active,
3=inactive/failed, 4=no such unit, but 3 still prints the full status header to
stdout — so judge by **stdout**, not the exit code.

### 5.8 CodeLens (`src/codelens.ts`)

One `systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState
<unit>` call gets all four dimensions (`queryUnitState`), then:

- `loadState` `not-found`/`unknown` → **not deployed**, only `Deploy`;
- otherwise **deployed**:
  - status label always ( `ActiveState (SubState)` );
  - run actions (when `loadState !== 'masked'`): active → Stop+Restart; failed →
    Restart; inactive → Start; else (activating/deactivating/reloading/unknown)
    → none;
  - enable/disable: `enabled` → Disable; `disabled` → Enable; else none;
  - Logs always;
  - file action: read-only preview → `Edit`; editable copy → `Deploy`.

`unitForDocument` resolves only `file`/`untitled` schemes (`systemd-log` etc.
return `undefined`), so live-log views show **no CodeLens**.

### 5.9 Live logs (`src/logs.ts`)

`LogContentProvider` (scheme `systemd-log`) **synchronously** spawns
`journalctl -u <unit> --follow --no-pager -n 300` (via `buildCommand`, so SSH/
scope are automatic) inside `provideTextDocumentContent`, returning buffered
content immediately ("Waiting for log output…" when empty, instead of hanging on
"Opening"). Data triggers throttled (500ms) `onDidChange` refreshes; the buffer
is capped at 256KB (trimmed, dropping the partial first line). `showLogs` records
`unit → scope` for `spawn`; closing the tab `stop(unit)` kills the process, and
extension shutdown `stopAll`.

### 5.10 Status bar (`src/statusbar.ts`)

`StatusBarItem.text` shows `host · scope · vNNN` (plain text, codicon-compatible
only), click pops a QuickPick to switch host or scope. `onHostChanged`/
`onScopeChanged`/version changes trigger `refresh`. Note status-bar text only
supports codicons, not custom SVGs — so no `resources/systemd.svg` here.

## 6. Testing

No test framework; instead **"mock the vscode module" for lightweight unit
tests**. The data layer and completion logic don't depend on UI, so mock the few
symbols they use and run under Node:

```js
const vscode = { EventEmitter, Uri, workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: {...}, commands: {...} };
// intercept require('vscode') / './remote' / './commands' / './unitfile'
```

Key lesson: **mocks must faithfully reproduce the real API semantics** (e.g.
`getText(range)` must return the range's text), otherwise "test passes" ≠ "code
correct". Coverage: `resolveFile`/`sectionAt`/`findDirective`, completion
branches, hover content & URL encoding, the CodeLens state matrix, and the panel
`contextValue` encoding + `when` regex coverage.

## 7. Build, package, publish

```sh
npm install          # typescript / @types/vscode / @types/node / @vscode/vsce
npm run compile      # tsc → out/
npm run generate     # regenerate data/directives-v<N>.json + manifest.json
npm run package      # vsce → .vsix
```

Key `tsconfig.json` options: `module: commonjs` (required), `target: ES2021`,
`outDir: out`, `strict: true`, `resolveJsonModule: true`, `skipLibCheck: true`.

`.vscodeignore` pitfall: `vsce package` includes **everything not excluded**. The
`data/**` directory was once wrongly excluded, breaking runtime. **Always check
with `npx vsce ls` after packaging.** Correct strategy: exclude sources (`src/`,
`scripts/`, `*.map`, `tsconfig.json`), keep runtime (`out/`, `data/`,
`syntaxes/`, `snippets/`, `language-configuration.json`, `package.json`,
`README.md`, `README.zh-CN.md`, `DEVELOPMENT.md`, `DEVELOPMENT.zh-CN.md`,
`resources/`).

Publish: locally `code --install-extension systemd-toolkit-0.1.0.vsix`; to the
Marketplace, change `publisher` (currently placeholder `local`) and run
`vsce login` + `vsce publish`.

## 8. Maintenance: common tasks step by step

### 8.1 Add a supported systemd version

Data is per-version (`data/directives-v<N>.json`). Convention: latest patch of
each stable series:

```sh
git -C ~/devel/systemd/systemd worktree add /tmp/systemd-v262 v262
cd ~/devel/systemd/vscode.ext
python3 scripts/generate-data.py \
  /tmp/systemd-v258.10 /tmp/systemd-v259.9 /tmp/systemd-v260.5 /tmp/systemd-v261.3 /tmp/systemd-v262
git -C ~/devel/systemd/systemd worktree remove /tmp/systemd-v262
# sync package.json's systemdSupportedVersions (min/max)
npm run compile && npm run package
```

The version key is the leading number of `meson.version` (`258.10` → `258`),
matching the first line of `systemctl --version`, so patch-level differences
don't affect matching. Two "single sources of truth": `data/manifest.json`
(runtime) and `package.json.systemdSupportedVersions` (declaration; the
generator does not sync it — edit manually).

### 8.2 Update a version's directive set

```sh
python3 scripts/generate-data.py ~/devel/systemd/systemd
npm run compile && npm run package
```

> Check whether `SKIP_PAGES`/`PAGE_DEFAULT_SECTIONS`/`CONFIG_FILES` at the top of
> `generate-data.py` need changes for the new version (a new config file type
> needs a new route).

### 8.3 Add a file type

For `.xyz` (directives from `systemd.xyz`): add routing in `generate-data.py`
(`SCOPE_ROUTING`/`PAGE_DEFAULT_SECTIONS`/`CONFIG_FILES`); add `".xyz"` to
`package.json` `contributes.languages[].extensions`; for commands/buttons, add
`.xyz` to `src/commands.ts`'s `UNIT_EXT` and the menu `when` clauses; then
`npm run generate && npm run compile && npm run package`.

### 8.4 Add a command

Add the declaration in `package.json` `contributes.commands`; register it in
`src/commands.ts` (or `tree.ts`/`unitfile.ts`) via `reg('systemd.xxx', ...)`; for
a button, add an entry to `menus.editor/title` (editor) or
`menus.view/item/context` (panel — mind the `viewItem` regex `when`).

### 8.5 Change completion/hover

Change **data** (directive placement/values) → edit `generate-data.py` and
regenerate; change **behaviour** (when to trigger / how to display) → edit
`src/completion.ts`/`src/help.ts` and recompile. Keep the two layers distinct.

### 8.6 Debugging

The project ships `.vscode/launch.json` (`type: extensionHost` +
`--extensionDevelopmentPath=${workspaceFolder}` + `preLaunchTask` compile) and
`.vscode/tasks.json` (`npm: compile`). Steps:

1. `code ~/devel/systemd/vscode.ext`.
2. Press `F5` → compile, then a **new window** pops up (title bar shows
   `[Extension Development Host]`).
3. In the new window, open a `foo.service` and verify completion/hover/
   Ctrl+Click; search the command palette for `systemd:`.
4. Back in the original window, set breakpoints in `src/*.ts`, trigger the action
   in the new window; use the Run and Debug view and Debug Console.
5. After edits you usually don't restart: run **Developer: Reload Window** in the
   new window (or re-`F5`).

Note: `activate` is async and runs version detection first; an "unsupported
version" early-return registers no providers — confirm
`systemd extension activated (data v...)` in the Debug Console, otherwise
override with `systemd.versionOverride`. Data JSON is `require`-cached, so after
changing data you must re-`F5` (Reload Window won't re-read).

References: [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension),
[Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension),
[Node.js Debugging](https://code.visualstudio.com/docs/nodejs/nodejs-debugging).

## 9. Pitfalls & notes

1. **`.vscodeignore` dropping runtime files**: check with `npx vsce ls` after
   packaging.
2. **`when` clause regex escaping**: `\\.` in JSON is the real `\.`; `=~` follows
   JS regex (supports `|`/`()` groups, no lookahead).
3. **Completion must set `item.range`**: otherwise the replace range is wrong.
4. **Hover uses `getWordRangeAtPosition`, not line parsing**: hover position ≠
   cursor position.
5. **ElementTree has no parent pointer**: build a parent map to walk up.
6. **Man-page XML has custom entities**: unpreprocessed `ET.parse` errors with
   `undefined entity`.
7. **Lazy-load data**: don't `require` the big JSON in `activate`; load on first
   real need.
8. **`require` relative paths**: after compiling `__dirname` is `out/`, so locate
   data with `path.join(__dirname, '..', 'data', ...)`.
9. **`systemctl status` exit code is unreliable**: 3 also prints full status —
   read stdout.
10. **`list-units` omits unloaded units**: GC unloads inactive units; only
    `list-unit-files` is reliable — hence the Installed view's difference.
11. **User scope never elevates**: sudo would switch to root's user instance.
12. **Status bar supports only codicons**: custom SVGs are only for view/container
    icons.

## Appendix: the minimal mental model

> **One Python script compiles the systemd man pages into a JSON knowledge base;
> the TypeScript runtime answers "file type → scope → current section →
> directive" lookups and wires the knowledge base into editing via three
> providers (completion/hover/document-link); a single `buildCommand` path wires
> `systemctl`/`journalctl` into commands, the panel, CodeLens, and live logs.**

Keep this main line in mind and no amount of iteration will get you lost.
