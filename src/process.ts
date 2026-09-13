import * as cp from 'child_process';
import { command, commandError } from './logger';

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Spawn a command and capture its output. Never throws.
 * When `input` is provided, it is written to the child's stdin and the stream
 * is closed (used for e.g. `sudo tee <file>`).
 * Every execution is recorded in the extension's log channel.
 */
export function exec(cmd: string, args: string[], input?: string): Promise<ExecResult> {
    return new Promise((resolve) => {
        const display = [cmd, ...args].join(' ');
        command(display);
        const proc = cp.spawn(cmd, args, { shell: false });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        proc.stdin.on('error', () => {
            // stdin may be closed/ignored by the child; that is not fatal.
        });
        if (input !== undefined) {
            proc.stdin.write(input);
        }
        proc.stdin.end();
        proc.on('error', (err) => {
            const message = String(err);
            commandError(display, 1, message);
            resolve({ code: 1, stdout, stderr: message });
        });
        proc.on('close', (code) => {
            const exit = code ?? 1;
            if (exit !== 0) {
                commandError(display, exit, stderr || stdout);
            }
            resolve({ code: exit, stdout, stderr });
        });
    });
}

