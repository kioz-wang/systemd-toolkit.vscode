import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { systemctl, runOnTarget, buildCommand, onHostChanged, onScopeChanged, scope, homeDir, writeTempFile, runInTerminal, UnitScope } from './remote';
import { exec } from './process';

const UNIT_EXT = /\.(service|socket|timer|path|mount|swap|automount|target|slice|scope)$/;

/** Central directory holding the editable working copies (deleted on close). */
const TEMP_DIR = path.join(os.tmpdir(), 'systemd-toolkit');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const UNIT_SNIPPETS = require('../snippets/units.json') as Record<string, { prefix: string; body: string[] }>;

/** Return the snippet body (from snippets/units.json) for a unit type, or a generic skeleton. */
function unitSnippetBody(unitType: string): string[] {
    for (const s of Object.values(UNIT_SNIPPETS)) {
        if (s && s.prefix === unitType && Array.isArray(s.body)) {
            return s.body;
        }
    }
    const section = unitType.charAt(0).toUpperCase() + unitType.slice(1);
    return ['[Unit]', 'Description=', '', `[${section}]`, ''];
}

/** Snapshot content cache for the read-only "cat" view (scheme systemd-unit). */
const snapshotCache = new Map<string, string>();

/** Coalesces concurrent fetches of the same unit (dedupes preload + open). */
const inflight = new Map<string, Promise<string>>();

/** Tracks editable working copies: doc URI -> { unit, fragmentPath, scope }. */
const pendingEdits = new Map<string, { unit: string; fragmentPath: string; scope: UnitScope }>();

/** Fired after a deploy changes the state of units on the target (new/updated). */
const unitsChanged = new vscode.EventEmitter<void>();
export const onUnitsChanged = unitsChanged.event;

/**
 * Vendor-supplied unit paths should not be edited in place; writing an override
 * to /etc/systemd/system/ is the systemd-recommended way to customise them.
 */
function isVendorFragment(p: string): boolean {
    return p.startsWith('/usr/lib/systemd/') || p.startsWith('/lib/systemd/');
}

/** Whether a path exists on the target (local or remote). */
async function targetPathExists(p: string): Promise<boolean> {
    const r = await runOnTarget('test', ['-e', p]);
    return r.code === 0;
}

async function fetchSnapshot(unit: string, s: UnitScope): Promise<string> {
    const r = await systemctl(['cat', unit], false, s);
    return r.code === 0 ? r.stdout : `# Failed to read ${unit}:\n${r.stderr || r.stdout}`;
}

/** Cache key that includes the scope, so system and user units never collide. */
function snapshotKey(s: UnitScope, unit: string): string {
    return `${s}:${unit}`;
}

/**
 * Return the snapshot content for a unit, caching it. Concurrent requests for
 * the same unit (and scope) share one fetch, so a preload racing with a
 * Ctrl+Click does not duplicate the `systemctl cat` round-trip.
 */
export function ensureSnapshot(unit: string, scopeOverride?: UnitScope): Promise<string> {
    const s = scopeOverride ?? scope();
    const key = snapshotKey(s, unit);
    const cached = snapshotCache.get(key);
    if (cached !== undefined) {
        return Promise.resolve(cached);
    }
    let p = inflight.get(key);
    if (!p) {
        p = fetchSnapshot(unit, s).then((content) => {
            snapshotCache.set(key, content);
            return content;
        });
        inflight.set(key, p);
        void p.finally(() => inflight.delete(key));
    }
    return p;
}

/**
 * Preload snapshot content for a set of units in the background. Used to warm
 * the cache with the direct dependencies of the current document so that
 * Ctrl+Click on a dependency value opens instantly instead of showing "Loading".
 */
export function preloadSnapshots(units: string[], scopeOverride?: UnitScope): void {
    for (const unit of units) {
        if (!snapshotCache.has(snapshotKey(scopeOverride ?? scope(), unit))) {
            void ensureSnapshot(unit, scopeOverride);
        }
    }
}

class UnitSnapshotProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        const { unit, scope: s } = unitFromSnapshotUri(uri);
        const cached = snapshotCache.get(snapshotKey(s, unit));
        if (cached !== undefined) {
            return cached;
        }
        // Lazily load on first open (e.g. via Ctrl+Click on a dependency value),
        // then update the document once the content arrives.
        void this.load(unit, uri, s);
        return `# Loading ${unit}…`;
    }

    private async load(unit: string, uri: vscode.Uri, s: UnitScope): Promise<void> {
        await ensureSnapshot(unit, s);
        this._onDidChange.fire(uri);
    }
}

/** URI of the read-only snapshot document for a unit (scope-encoded). */
export function snapshotUri(unit: string, scopeOverride?: UnitScope): vscode.Uri {
    const s = scopeOverride ?? scope();
    return vscode.Uri.parse(`systemd-unit:/${s}/${unit}`);
}

function unitFromSnapshotUri(uri: vscode.Uri): { unit: string; scope: UnitScope } {
    const parts = uri.path.replace(/^\//, '').split('/');
    const s = parts[0] === 'user' ? 'user' : 'system';
    const unit = parts.slice(1).join('/');
    return { unit, scope: s };
}

export function registerUnitFile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('systemd-unit', new UnitSnapshotProvider())
    );

    // Delete the working copy when its tab is closed (see editUnitFile).
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (!pendingEdits.has(doc.uri.toString())) {
                return;
            }
            pendingEdits.delete(doc.uri.toString());
            try {
                fs.unlinkSync(doc.uri.fsPath);
            } catch {
                /* already removed */
            }
        })
    );

    // Snapshot content is host/scope-specific: drop it when either changes.
    context.subscriptions.push(
        onHostChanged(() => snapshotCache.clear()),
        onScopeChanged(() => snapshotCache.clear()),
    );

    const reg = (id: string, fn: (...args: any[]) => unknown) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        reg('systemd.units.viewFile', async (arg, scopeArg: UnitScope | undefined) => {
            const unit = unitName(arg);
            if (unit) {
                await viewUnitFile(unit, scopeArg);
            }
        }),
        reg('systemd.units.editFile', async (arg, scopeArg: UnitScope | undefined) => {
            const unit = unitName(arg);
            if (unit) {
                await editUnitFile(unit, scopeArg);
            }
        }),
        reg('systemd.deploy', () => deployCurrentFile()),
    );
}

function unitName(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg && typeof arg === 'object' && 'unit' in arg) {
        return (arg as { unit: string }).unit;
    }
    return undefined;
}

/**
 * Resolve the unit associated with a document, for a temp edit document.
 * Returns { unit, fragmentPath } for temp edits, or undefined for other docs.
 */
export function unitForTempDocument(document: vscode.TextDocument): { unit: string; fragmentPath: string; scope: UnitScope } | undefined {
    return pendingEdits.get(document.uri.toString());
}

/** Whether the document is a read-only unit preview (systemd-unit: scheme). */
export function isSnapshotDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'systemd-unit';
}

/** The unit name a document represents (temp edit, snapshot, or by filename). */
export function unitForDocument(document: vscode.TextDocument): string | undefined {
    const temp = unitForTempDocument(document);
    if (temp) {
        return temp.unit;
    }
    if (isSnapshotDocument(document)) {
        return unitFromSnapshotUri(document.uri).unit;
    }
    // Only resolve real files by their extension. Virtual documents such as the
    // live-log view (scheme systemd-log) are not unit files, even though their
    // URI may end in `.service`.
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
        return undefined;
    }
    const base = path.basename(document.fileName);
    return UNIT_EXT.test(base) ? base : undefined;
}

/** Paths that unambiguously identify a *user* unit fragment. */
const USER_UNIT_PATH = /\/(systemd\/user|\.config\/systemd\/user|\.local\/share\/systemd\/user)\//;

/** Infer a scope from a unit fragment path, or undefined when ambiguous. */
export function scopeFromPath(p: string): UnitScope | undefined {
    if (USER_UNIT_PATH.test(p)) {
        return 'user';
    }
    if (/\/systemd\/system\//.test(p)) {
        return 'system';
    }
    return undefined;
}

/**
 * The scope a document belongs to: temp edits carry the scope they were opened
 * with; snapshots carry the scope encoded in their URI; plain files infer from
 * their path (falling back to the session scope when the path is ambiguous).
 */
export function documentScope(document: vscode.TextDocument): UnitScope {
    const temp = unitForTempDocument(document);
    if (temp) {
        return temp.scope;
    }
    if (isSnapshotDocument(document)) {
        return unitFromSnapshotUri(document.uri).scope;
    }
    return scopeFromPath(document.fileName) ?? scope();
}

/** Show a read-only snapshot of the unit via `systemctl cat`. */
export async function viewUnitFile(unit: string, scopeOverride?: UnitScope): Promise<void> {
    const s = scopeOverride ?? scope();
    const result = await systemctl(['cat', unit], false, s);
    if (result.code !== 0) {
        void vscode.window.showErrorMessage(
            `systemd: failed to read ${unit}: ${result.stderr || result.stdout}`
        );
        return;
    }
    snapshotCache.set(snapshotKey(s, unit), result.stdout);
    await vscode.window.showTextDocument(snapshotUri(unit, s), { preview: true });
}

/** Path of the on-disk working copy for a unit (same basename, under TEMP_DIR). */
function workingCopyPath(unit: string): string {
    const safe = unit.replace(/[^A-Za-z0-9.@_+-]/g, '_');
    return path.join(TEMP_DIR, safe);
}

/**
 * Close the editor tab (if any) showing the given URI. Used to reuse the
 * read-only preview tab when switching to the editable working copy.
 */
function closeTab(uri: vscode.Uri): void {
    const target = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { uri?: vscode.Uri };
            if (input && input.uri && input.uri.toString() === target) {
                void vscode.window.tabGroups.close(tab);
                return;
            }
        }
    }
}

/**
 * Open the unit's fragment file in an editable working copy. The copy is a real
 * file under TEMP_DIR sharing the unit's name (so `.service` etc. keep the
 * language features active) and is deleted when its tab is closed.
 * When invoked from a read-only preview (CodeLens "Edit"), the preview tab is
 * reused: the working copy opens in the same column and the preview is closed.
 */
export async function editUnitFile(unit: string, scopeOverride?: UnitScope): Promise<void> {
    const s = scopeOverride ?? scope();
    const active = vscode.window.activeTextEditor;
    const snapshotToClose = active && isSnapshotDocument(active.document) ? active.document.uri : undefined;
    const column = active?.viewColumn;

    const show = await systemctl(['show', '-p', 'FragmentPath', '--value', unit], false, s);
    const fragmentPath = show.stdout.trim();
    if (show.code !== 0 || !fragmentPath) {
        void vscode.window.showErrorMessage(
            `systemd: cannot resolve the fragment path for ${unit}: ${show.stderr || show.stdout || 'unknown'}`
        );
        return;
    }

    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const filePath = workingCopyPath(unit);

    // Already open for this unit: just focus it, preserving unsaved edits.
    const existing = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
    if (existing) {
        pendingEdits.set(existing.uri.toString(), { unit, fragmentPath, scope: s });
        await vscode.window.showTextDocument(existing, { preview: false, viewColumn: column });
        if (snapshotToClose) {
            closeTab(snapshotToClose);
        }
        return;
    }

    const read = await runOnTarget('cat', [fragmentPath]);
    if (read.code !== 0) {
        void vscode.window.showErrorMessage(
            `systemd: failed to read ${fragmentPath}: ${read.stderr || read.stdout}`
        );
        return;
    }

    fs.writeFileSync(filePath, read.stdout);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    pendingEdits.set(doc.uri.toString(), { unit, fragmentPath, scope: s });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: column });
    if (snapshotToClose) {
        closeTab(snapshotToClose);
    }
}

/**
 * Create a new unit of the given type. Prompts for the name (the `.type`
 * suffix is appended automatically), creates an empty working copy under
 * TEMP_DIR, tracks it as a pending edit (so deploy targets the scope's unit
 * dir), opens it, and inserts the unit's snippet for tab-through completion.
 */
export async function newUnitFile(unitType: string): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: `New ${unitType} unit name (without ".${unitType}")`,
        placeHolder: 'my-unit',
        ignoreFocusOut: true,
        validateInput: (v) => {
            const t = v.trim();
            if (!t) {
                return 'A name is required';
            }
            if (!/^[\w@.-]+$/.test(t)) {
                return 'Only letters, digits, ".", "-", "_", "@" are allowed';
            }
            return undefined;
        },
    });
    if (name === undefined) {
        return;
    }
    const unit = `${name.trim()}.${unitType}`;

    const s = scope();
    const targetPath = await unitTargetDir(unit, s);
    if (!targetPath) {
        void vscode.window.showErrorMessage(
            `systemd: cannot resolve the target directory for ${unit} (home directory unavailable).`
        );
        return;
    }

    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const filePath = workingCopyPath(unit);

    // Already open for this unit: just focus it.
    const existing = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
    if (existing) {
        pendingEdits.set(existing.uri.toString(), { unit, fragmentPath: targetPath, scope: s });
        await vscode.window.showTextDocument(existing, { preview: false });
        return;
    }

    fs.writeFileSync(filePath, '');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    pendingEdits.set(doc.uri.toString(), { unit, fragmentPath: targetPath, scope: s });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const body = unitSnippetBody(unitType);
    if (body.length) {
        await editor.insertSnippet(new vscode.SnippetString(body.join('\n')));
    }
}

/**
 * Directory that a unit should be written to for a given scope:
 * system → /etc/systemd/system/, user → ~/.config/systemd/user/. Resolves the
 * target user's home for user scope (needed to avoid `~` shell expansion).
 */
async function unitTargetDir(unit: string, s: UnitScope): Promise<string | undefined> {
    if (s === 'user') {
        const home = await homeDir();
        if (!home) {
            return undefined;
        }
        return `${home}/.config/systemd/user/${unit}`;
    }
    return `/etc/systemd/system/${unit}`;
}

/**
 * Deploy the active document.
 *   - a temp edit (from "Edit Unit File") writes back to its FragmentPath;
 *   - a plain unit file (`.service`, …) is deployed to the scope's unit dir
 *     (/etc/systemd/system/ or ~/.config/systemd/user/);
 * after a successful write, runs `systemctl daemon-reload` (honouring scope).
 * On any failure (missing auth, read-only filesystem, …) it reports the error
 * and refuses rather than silently failing.
 */
export async function deployCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showWarningMessage('systemd: no active editor to deploy.');
        return;
    }

    const doc = editor.document;
    const docScope = documentScope(doc);
    const temp = unitForTempDocument(doc);
    let unit: string;
    let targetPath: string | undefined;
    let overwritingExisting = false;
    if (temp) {
        unit = temp.unit;
        // Write back to the unit's fragment path, unless it is a vendor file
        // (/usr/lib/systemd/… or /lib/systemd/…), in which case an override is
        // written to the scope's unit dir instead of mutating the vendor file.
        targetPath = isVendorFragment(temp.fragmentPath)
            ? await unitTargetDir(unit, docScope)
            : temp.fragmentPath;
    } else {
        const base = path.basename(doc.fileName);
        if (!UNIT_EXT.test(base)) {
            void vscode.window.showWarningMessage(
                'systemd: the active file is not a systemd unit file (.service/.socket/.timer/...).'
            );
            return;
        }
        unit = base;
        targetPath = await unitTargetDir(unit, docScope);
        // Deploying a fresh file that would clobber an existing unit on the
        // target is destructive; confirm first.
        if (targetPath && await targetPathExists(targetPath)) {
            overwritingExisting = true;
        }
    }

    if (!targetPath) {
        void vscode.window.showErrorMessage(
            `systemd: cannot resolve the target directory for user unit ${unit} (home directory unavailable).`
        );
        return;
    }

    if (overwritingExisting) {
        const choice = await vscode.window.showWarningMessage(
            `systemd: ${targetPath} already exists on the target. Overwrite it?`,
            { modal: true },
            'Overwrite'
        );
        if (choice !== 'Overwrite') {
            return;
        }
    }

    const content = doc.getText();

    // sudo/pkexec need interactive authentication, which cannot be done
    // silently via exec(stdin) (sudo needs a TTY; pkexec needs a polkit agent
    // session). Stage the file to a temp path (no elevation), then run the
    // install + daemon-reload in an integrated terminal and clean the temp
    // file up afterwards. `none` (no elevation) and user scope keep the quiet
    // exec path below.
    const auth = (vscode.workspace.getConfiguration('systemd-toolkit').get<string>('authMethod', 'sudo') || 'sudo').trim();
    if (docScope === 'system' && (auth === 'sudo' || auth === 'pkexec')) {
        const tmpPath = await writeTempFile(unit, content);
        if (!tmpPath) {
            void vscode.window.showErrorMessage(
                `systemd: failed to stage ${unit} to a temporary file on the target.`
            );
            return;
        }
        const shell = `${auth} install -m 644 '${tmpPath}' '${targetPath}' && ${auth} systemctl daemon-reload; rm -f '${tmpPath}'`;
        runInTerminal(shell);
        void vscode.window.showInformationMessage(
            `systemd: deploying ${unit} to ${targetPath} in the terminal — authenticate there.`
        );
        return;
    }

    const writeBuilt = buildCommand('tee', [targetPath], true, docScope);
    const write = await exec(writeBuilt.cmd, writeBuilt.args, content);
    if (write.code !== 0) {
        const reason = write.stderr || write.stdout || 'unknown error';
        void vscode.window.showErrorMessage(
            `systemd: deploy of ${unit} to ${targetPath} failed: ${reason.trim()}`
        );
        return;
    }

    // The file is in place; reload the daemon so systemd picks it up.
    const reload = await systemctl(['daemon-reload'], true, docScope);
    if (reload.code !== 0) {
        const reason = reload.stderr || reload.stdout || 'unknown error';
        void vscode.window.showWarningMessage(
            `systemd: ${unit} written to ${targetPath}, but daemon-reload failed: ${reason.trim()}`
        );
        return;
    }

    // Keep the working copy registered so re-deploys still target its
    // FragmentPath; it is cleaned up when the tab is closed.
    unitsChanged.fire();
    void vscode.window.showInformationMessage(
        `systemd: ${unit} deployed to ${targetPath} and daemon-reloaded.`
    );
}
