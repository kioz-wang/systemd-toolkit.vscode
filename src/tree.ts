import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { systemctl, host, setSessionHost, scope, setSessionScope } from './remote';
import { runSystemctl, runLogs } from './commands';
import { newUnitFile } from './unitfile';
import { systemdAvailability } from './version';

/** A clickable item showing the current host (click to switch). */
class HostItem extends vscode.TreeItem {
    constructor(current: string) {
        super(current || 'local', vscode.TreeItemCollapsibleState.None);
        this.description = 'host';
        this.contextValue = 'host';
        this.iconPath = new vscode.ThemeIcon('remote');
        this.tooltip = 'Click to switch host';
        this.command = { command: 'systemd.switchHost', title: 'Switch host' };
    }
}

/** A clickable item showing (and switching) the unit scope. */
class ScopeItem extends vscode.TreeItem {
    constructor(current: 'system' | 'user') {
        super(current, vscode.TreeItemCollapsibleState.None);
        this.description = 'scope';
        this.contextValue = 'scope';
        this.iconPath = new vscode.ThemeIcon(current === 'user' ? 'account' : 'server');
        this.tooltip = 'Click to switch between system and user units';
        this.command = { command: 'systemd.switchScope', title: 'Switch unit scope' };
    }
}

/** A hint shown when the local machine has no systemd (e.g. Windows). */
class SystemdHintItem extends vscode.TreeItem {
    constructor() {
        super('systemd not detected', vscode.TreeItemCollapsibleState.None);
        this.description = 'language features only';
        this.contextValue = 'hint';
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
        this.tooltip =
            'systemd was not found on this machine (Windows or a non-systemd Linux). ' +
            'Editing, completion and hover still work, but the panel, CodeLens and ' +
            'management commands are disabled.';
    }
}

/** A separate "Target" section (like Explorer's Outline/Timeline) listing host + scope. */
export class TargetProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];
        if (host() === '' && systemdAvailability() === 'unavailable') {
            items.push(new SystemdHintItem());
        }
        items.push(new HostItem(host()), new ScopeItem(scope()));
        return items;
    }
}

/** Read Host aliases from ~/.ssh/config (skip wildcards/patterns). */
function sshHostAliases(): string[] {
    try {
        const configPath = path.join(os.homedir(), '.ssh', 'config');
        const text = fs.readFileSync(configPath, 'utf8');
        const hosts: string[] = [];
        for (const line of text.split('\n')) {
            const m = /^\s*Host\s+(.+)$/i.exec(line);
            if (m) {
                for (const h of m[1].trim().split(/\s+/)) {
                    if (h && h !== '*' && !h.includes('*') && !h.includes('?') && !hosts.includes(h)) {
                        hosts.push(h);
                    }
                }
            }
        }
        return hosts;
    } catch {
        return [];
    }
}

/**
 * Unit type → display group, ordered the way systemd's own documentation
 * presents the unit types (service, socket, timer, path, target, slice, scope,
 * mount, swap, automount, device).
 */
const UNIT_TYPES: Record<string, { group: string; order: number }> = {
    service: { group: 'Services', order: 1 },
    socket: { group: 'Sockets', order: 2 },
    timer: { group: 'Timers', order: 3 },
    path: { group: 'Paths', order: 4 },
    target: { group: 'Targets', order: 5 },
    slice: { group: 'Slices', order: 6 },
    scope: { group: 'Scopes', order: 7 },
    mount: { group: 'Mounts', order: 8 },
    swap: { group: 'Swap', order: 9 },
    automount: { group: 'Automounts', order: 10 },
    device: { group: 'Devices', order: 11 },
};

function typeInfo(unit: string): { group: string; order: number } {
    const m = /\.([a-z]+)$/.exec(unit);
    return (m && UNIT_TYPES[m[1]]) || { group: 'Other', order: 99 };
}

/** All known type groups in display order, so empty categories still show. */
const KNOWN_GROUPS: { group: string; type: string; order: number }[] = Object.entries(UNIT_TYPES)
    .map(([type, { group, order }]) => ({ group, type, order }))
    .sort((a, b) => a.order - b.order);

/** A single systemd unit in the tree. */
/**
 * Classify a unit's load/active state into the "run" segment of its
 * contextValue, mirroring the CodeLens run-action matrix:
 *   active -> Stop/Restart, inactive -> Start, failed -> Restart,
 *   masked or transitional -> no run action.
 */
function classifyRun(load: string, active: string): string {
    if (load === 'masked') {
        return 'masked';
    }
    switch (active) {
        case 'active':
            return 'active';
        case 'inactive':
            return 'inactive';
        case 'failed':
            return 'failed';
        default:
            // activating / deactivating / reloading / unknown
            return 'transition';
    }
}

/** Classify a unit's UnitFileState into the "enable" segment: only enabled/disabled are actionable. */
function classifyEnable(fileState: string): string {
    if (fileState === 'enabled') {
        return 'enabled';
    }
    if (fileState === 'disabled') {
        return 'disabled';
    }
    return 'other';
}

export class UnitItem extends vscode.TreeItem {
    constructor(
        public readonly unit: string,
        public readonly load: string,
        public readonly active: string,
        public readonly sub: string,
        public readonly description: string,
        public readonly fileState: string = ''
    ) {
        super(unit, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        // tooltip is left undefined and resolved lazily (see resolveTreeItem)
        // to show a richer `systemctl status` summary without the journal.
        // contextValue encodes runtime state so view/item/context `when`
        // clauses can show only the applicable actions (see package.json).
        this.contextValue = `unit:${classifyRun(load, active)}:${classifyEnable(fileState)}`;
        this.iconPath = new vscode.ThemeIcon(
            active === 'active' ? 'circle-filled' : active === 'failed' ? 'error' : 'circle-outline',
            active === 'active'
                ? new vscode.ThemeColor('charts.green')
                : active === 'failed'
                    ? new vscode.ThemeColor('charts.red')
                    : active === 'inactive'
                        ? new vscode.ThemeColor('charts.gray')
                        : undefined
        );
        // Clicking a unit opens its read-only preview (snapshot).
        this.command = {
            command: 'systemd.units.viewFile',
            title: 'Show unit file',
            arguments: [this],
        };
    }
}

/** A type group node in tree mode, e.g. "Services", "Timers". */
class TypeGroup extends vscode.TreeItem {
    constructor(group: string, public readonly units: UnitItem[], public readonly unitType?: string) {
        super(group, units.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.description = `${units.length}`;
        // Only groups with a known unit type offer the "New" action.
        this.contextValue = unitType ? 'type-group' : 'type-group-other';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

function parseLine(line: string, fileStates: Map<string, string>): UnitItem | undefined {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (!m) {
        return undefined;
    }
    return new UnitItem(m[1], m[2], m[3], m[4], m[5], fileStates.get(m[1]) ?? '');
}

/**
 * Map of unit name -> UnitFileState from `list-unit-files`. Used both to
 * attach enablement state to Loaded-view items and to diff against `list-units`.
 */
async function listUnitFileStates(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const r = await systemctl(['list-unit-files', '--all', '--no-legend', '--no-pager']);
    if (r.code !== 0) {
        return map;
    }
    for (const line of r.stdout.split('\n')) {
        // "UNIT FILE  STATE  [PRESET]"
        const m = /^(\S+)\s+(\S+)/.exec(line.trim());
        if (m) {
            map.set(m[1], m[2]);
        }
    }
    return map;
}

/**
 * Units installed (`list-unit-files`) but not currently loaded (`list-units`).
 * A freshly deployed, inactive unit is not kept in `list-units` — systemd's
 * garbage collector unloads inactive, unreferenced units (see unit_may_gc in
 * src/core/unit.c) — so this diff is the only way to surface them. Each entry
 * is marked inactive/unloaded and shows its UnitFileState as the description.
 */
async function listInstalledNotLoaded(): Promise<UnitItem[]> {
    const [fileStates, unitsRes] = await Promise.all([
        listUnitFileStates(),
        systemctl(['list-units', '--all', '--no-legend', '--no-pager', '--plain']),
    ]);

    const loaded = new Set<string>();
    if (unitsRes.code === 0) {
        for (const line of unitsRes.stdout.split('\n')) {
            const m = /^(\S+)\s/.exec(line.trim());
            if (m) {
                loaded.add(m[1]);
            }
        }
    }

    const items: UnitItem[] = [];
    for (const [unit, state] of fileStates) {
        if (!loaded.has(unit)) {
            // A masked unit cannot be started or enabled; encode its load state
            // so classifyRun yields 'masked' (no Start/Enable actions).
            items.push(new UnitItem(unit, state === 'masked' ? 'masked' : 'unloaded', 'inactive', 'dead', state, state));
        }
    }
    return items;
}

function sortUnits(a: UnitItem, b: UnitItem): number {
    // Active units first, then by name.
    const order = (u: UnitItem) => (u.active === 'active' ? 0 : u.active === 'failed' ? 1 : 2);
    return order(a) - order(b) || a.unit.localeCompare(b.unit);
}

type ViewMode = 'list' | 'tree';
let viewMode: ViewMode = 'tree';

/** When false, inactive units are hidden from both list and tree modes. */
let showInactive = false;

/** Name filter for the "Loaded" view; when non-empty, only matching units are shown. */
let filter = '';

/** View mode for the "Installed" view (independent of the "Loaded" view). */
let installedViewMode: ViewMode = 'tree';

/** Name filter for the "Installed" view (independent of the "Loaded" view). */
let installedFilter = '';

/**
 * Single Units view with two modes, toggled via view/title buttons (like the
 * Explorer's list/tree toggle): "list" is a flat list, "tree" groups units by
 * their type. Both share the same status-bearing UnitItem, so state is shown
 * in both modes.
 */
export class SystemdUnitsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    /** Lazily enrich a unit's tooltip with a `systemctl status` summary (no journal). */
    async resolveTreeItem(item: vscode.TreeItem): Promise<vscode.TreeItem> {
        if (item instanceof UnitItem) {
            const r = await systemctl(['status', item.unit, '--no-pager', '-n', '0']);
            // `systemctl status` prints the status header even for inactive/failed
            // units, but with a non-zero exit code (3); only an unknown unit (4)
            // produces no useful stdout. So rely on stdout, not the exit code.
            const body = r.stdout.trim()
                ? r.stdout.trim()
                : `Load: ${item.load}\nActive: ${item.active} (${item.sub})`;
            const md = new vscode.MarkdownString();
            md.appendCodeblock(body, 'text');
            item.tooltip = md;
        }
        return item;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof TypeGroup) {
            return element.units;
        }
        if (element) {
            return [];
        }

        const [result, fileStates] = await Promise.all([
            systemctl(['list-units', '--all', '--no-legend', '--no-pager', '--plain']),
            listUnitFileStates(),
        ]);
        if (result.code !== 0) {
            void vscode.window.showErrorMessage(
                `systemd: failed to list units: ${result.stderr || result.stdout}`
            );
            return [];
        }
        const units = result.stdout
            .split('\n')
            .map((line) => parseLine(line, fileStates))
            .filter((x): x is UnitItem => x !== undefined)
            .filter((u) => showInactive || u.active !== 'inactive')
            .filter((u) => !filter || u.unit.toLowerCase().includes(filter.toLowerCase()))
            .sort(sortUnits);

        if (viewMode === 'list') {
            return units;
        }

        // Tree: group by unit type (Services, Sockets, Timers, Targets, …).
        // Show every known category (even empty) for a consistent layout; the
        // "New" action lives in the "Installed" view, so these carry no type.
        const byGroup = new Map<string, UnitItem[]>();
        const unknown: UnitItem[] = [];
        for (const u of units) {
            const { group } = typeInfo(u.unit);
            if (group === 'Other') {
                unknown.push(u);
                continue;
            }
            if (!byGroup.has(group)) {
                byGroup.set(group, []);
            }
            byGroup.get(group)!.push(u);
        }
        const groups: TypeGroup[] = KNOWN_GROUPS.map(
            ({ group }) => new TypeGroup(group, byGroup.get(group) ?? [])
        );
        if (unknown.length) {
            groups.push(new TypeGroup('Other', unknown));
        }
        return groups;
    }
}

/**
 * A separate "Installed" view: units present in `list-unit-files` but not
 * currently loaded in `list-units`. Its content is fetched lazily — only when
 * the view is shown — so `list-unit-files` is not paid on every Units refresh.
 * Supports list/tree modes and its own name filter, independent of "Loaded".
 */
class InstalledUnitsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof TypeGroup) {
            return element.units;
        }
        if (element) {
            return [];
        }

        const installed = (await listInstalledNotLoaded())
            .filter((u) => !installedFilter || u.unit.toLowerCase().includes(installedFilter.toLowerCase()))
            .sort((a, b) => a.unit.localeCompare(b.unit));

        if (installedViewMode === 'list') {
            return installed;
        }

        // Tree: group by unit type, always showing every known category (even
        // empty) so the "New" action is available for any type. Unknown types
        // are collected into a trailing "Other" group (no "New" there).
        const byGroup = new Map<string, UnitItem[]>();
        const unknown: UnitItem[] = [];
        for (const u of installed) {
            const { group } = typeInfo(u.unit);
            if (group === 'Other') {
                unknown.push(u);
                continue;
            }
            if (!byGroup.has(group)) {
                byGroup.set(group, []);
            }
            byGroup.get(group)!.push(u);
        }
        const groups: TypeGroup[] = KNOWN_GROUPS.map(
            ({ group, type }) => new TypeGroup(group, byGroup.get(group) ?? [], type)
        );
        if (unknown.length) {
            groups.push(new TypeGroup('Other', unknown));
        }
        return groups;
    }
}

/** Extract a unit name from a command argument (a UnitItem or a string). */
export function unitFromArg(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg instanceof UnitItem) {
        return arg.unit;
    }
    if (arg && typeof arg === 'object' && 'unit' in arg) {
        return (arg as { unit: string }).unit;
    }
    return undefined;
}

/** Open the user's ~/.ssh/config in the editor (creating it if absent). */
async function editSshConfig(): Promise<void> {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(doc);
}

/** Show a host picker and switch the session host (not the config default). */
async function switchHost(refresh: () => void): Promise<void> {
    const current = host();
    const items: vscode.QuickPickItem[] = [
        { label: 'local', description: 'this machine', picked: current === '' },
        ...sshHostAliases().map((h) => ({
            label: h,
            description: 'ssh',
            picked: h === current,
        })),
        { kind: vscode.QuickPickItemKind.Separator, label: '' },
        { label: '$(settings-gear) Edit ~/.ssh/config', description: 'configure SSH hosts' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Current host: ${current || 'local'}`,
    });
    if (!pick) {
        return;
    }
    if (pick.label.includes('.ssh/config')) {
        await editSshConfig();
        return;
    }
    const selected = pick.label === 'local' ? '' : pick.label;
    setSessionHost(selected);
    refresh();
}

/** Show a scope picker and switch between system/user units (session only). */
async function switchScope(refresh: () => void): Promise<void> {
    const current = scope();
    const items: vscode.QuickPickItem[] = [
        { label: 'system', description: 'system units (default)', picked: current === 'system' },
        { label: 'user', description: 'user units (systemctl --user)', picked: current === 'user' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Current scope: ${current}`,
    });
    if (!pick) {
        return;
    }
    setSessionScope(pick.label === 'user' ? 'user' : 'system');
    refresh();
}

export function registerTree(context: vscode.ExtensionContext): { refreshAll: () => void } {
    const provider = new SystemdUnitsProvider();
    const target = new TargetProvider();
    const installed = new InstalledUnitsProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('systemd.units', provider),
        vscode.window.registerTreeDataProvider('systemd.target', target),
        vscode.window.registerTreeDataProvider('systemd.installed', installed),
    );

    const refreshAll = (): void => {
        provider.refresh();
        target.refresh();
        installed.refresh();
    };

    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
        vscode.commands.registerCommand(id, fn);

    const setMode = (mode: ViewMode): void => {
        viewMode = mode;
        void vscode.commands.executeCommand('setContext', 'systemd.units.treeMode', mode === 'tree');
        provider.refresh();
    };

    const setShowInactive = (value: boolean): void => {
        showInactive = value;
        void vscode.commands.executeCommand('setContext', 'systemd.units.showInactive', value);
        provider.refresh();
    };

    const setFilter = async (): Promise<void> => {
        const value = await vscode.window.showInputBox({
            prompt: 'Filter units by name',
            value: filter,
            placeHolder: 'e.g. sshd, timer, @',
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            return;
        }
        filter = value.trim().toLowerCase();
        void vscode.commands.executeCommand('setContext', 'systemd.units.hasFilter', filter !== '');
        provider.refresh();
    };

    const clearFilter = (): void => {
        filter = '';
        void vscode.commands.executeCommand('setContext', 'systemd.units.hasFilter', false);
        provider.refresh();
    };

    const setInstalledMode = (mode: ViewMode): void => {
        installedViewMode = mode;
        void vscode.commands.executeCommand('setContext', 'systemd.installed.treeMode', mode === 'tree');
        installed.refresh();
    };

    const setInstalledFilter = async (): Promise<void> => {
        const value = await vscode.window.showInputBox({
            prompt: 'Filter installed units by name',
            value: installedFilter,
            placeHolder: 'e.g. sshd, timer, @',
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            return;
        }
        installedFilter = value.trim().toLowerCase();
        void vscode.commands.executeCommand('setContext', 'systemd.installed.hasFilter', installedFilter !== '');
        installed.refresh();
    };

    const clearInstalledFilter = (): void => {
        installedFilter = '';
        void vscode.commands.executeCommand('setContext', 'systemd.installed.hasFilter', false);
        installed.refresh();
    };

    void vscode.commands.executeCommand('setContext', 'systemd.units.treeMode', true);
    void vscode.commands.executeCommand('setContext', 'systemd.units.showInactive', false);
    void vscode.commands.executeCommand('setContext', 'systemd.units.hasFilter', false);
    void vscode.commands.executeCommand('setContext', 'systemd.installed.treeMode', true);
    void vscode.commands.executeCommand('setContext', 'systemd.installed.hasFilter', false);

    context.subscriptions.push(
        reg('systemd.units.refresh', refreshAll),
        reg('systemd.units.showList', () => setMode('list')),
        reg('systemd.units.showTree', () => setMode('tree')),
        reg('systemd.units.hideInactive', () => setShowInactive(false)),
        reg('systemd.units.showInactive', () => setShowInactive(true)),
        reg('systemd.units.filter', () => void setFilter()),
        reg('systemd.units.clearFilter', clearFilter),
        reg('systemd.installed.showList', () => setInstalledMode('list')),
        reg('systemd.installed.showTree', () => setInstalledMode('tree')),
        reg('systemd.installed.filter', () => void setInstalledFilter()),
        reg('systemd.installed.clearFilter', clearInstalledFilter),
        reg('systemd.switchHost', () => switchHost(refreshAll)),
        reg('systemd.switchScope', () => switchScope(refreshAll)),
        reg('systemd.units.newUnit', (arg) => {
            if (arg instanceof TypeGroup && arg.unitType) {
                void newUnitFile(arg.unitType);
            }
        }),
        reg('systemd.units.status', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('status', unit, false);
            }
        }),
        reg('systemd.units.start', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('start', unit, true);
            }
        }),
        reg('systemd.units.stop', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('stop', unit, true);
            }
        }),
        reg('systemd.units.restart', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('restart', unit, true);
            }
        }),
        reg('systemd.units.enable', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('enable', unit, true);
            }
        }),
        reg('systemd.units.disable', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runSystemctl('disable', unit, true);
            }
        }),
        reg('systemd.units.logs', (arg) => {
            const unit = unitFromArg(arg);
            if (unit) {
                void runLogs(unit);
            }
        }),
    );

    return { refreshAll };
}
