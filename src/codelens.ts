import * as vscode from 'vscode';
import { systemctl, UnitScope } from './remote';
import { unitForDocument, isSnapshotDocument, documentScope } from './unitfile';
import { isSystemdAvailable } from './version';

interface UnitState {
    loadState: string;
    activeState: string;
    subState: string;
    unitFileState: string;
}

/** Query load/active/sub/unit-file state in a single `systemctl show` call. */
async function queryUnitState(unit: string, scopeOverride?: UnitScope): Promise<UnitState> {
    const r = await systemctl(
        ['show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', unit],
        false,
        scopeOverride
    );
    const state: UnitState = { loadState: 'unknown', activeState: 'unknown', subState: '', unitFileState: '' };
    if (r.code !== 0) {
        return state;
    }
    for (const line of r.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) {
            continue;
        }
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === 'LoadState') state.loadState = value;
        else if (key === 'ActiveState') state.activeState = value;
        else if (key === 'SubState') state.subState = value;
        else if (key === 'UnitFileState') state.unitFileState = value;
    }
    return state;
}

function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export class SystemdCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        // On targets without systemd (e.g. Windows) there is nothing to query;
        // disable CodeLens entirely in that case.
        if (!isSystemdAvailable()) {
            return [];
        }
        const unit = unitForDocument(document);
        if (!unit) {
            return [];
        }
        const docScope = documentScope(document);
        const range = new vscode.Range(0, 0, 0, 0);
        const preview = isSnapshotDocument(document);

        const lens = (title: string, command: string, tooltip: string, icon?: string): vscode.CodeLens =>
            new vscode.CodeLens(range, {
                title: icon ? `$(${icon}) ${title}` : title,
                // An empty command id renders the lens as non-clickable text.
                command,
                arguments: command ? [unit, docScope] : undefined,
                tooltip,
            });

        const st = await queryUnitState(unit, docScope);
        const deployed = st.loadState !== 'not-found' && st.loadState !== 'unknown';

        if (!deployed) {
            const target = docScope === 'user' ? '~/.config/systemd/user/' : '/etc/systemd/system/';
            return [
                lens(`Deploy ${unit}`, 'systemd.deploy', `Deploy ${unit} to ${target} and daemon-reload`, 'cloud-upload'),
            ];
        }

        const lenses: vscode.CodeLens[] = [];

        // Status is shown as a plain, non-clickable label (no systemctl status
        // invocation) — it is only an indicator of the unit's current state.
        const statusLabel = st.activeState === 'unknown'
            ? 'Unknown'
            : cap(st.activeState) + (st.subState ? ` (${st.subState})` : '');
        const statusIcon = st.activeState === 'active'
            ? 'circle-filled'
            : st.activeState === 'failed' ? 'error' : 'circle-outline';
        lenses.push(lens(statusLabel, '', `Status of ${unit}: ${statusLabel}`, statusIcon));

        // Start/stop toggle + restart, by active state (skip when masked).
        if (st.loadState !== 'masked') {
            switch (st.activeState) {
                case 'active':
                    lenses.push(lens('Stop', 'systemd.stop', `Stop ${unit}`, 'debug-stop'));
                    lenses.push(lens('Restart', 'systemd.restart', `Restart ${unit}`, 'debug-restart'));
                    break;
                case 'failed':
                    lenses.push(lens('Restart', 'systemd.restart', `Restart ${unit}`, 'debug-restart'));
                    break;
                case 'inactive':
                    lenses.push(lens('Start', 'systemd.start', `Start ${unit}`, 'play'));
                    break;
                default:
                    // activating / deactivating / reloading / unknown: no run action.
                    break;
            }
        }

        // Enable/disable by unit-file state (only when meaningful).
        if (st.unitFileState === 'enabled') {
            lenses.push(lens('Disable', 'systemd.disable', `Disable ${unit}`, 'circle-slash'));
        } else if (st.unitFileState === 'disabled') {
            lenses.push(lens('Enable', 'systemd.enable', `Enable ${unit}`, 'check'));
        }

        // Logs (deployed only).
        lenses.push(lens('Logs', 'systemd.logs', `Show logs for ${unit}`, 'output'));

        // File action: read-only preview → Edit, editable document → Deploy.
        if (preview) {
            lenses.push(lens('Edit', 'systemd.units.editFile', `Open ${unit} for editing`, 'edit'));
        } else {
            lenses.push(lens('Deploy', 'systemd.deploy', `Write back ${unit} and daemon-reload`, 'cloud-upload'));
        }

        return lenses;
    }
}

