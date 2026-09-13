import * as vscode from 'vscode';
import * as cp from 'child_process';
import { buildCommand, journalctlArgs, host, scope, UnitScope } from './remote';
import { command, error } from './logger';

/** Virtual scheme for the read-only, continuously-refreshing log view. */
const LOG_SCHEME = 'systemd-log';

/** Cap the buffered output so a verbose unit cannot grow the document forever. */
const MAX_CHARS = 256 * 1024;

/** Throttle editor refreshes: at most one update per this many milliseconds. */
const REFRESH_MS = 500;

interface LogSession {
    unit: string;
    host: string;
    scope: UnitScope;
    proc: cp.ChildProcess;
    /** Flushed output currently shown in the document. */
    text: string;
    /** Output received since the last flush (not yet shown). */
    pending: string;
    timer?: NodeJS.Timeout;
}

/** Host + scope the log view was requested with (both encoded in the URI). */
interface LogTarget {
    unit: string;
    host: string;
    scope: UnitScope;
}

function logUri(target: LogTarget): vscode.Uri {
    // Host + scope + unit live in the path, not the query string: query strings
    // on custom-scheme URIs can break `onDidChange` re-read matching (which is
    // what drives live refresh) in VS Code. The `.log` suffix selects the
    // built-in `log` language for highlighting.
    const h = target.host || 'local';
    return vscode.Uri.parse(`${LOG_SCHEME}:/${h}/${target.scope}/${target.unit}.log`);
}

function parseLogUri(uri: vscode.Uri): LogTarget {
    const segs = uri.path.split('/').filter((s) => s.length > 0);
    return {
        host: segs[0] && segs[0] !== 'local' ? segs[0] : '',
        scope: segs[1] === 'user' ? 'user' : 'system',
        unit: (segs[2] ?? '').replace(/\.log$/, ''),
    };
}

class LogContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;
    private sessions = new Map<string, LogSession>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        const key = uri.toString();
        let session = this.sessions.get(key);
        if (!session) {
            session = this.spawn(uri);
            this.sessions.set(key, session);
        }
        return this.render(session);
    }

    private render(session: LogSession): string {
        // When journalctl has produced nothing yet (e.g. the unit has no logs),
        // show a waiting hint instead of leaving the view empty/opening forever.
        const body = session.text.length > 0 ? session.text : '# Waiting for log output…\n';
        const target = session.host ? `${session.host}:` : 'local:';
        return `# Live logs: ${target}${session.scope} ${session.unit}\n${body}`;
    }

    private spawn(uri: vscode.Uri): LogSession {
        const { unit, host: h, scope: s } = parseLogUri(uri);
        const bin = vscode.workspace
            .getConfiguration('systemd-toolkit')
            .get<string>('journalctlPath', 'journalctl');
        // Show the last 300 lines, then follow new entries (also over ssh),
        // honouring the host + scope the log was requested with.
        const built = buildCommand(
            bin,
            journalctlArgs(['-u', unit, '--follow', '--no-pager', '-n', '300'], s),
            false,
            s,
            h
        );
        const proc = cp.spawn(built.cmd, built.args, { shell: false });
        command(built.display);
        const session: LogSession = { unit, host: h, scope: s, proc, text: '', pending: '' };
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

    /** Stop and forget the streaming session for a document (e.g. its tab closed). */
    stop(key: string): void {
        const session = this.sessions.get(key);
        if (!session) {
            return;
        }
        this.sessions.delete(key);
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
                provider.stop(doc.uri.toString());
            }
        }),
        { dispose: () => provider.stopAll() },
    );
}

/** Open (or reveal) the continuously-refreshing log document for a unit. */
export async function showLogs(unit: string, scopeOverride?: UnitScope): Promise<void> {
    const target: LogTarget = { unit, host: host(), scope: scopeOverride ?? scope() };
    const doc = await vscode.workspace.openTextDocument(logUri(target));
    await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
    });
}
