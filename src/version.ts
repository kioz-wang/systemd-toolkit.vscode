import { systemctl } from './remote';
import { latestVersion, supportedVersions } from './data';

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
 * Resolve the directive-data version for the current target: detect the
 * systemd version and use the closest supported one, without prompting.
 * Returns the version key, or undefined when no data is available.
 */
export async function chooseVersion(): Promise<string | undefined> {
    const detected = await detectSystemdVersion();
    detectedSystemd = detected;
    availability = detected !== undefined ? 'available' : 'unavailable';
    return closestVersion(detected);
}
