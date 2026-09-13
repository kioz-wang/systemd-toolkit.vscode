import * as vscode from 'vscode';
import { host, scope, onHostChanged, onScopeChanged } from './remote';
import { activeVersion } from './data';
import { isSystemdAvailable, detectedSystemdVersion } from './version';

/**
 * A status-bar item summarising the current target (host, scope) and the
 * directive-data version in use. Clicking it offers quick switching of the
 * host and scope. Returns a `refresh` function so the caller can update it
 * after the directive version is (re)loaded.
 */
export function registerStatusBar(context: vscode.ExtensionContext): () => void {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.tooltip = 'systemd target — click to switch host / scope';
    item.command = 'systemd.statusBarMenu';
    item.show();

    const refresh = (): void => {
        const h = host() || 'local';
        const s = scope();
        const v = activeVersion();
        const det = detectedSystemdVersion();
        const available = isSystemdAvailable();

        // When the directive data in use does not match the target's actual
        // systemd (including "no systemd at all"), highlight the version so the
        // mismatch is visible rather than silently showing a misleading vNNN.
        let versionText: string;
        let versionDetail: string;
        if (!v) {
            versionText = 'v?';
            versionDetail = 'no directive data loaded';
        } else if (!available) {
            versionText = `$(warning) v${v}`;
            versionDetail = `v${v} (fallback — systemd not detected on target)`;
        } else if (det && det !== v) {
            versionText = `$(warning) v${v}`;
            versionDetail = `v${v} (target is v${det})`;
        } else {
            versionText = `v${v}`;
            versionDetail = `v${v}`;
        }

        // Status-bar text only supports codicons (not custom SVGs), so we keep
        // it plain rather than showing a misleading non-systemd icon.
        item.text = `${h} · ${s} · ${versionText}`;
        item.tooltip = `systemd target\nHost: ${h}\nScope: ${s}\nDirective data: ${versionDetail}\nClick to switch host / scope`;
    };

    refresh();
    context.subscriptions.push(
        item,
        onHostChanged(refresh),
        onScopeChanged(refresh),
        vscode.commands.registerCommand('systemd.statusBarMenu', async () => {
            const pick = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(remote) Switch host',
                        description: host() || 'local',
                        action: 'host' as const,
                    },
                    {
                        label: '$(server) Switch scope',
                        description: scope(),
                        action: 'scope' as const,
                    },
                ],
                { placeHolder: 'systemd target' }
            );
            if (!pick) {
                return;
            }
            await vscode.commands.executeCommand(
                pick.action === 'host' ? 'systemd.switchHost' : 'systemd.switchScope'
            );
        })
    );

    return refresh;
}
