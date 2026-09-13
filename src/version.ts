import * as vscode from 'vscode';
import { systemctl } from './remote';
import { manifestEntry, latestVersion } from './data';

export interface VersionDecision {
    /** 'ok' (exact match), 'override' (user forced), 'fallback' (undetectable), 'unsupported'. */
    status: 'ok' | 'override' | 'fallback' | 'unsupported';
    /** Chosen version key (present unless status is 'unsupported'). */
    version?: string;
    /** Local systemd version that was detected, if any. */
    detected?: string;
}

/** Whether systemd is reachable on the current target. 'unknown' until first detection. */
export type SystemdAvailability = 'unknown' | 'available' | 'unavailable';

let availability: SystemdAvailability = 'unknown';
let detectedSystemd: string | undefined;

/** The last detection result: can the target run `systemctl --version`? */
export function systemdAvailability(): SystemdAvailability {
    return availability;
}

/** True once detection succeeded (systemd is reachable on the target). */
export function isSystemdAvailable(): boolean {
    return availability === 'available';
}

/** The actual systemd version detected on the target, or undefined. */
export function detectedSystemdVersion(): string | undefined {
    return detectedSystemd;
}

/**
 * Detect the systemd version on the target by parsing `systemctl --version`.
 * Returns the release number (e.g. "262") or undefined when unavailable.
 */
export async function detectSystemdVersion(): Promise<string | undefined> {
    const result = await systemctl(['--version']);
    if (result.code !== 0) {
        return undefined;
    }
    const firstLine = result.stdout.split('\n')[0].trim();
    const m = /systemd\s+(\d+)/.exec(firstLine);
    return m ? m[1] : undefined;
}

/**
 * Pure decision logic (testable without side effects):
 *   - `override` wins when it names a supported version.
 *   - otherwise `detected` is matched exactly.
 *   - if detection failed, fall back to `latest`.
 *   - if detected but unsupported, report 'unsupported'.
 */
export function decideVersion(
    override: string | undefined,
    detected: string | undefined,
    latest: string | undefined
): VersionDecision {
    if (override && manifestEntry(override)) {
        return { status: 'override', version: override };
    }
    if (detected) {
        if (manifestEntry(detected)) {
            return { status: 'ok', version: detected, detected };
        }
        return { status: 'unsupported', detected };
    }
    if (latest) {
        return { status: 'fallback', version: latest };
    }
    return { status: 'unsupported' };
}

/**
 * Decide which data version to use, reading config and detecting the local
 * version as needed.
 */
export async function chooseVersion(): Promise<VersionDecision> {
    const config = vscode.workspace.getConfiguration('systemd');
    const override = (config.get<string>('versionOverride', '') || '').trim();
    if (override && !manifestEntry(override)) {
        void vscode.window.showWarningMessage(
            `systemd: versionOverride '${override}' is not a supported version; ignoring it.`
        );
    }

    const detected = await detectSystemdVersion();
    detectedSystemd = detected;
    availability = detected !== undefined ? 'available' : 'unavailable';
    return decideVersion(override, detected, latestVersion());
}
