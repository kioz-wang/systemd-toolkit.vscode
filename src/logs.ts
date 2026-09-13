import * as vscode from 'vscode';
import * as cp from 'child_process';
import { buildCommand, journalctlArgs, scope, UnitScope } from './remote';
import { command, error } from './logger';

/** Virtual scheme for the read-only, continuously-refreshing log view. */
const LOG_SCHEME = 'systemd-log';

/** Cap the buffered output so a verbose unit cannot grow the document forever. */
const MAX_CHARS = 256 * 1024;

/** Throttle editor refreshes: at most one update per this many milliseconds. */
const REFRESH_MS = 500;

interface LogSession {
    unit: string;
    proc: cp.ChildProcess;
    /** Flushed output currently shown in the document. */
    text: string;
    /** Output received since the last flush (not yet shown). */
    pending: string;
    timer?: NodeJS.Timeout;
}

function logUri(unit: string): vscode.Uri {
    return vscode.Uri.parse(`${LOG_SCHEME}:/${unit}`);
}

function unitFromLogUri(uri: vscode.Uri): string {
    return uri.path.replace(/^\//, '');
}

/** The scope each log view was requested with (set by showLogs, read by start). */
const logScopes = new Map<string, UnitScope>();

class LogContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;
    private sessions = new Map<string, LogSession>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        const unit = unitFromLogUri(uri);
        let session = this.sessions.get(unit);
        if (!session) {
            session = this.spawn(unit, uri);
            this.sessions.set(unit, session);
        }
        return this.render(session);
    }

    private render(session: LogSession): string {
        // When journalctl has produced nothing yet (e.g. the unit has no logs),
        // show a waiting hint instead of leaving the view empty/opening forever.
        const body = session.text.length > 0 ? session.text : '# Waiting for log output…\n';
        return `# Live logs: ${session.unit}  (journalctl -u ${session.unit} --follow)\n${body}`;
    }

    private spawn(unit: string, uri: vscode.Uri): LogSession {
        const bin = vscode.workspace
            .getConfiguration('systemd')
            .get<string>('journalctlPath', 'journalctl');
        // Show the last 300 lines, then follow new entries (also over ssh),
        // honouring the scope the log was requested with.
        const s = logScopes.get(unit) ?? scope();
        const built = buildCommand(
            bin,
            journalctlArgs(['-u', unit, '--follow', '--no-pager', '-n', '300'], s),
            false,
            s
        );
        const proc = cp.spawn(built.cmd, built.args, { shell: false });
        command(built.display);
        const session: LogSession = { unit, proc, text: '', pending: '' };
        proc.stdout.on('data', (d: Buffer) => this.onData(session, uri, d.toString()));
        proc.stderr.on('data', (d: Buffer) => this.onData(session, uri, d.toString()));
        proc.on('error', (e) => {
            const message = String(e);
            error(`$ ${built.display}  →  ${message}`);
            this.onData(session, uri, message + '\n');
        });
        return session;
    }

    private onData(session: LogSession, uri: vscode.Uri, chunk: string): void {
        session.pending += chunk;
        if (!session.timer) {
            session.timer = setTimeout(() => this.flush(session, uri), REFRESH_MS);
        }
    }

    private flush(session: LogSession, uri: vscode.Uri): void {
        session.timer = undefined;
        if (!session.pending) {
            return;
        }
        session.text += session.pending;
        session.pending = '';
        if (session.text.length > MAX_CHARS) {
            session.text = session.text.slice(session.text.length - MAX_CHARS);
            // Drop the (now partial) first line so the view stays line-aligned.
            const nl = session.text.indexOf('\n');
            if (nl > 0) {
                session.text = session.text.slice(nl + 1);
            }
        }
        this._onDidChange.fire(uri);
    }

    /** Stop and forget the streaming session for a unit (e.g. its tab closed). */
    stop(unit: string): void {
        const session = this.sessions.get(unit);
        if (!session) {
            return;
        }
        this.sessions.delete(unit);
        if (session.timer) {
            clearTimeout(session.timer);
        }
        try {
            session.proc.kill();
        } catch {
            /* already exited */
        }
    }

    stopAll(): void {
        for (const unit of [...this.sessions.keys()]) {
            this.stop(unit);
        }
    }
}

export function registerLogs(context: vscode.ExtensionContext): void {
    const provider = new LogContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, provider),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.scheme === LOG_SCHEME) {
                provider.stop(unitFromLogUri(doc.uri));
            }
        }),
        { dispose: () => provider.stopAll() },
    );
}

/** Open (or reveal) the continuously-refreshing log document for a unit. */
export async function showLogs(unit: string, scopeOverride?: UnitScope): Promise<void> {
    logScopes.set(unit, scopeOverride ?? scope());
    const doc = await vscode.workspace.openTextDocument(logUri(unit));
    await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
    });
}
