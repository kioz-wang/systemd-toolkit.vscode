import * as cp from 'child_process';

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Spawn a command and capture its output. Never throws.
 * When `input` is provided, it is written to the child's stdin and the stream
 * is closed (used for e.g. `sudo tee <file>`).
 */
export function exec(cmd: string, args: string[], input?: string): Promise<ExecResult> {
    return new Promise((resolve) => {
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
        proc.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }));
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}
