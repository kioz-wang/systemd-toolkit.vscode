import * as vscode from 'vscode';
import { systemctl } from './remote';
import { manifestEntry, supportedVersions } from './data';

/** Whether systemd is reachable on the current target. 'unknown' until first detection. */
export type SystemdAvailability = 'unknown' | 'available' | 'unavailable';

let availability: SystemdAvailability = 'unknown';
let detectedSystemd: string | undefined;

/**
 * A version the user picked for the current host connection (because auto-match
 * failed). Cleared whenever the host changes, then re-evaluated.
 */
let sessionVersion: string | undefined;

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

/** Clear the per-connection version choice (called on host switch). */
export function resetVersionChoice(): void {
    sessionVersion = undefined;
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
 * Prompt the user to choose a directive-data version. Shown when the target has
 * no systemd, or its version has no matching data. Returns the chosen version,
 * or undefined if the user cancels (language features stay disabled).
 */
async function promptForVersion(reason: string): Promise<string | undefined> {
    const versions = supportedVersions();
    const pick = await vscode.window.showQuickPick(
        versions.map((v) => ({ label: v, description: 'directive data' })),
        {
            title: `systemd: ${reason}`,
            placeHolder: 'Choose a systemd version for directive data',
        }
    );
    return pick?.label;
}

/**
 * Resolve which directive-data version to use:
 *   1. A user choice made for this connection wins (no re-detection).
 *   2. Otherwise match the target's detected systemd version.
 *   3. If detection fails or the version is unsupported, prompt the user.
 * Returns the version key, or undefined when no data should be loaded.
 */
export async function chooseVersion(): Promise<string | undefined> {
    if (sessionVersion && manifestEntry(sessionVersion)) {
        return sessionVersion;
    }

    const detected = await detectSystemdVersion();
    detectedSystemd = detected;
    availability = detected !== undefined ? 'available' : 'unavailable';

    if (detected && manifestEntry(detected)) {
        return detected;
    }

    const reason = detected
        ? `systemd v${detected} is not supported`
        : 'systemd not detected on target';
    const chosen = await promptForVersion(reason);
    if (chosen) {
        sessionVersion = chosen;
    }
    return chosen;
}
