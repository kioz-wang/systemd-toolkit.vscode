import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** The extension's log channel (appears as "systemd Toolkit" in the Output panel). */
export function logChannel(): vscode.LogOutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('systemd Toolkit', { log: true });
    }
    return channel;
}

export function info(message: string): void {
    logChannel().info(message);
}

export function warn(message: string): void {
    logChannel().warn(message);
}

export function error(message: string): void {
    logChannel().error(message);
}

export function debug(message: string): void {
    logChannel().debug(message);
}

/** Record a command about to be executed (its full command line). */
export function command(cmdLine: string): void {
    logChannel().info(`$ ${cmdLine}`);
}

/** Record a command that exited with a non-zero status. */
export function commandError(cmdLine: string, code: number, detail: string): void {
    const first = detail.trim().split('\n')[0].slice(0, 200);
    logChannel().error(`$ ${cmdLine}  →  exit ${code}${first ? `: ${first}` : ''}`);
}
