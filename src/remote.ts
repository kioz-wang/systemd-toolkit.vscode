import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec, ExecResult } from './process';
import { command, error } from './logger';

const hostChanged = new vscode.EventEmitter<void>();
const scopeChanged = new vscode.EventEmitter<void>();

/** Fired when the session host is switched (not when config changes). */
export const onHostChanged = hostChanged.event;

/** Fired when the unit scope (system/user) is switched. */
export const onScopeChanged = scopeChanged.event;

/** Session-level host override; undefined = use the configured default. */
let sessionHost: string | undefined;

/** Session-level scope override; undefined = use the configured default. */
let sessionScope: UnitScope | undefined;

/** SSH host (alias from ~/.ssh/config) to operate on; empty string = local. */
export function host(): string {
    const configured = (vscode.workspace.getConfiguration('systemd').get<string>('host', '') || '').trim();
    return sessionHost !== undefined ? sessionHost : configured;
}

/** Set the session host without touching the configured default. */
export function setSessionHost(host: string): void {
    sessionHost = host.trim();
    deployedCache = undefined; // unit list is host-specific
    homeCache = undefined;
    hostChanged.fire();
}

/** The two systemd manager modes the extension operates against. */
export type UnitScope = 'system' | 'user';

/** The active unit scope: 'system' (default) or 'user'. */
export function scope(): UnitScope {
    const configured = (vscode.workspace.getConfiguration('systemd').get<string>('scope', 'system') || '').trim();
    const value = sessionScope !== undefined ? sessionScope : configured;
    return value === 'user' ? 'user' : 'system';
}

/** Set the session scope without touching the configured default. */
export function setSessionScope(value: UnitScope): void {
    sessionScope = value;
    deployedCache = undefined; // unit list is scope-specific
    homeCache = undefined;
    scopeChanged.fire();
}

export function isRemote(): boolean {
    return host() !== '';
}

/** Elevation prefix (sudo/pkexec) for system scope; empty for user scope or none. */
function elevationPrefix(scopeOverride?: UnitScope): string[] {
    if ((scopeOverride ?? scope()) !== 'system') {
        return [];
    }
    const auth = (vscode.workspace.getConfiguration('systemd').get<string>('authMethod', 'sudo') || '').trim();
    return auth !== 'none' && auth !== '' ? [auth] : [];
}

/**
 * SSH ControlMaster options so repeated commands to the same host reuse one
 * connection instead of paying the full handshake + auth on every call. This is
 * the main latency source for remote hosts; the master connection is kept alive
 * for CONTROL_PERSIST seconds after the last command.
 */
const CONTROL_PERSIST = 60;

function sshControlOptions(h: string): string[] {
    const dir = path.join(os.tmpdir(), 'systemd-toolkit-ssh');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        return []; // no multiplexing if the socket dir can't be created
    }
    const safe = h.replace(/[^A-Za-z0-9._@-]/g, '_');
    return [
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${path.join(dir, `ctl-${safe}`)}`,
        '-o', `ControlPersist=${CONTROL_PERSIST}`,
    ];
}

export interface BuiltCommand {
    /** Program to spawn (or use as terminal shellPath). */
    cmd: string;
    /** Arguments to the program. */
    args: string[];
    /** Human-readable command line for logs. */
    display: string;
}

/**
 * Build the argv for a command, wrapping it with an optional elevation prefix
 * (sudo/pkexec) and then with `ssh <host>` (ControlMaster, no TTY) when a
 * remote host is configured. Used for non-interactive exec calls.
 *
 * User-scope units live in the user's own home and are managed through the
 * user's systemd instance, so they must never be elevated (sudo would switch
 * to root's user instance); elevation is therefore suppressed for user scope.
 */
export function buildCommand(base: string, args: string[], elevate = false, scopeOverride?: UnitScope): BuiltCommand {
    let argv = [base, ...args];
    if (elevate) {
        argv = [...elevationPrefix(scopeOverride), ...argv];
    }
    const h = host();
    if (h) {
        argv = [sshBin(), ...sshControlOptions(h), h, ...argv];
    }
    return { cmd: argv[0], args: argv.slice(1), display: argv.join(' ') };
}

/**
 * Build the local shell command line (elevation prefix + args, no ssh wrap)
 * for terminal execution. `runInTerminal` adds the remote ssh wrapper itself.
 */
export function shellCommand(base: string, args: string[], elevate = false, scopeOverride?: UnitScope): string {
    let argv = [base, ...args];
    if (elevate) {
        argv = [...elevationPrefix(scopeOverride), ...argv];
    }
    return argv.join(' ');
}

/** systemctl args with `--user` prepended when in user scope. */
export function systemctlArgs(args: string[], scopeOverride?: UnitScope): string[] {
    return (scopeOverride ?? scope()) === 'user' && args[0] !== '--version' ? ['--user', ...args] : args;
}

/** journalctl args with `--user` prepended when in user scope. */
export function journalctlArgs(args: string[], scopeOverride?: UnitScope): string[] {
    return (scopeOverride ?? scope()) === 'user' ? ['--user', ...args] : args;
}

/** Run a systemctl command on the target, honouring the given/active scope. */
export function systemctl(args: string[], elevate = false, scopeOverride?: UnitScope): Promise<ExecResult> {
    const bin = vscode.workspace.getConfiguration('systemd').get<string>('systemctlPath', 'systemctl');
    const built = buildCommand(bin, systemctlArgs(args, scopeOverride), elevate, scopeOverride);
    return exec(built.cmd, built.args);
}

/** Run a journalctl command on the target, honouring the given/active scope. */
export function journalctl(args: string[], elevate = false, scopeOverride?: UnitScope): Promise<ExecResult> {
    const bin = vscode.workspace.getConfiguration('systemd').get<string>('journalctlPath', 'journalctl');
    const built = buildCommand(bin, journalctlArgs(args, scopeOverride), elevate, scopeOverride);
    return exec(built.cmd, built.args);
}

/** Run an arbitrary command on the target, optionally with stdin input. */
export function runOnTarget(base: string, args: string[], input?: string): Promise<ExecResult> {
    const built = buildCommand(base, args, false);
    return exec(built.cmd, built.args, input);
}

/**
 * Stage file content to a temporary path on the target, without elevation.
 * Returns the target-side temp path, or undefined on failure.
 */
export async function writeTempFile(unit: string, content: string): Promise<string | undefined> {
    const safe = unit.replace(/[^A-Za-z0-9.@_+-]/g, '_');
    const h = host();
    if (h) {
        const tmpPath = `/tmp/systemd-toolkit-${safe}`;
        const r = await runOnTarget('tee', [tmpPath], content);
        return r.code === 0 ? tmpPath : undefined;
    }
    const tmpPath = path.join(os.tmpdir(), `systemd-toolkit-${safe}`);
    try {
        fs.writeFileSync(tmpPath, content);
        return tmpPath;
    } catch {
        return undefined;
    }
}

/**
 * Reuse a single "systemd" terminal for every command execution, so running a
 * command (from CodeLens, the panel, or a deploy) never opens a new tab. The
 * terminal is the user's default interactive shell, which stays open after a
 * command finishes (output remains visible; press Enter to continue).
 */
function systemdTerminal(): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === 'systemd');
    return existing ?? vscode.window.createTerminal({ name: 'systemd' });
}

/**
 * Run a shell command on the target in the shared "systemd" terminal. Remote
 * hosts are wrapped in `ssh -t` (a fresh connection, no ControlMaster) so a
 * remote sudo/pkexec still gets a TTY. Shell integration is used when
 * available so the command line is not echoed twice.
 */
export function runInTerminal(shell: string): void {
    const h = host();
    const line = h ? `${sshBin()} -t ${h} "${shell}"` : shell;
    command(line);
    const terminal = systemdTerminal();
    terminal.show();
    executeInTerminal(terminal, line);
}

/**
 * Execute a command line in a terminal without double-echoing it. Shell
 * integration (`executeCommand`) renders the command once as a decoration;
 * `sendText` would show it twice. Shell integration activates asynchronously
 * after a terminal starts, so wait for it briefly; if it never arrives, the
 * command is dropped and an error is logged.
 */
function executeInTerminal(terminal: vscode.Terminal, commandLine: string): void {
    if (terminal.shellIntegration) {
        terminal.shellIntegration.executeCommand(commandLine);
        return;
    }
    let done = false;
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal && !done) {
            done = true;
            sub.dispose();
            e.shellIntegration.executeCommand(commandLine);
        }
    });
    setTimeout(() => {
        if (done) {
            return;
        }
        done = true;
        sub.dispose();
        if (!terminal.shellIntegration) {
            error(`shell integration unavailable — command not run: ${commandLine}`);
        }
    }, 2000);
}

/** Path to the ssh binary, from configuration. */
function sshBin(): string {
    return (vscode.workspace.getConfiguration('systemd').get<string>('sshPath', 'ssh') || 'ssh').trim();
}

let homeCache: string | undefined;

/** Home directory of the target user (local or remote), used for user units. */
export async function homeDir(): Promise<string | undefined> {
    if (homeCache !== undefined) {
        return homeCache;
    }
    // `sh -c 'echo $HOME'` resolves the target user's home on either host;
    // $HOME is expanded by the remote shell, not by us.
    const r = await runOnTarget('sh', ['-c', 'echo $HOME']);
    const home = r.code === 0 ? r.stdout.trim() : '';
    homeCache = home || undefined;
    return homeCache;
}

let deployedCache: { scope: UnitScope; set: Set<string>; time: number } | undefined;
const DEPLOYED_TTL = 30_000;

/** Return the set of installed unit names (from list-unit-files), cached per scope. */
export async function deployedUnits(scopeOverride?: UnitScope): Promise<Set<string>> {
    const s = scopeOverride ?? scope();
    if (deployedCache && deployedCache.scope === s && Date.now() - deployedCache.time < DEPLOYED_TTL) {
        return deployedCache.set;
    }
    const r = await systemctl(['list-unit-files', '--all', '--no-legend', '--no-pager'], false, scopeOverride);
    const set = new Set<string>();
    for (const line of r.stdout.split('\n')) {
        const m = /^(\S+)\s/.exec(line.trim());
        if (m) {
            set.add(m[1]);
        }
    }
    deployedCache = { scope: s, set, time: Date.now() };
    return set;
}

/**
 * Whether a unit is deployed (installed). Template instances such as
 * `foo@bar.service` resolve to their template `foo@.service`.
 */
export async function isUnitDeployed(unit: string, scopeOverride?: UnitScope): Promise<boolean> {
    const set = await deployedUnits(scopeOverride);
    if (set.has(unit)) {
        return true;
    }
    const at = unit.indexOf('@');
    if (at > 0) {
        const template = unit.replace(/@[^.]*/, '@');
        if (set.has(template)) {
            return true;
        }
    }
    return false;
}
