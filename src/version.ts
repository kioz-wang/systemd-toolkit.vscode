import * as vscode from 'vscode';
import { systemctl } from './remote';
import { activeVersion, latestVersion, supportedVersions } from './data';

/** Whether systemd is reachable on the current target. 'unknown' until first detection. */
export type SystemdAvailability = 'unknown' | 'available' | 'unavailable';

let availability: SystemdAvailability = 'unknown';
let detectedSystemd: string | undefined;

/**
 * A version the user picked manually for the current host connection. It wins
 * over the automatic nearest match and is cleared when the host changes.
 */
let sessionVersion: string | undefined;

const versionChanged = new vscode.EventEmitter<void>();

/** Fired when the manual version choice changes. */
export const onVersionChanged = versionChanged.event;

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

/** The manually chosen version for this connection, or undefined (automatic). */
export function manualVersion(): string | undefined {
    return sessionVersion;
}

/** Clear the manual choice so the next resolution is automatic (on host switch). */
export function resetVersionChoice(): void {
    sessionVersion = undefined;
}

/** Apply a manual version choice; `undefined` restores automatic selection. */
export function setManualVersion(version: string | undefined): void {
    sessionVersion = version;
    versionChanged.fire();
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
 * Pick the supported directive-data version closest to `detected`. Ties favour
 * the newer version. With no detected version (no systemd on the target), the
 * newest supported version is used.
 */
export function closestVersion(detected: string | undefined): string | undefined {
    const versions = supportedVersions();
    if (versions.length === 0) {
        return undefined;
    }
    const target = detected ? Number.parseInt(detected, 10) : Number.NaN;
    if (!Number.isFinite(target)) {
        return latestVersion();
    }
    let best = versions[0];
    let bestDistance = Math.abs(Number(best) - target);
    for (const version of versions.slice(1)) {
        const distance = Math.abs(Number(version) - target);
        if (distance < bestDistance || (distance === bestDistance && Number(version) > Number(best))) {
            best = version;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * Resolve the directive-data version for the current target: a manual choice
 * for this connection wins, otherwise the detected systemd version's closest
 * supported data is used. Returns the version key, or undefined when no data is
 * available.
 */
export async function chooseVersion(): Promise<string | undefined> {
    const detected = await detectSystemdVersion();
    detectedSystemd = detected;
    availability = detected !== undefined ? 'available' : 'unavailable';
    return sessionVersion ?? closestVersion(detected);
}

/**
 * Pick a directive-data version for this connection: `auto` (nearest match) or
 * one of the supported versions. Used after startup; startup never prompts.
 */
export async function switchVersion(): Promise<void> {
    const current = sessionVersion;
    const active = activeVersion();
    const items: vscode.QuickPickItem[] = [
        {
            label: 'auto',
            description: active ? `nearest match (currently v${active})` : 'nearest match',
            picked: current === undefined,
        },
        ...supportedVersions().map((v) => ({
            label: v,
            description: 'directive data',
            picked: v === current,
        })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
        title: 'systemd: directive data version',
        placeHolder: current ? `Manual: v${current}` : 'Automatic (nearest to target)',
    });
    if (!pick) {
        return;
    }
    setManualVersion(pick.label === 'auto' ? undefined : pick.label);
}
