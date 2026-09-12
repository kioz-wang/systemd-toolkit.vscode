import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from './process';
import { buildCommand, elevationEnabled, BuiltCommand, systemctlArgs, scope, UnitScope } from './remote';
import { showLogs } from './logs';

const UNIT_EXT = /\.(service|socket|timer|path|mount|swap|automount|target|slice|scope)$/;

let outputChannel: vscode.OutputChannel | undefined;

export function channel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('systemd');
    }
    return outputChannel;
}

/** Infer a unit name from the active editor, or prompt the user. */
export async function resolveUnit(): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const base = path.basename(editor.document.fileName);
        if (UNIT_EXT.test(base)) {
            return base;
        }
    }
    return vscode.window.showInputBox({
        prompt: 'Unit name (e.g. sshd.service)',
        placeHolder: 'sshd.service',
        ignoreFocusOut: true,
    });
}

interface RunOptions {
    /** Always run in an integrated terminal (needed for interactive auth). */
    forceTerminal?: boolean;
}

/** Run a built command, showing output in a terminal or the output channel. */
export async function run(built: BuiltCommand, opts: RunOptions = {}): Promise<void> {
    const config = vscode.workspace.getConfiguration('systemd');
    const useTerminal = config.get<boolean>('runInTerminal', false) || opts.forceTerminal === true;

    if (useTerminal) {
        const terminal = vscode.window.createTerminal({
            name: 'systemd',
            shellPath: built.cmd,
            shellArgs: built.args,
        });
        terminal.show();
        return;
    }

    const ch = channel();
    ch.appendLine(`$ ${built.display}`);
    const result = await exec(built.cmd, built.args);
    if (result.stdout) {
        ch.append(result.stdout.replace(/\s+$/, ''));
    }
    if (result.stderr) {
        ch.append(result.stderr.replace(/\s+$/, ''));
    }
    if (result.code !== 0 && /access denied|interactive authentication/i.test(result.stderr + result.stdout)) {
        ch.appendLine('');
        ch.appendLine(
            'Hint: this command requires elevated privileges. ' +
            'Set "systemd.authMethod" to "sudo" or "pkexec" (default "sudo"), ' +
            'or run it in a terminal.'
        );
    }
    ch.appendLine('');
    ch.show(true);
}

/** Run a systemctl action against a specific unit (or without one). */
export async function runSystemctl(
    action: string,
    unit: string | undefined,
    privileged: boolean,
    scopeOverride?: UnitScope
): Promise<void> {
    const bin = vscode.workspace.getConfiguration('systemd').get<string>('systemctlPath', 'systemctl');
    const args = unit ? [action, unit] : [action];
    const built = buildCommand(bin, systemctlArgs(args, scopeOverride), privileged, scopeOverride);
    // Elevation (and thus the terminal for interactive auth) only applies to
    // system scope; user scope never elevates.
    const forceTerminal = privileged && (scopeOverride ?? scope()) === 'system' && elevationEnabled();
    await run(built, { forceTerminal });
}

/** Show live, continuously-refreshing logs for a unit in a read-only editor tab. */
export async function runLogs(unit: string, scopeOverride?: UnitScope): Promise<void> {
    await showLogs(unit, scopeOverride);
}

/** Extract a unit name from a command argument (a string or a unit item). */
function argUnit(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg && typeof arg === 'object' && 'unit' in arg) {
        return (arg as { unit: string }).unit;
    }
    return undefined;
}

export function registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...a: any[]) => unknown) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        reg('systemd.status', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('status', argUnit(arg) ?? (await resolveUnit()), false, scopeArg)),
        reg('systemd.start', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('start', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.stop', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('stop', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.restart', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('restart', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.reload', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('reload', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.enable', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('enable', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.disable', async (arg, scopeArg: UnitScope | undefined) => runSystemctl('disable', argUnit(arg) ?? (await resolveUnit()), true, scopeArg)),
        reg('systemd.daemonReload', () => runSystemctl('daemon-reload', undefined, true)),
        reg('systemd.logs', async (arg, scopeArg: UnitScope | undefined) => {
            const unit = argUnit(arg) ?? (await resolveUnit());
            if (unit) {
                await runLogs(unit, scopeArg);
            }
        }),
    );
}
