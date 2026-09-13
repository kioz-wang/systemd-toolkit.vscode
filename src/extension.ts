import * as vscode from 'vscode';
import { SystemdCompletionProvider } from './completion';
import { SystemdHoverProvider, SystemdDocumentLinkProvider } from './help';
import { registerCommands } from './commands';
import { registerLogs } from './logs';
import { loadManifest, setActiveVersion, supportedVersions, clearActiveVersion } from './data';
import { chooseVersion } from './version';
import { registerTree } from './tree';
import { registerUnitFile, onUnitsChanged } from './unitfile';
import { SystemdCodeLensProvider } from './codelens';
import { registerStatusBar } from './statusbar';
import { onHostChanged, onScopeChanged } from './remote';
import { info } from './logger';

/**
 * Document selectors for the language features. The `systemd` language covers
 * the registered extensions and filenames; the `.conf` glob additionally
 * matches drop-in files under e.g. /etc/systemd/.../*.conf.d/ that VS Code
 * classifies as plain text or INI.
 */
const SELECTORS: vscode.DocumentSelector = [
    { language: 'systemd' },
    { scheme: 'file', pattern: '**/*.conf' },
    { scheme: 'file', pattern: '**/*.dnssd' },
    { scheme: 'file', pattern: '**/*.dns-delegate' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Command integration, tree view, unit-file ops and code lens don't depend
    // on the directive data version, so they are registered unconditionally.
    registerCommands(context);
    registerLogs(context);
    const tree = registerTree(context);
    registerUnitFile(context);
    const codeLens = new SystemdCodeLensProvider();
    const refreshStatus = registerStatusBar(context);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(SELECTORS, codeLens),
        // A deploy changes unit load/active state and the panel contents:
        // refresh both the code lens and the Units tree.
        onUnitsChanged(() => {
            codeLens.refresh();
            tree.refreshAll();
        }),
    );

    // Language features (completion/hover/links) are registered unconditionally;
    // they no-op while no directive data is loaded (see applyDirectiveVersion).
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            SELECTORS,
            new SystemdCompletionProvider(),
            '=', '[', '.'
        ),
        vscode.languages.registerHoverProvider(SELECTORS, new SystemdHoverProvider()),
        vscode.languages.registerDocumentLinkProvider(SELECTORS, new SystemdDocumentLinkProvider()),
    );

    const manifest = loadManifest();
    if (!manifest || manifest.versions.length === 0) {
        void vscode.window.showErrorMessage(
            'systemd: no supported systemd versions found in data/manifest.json; language features disabled.'
        );
        return;
    }

    // Detect the version on the current host, load its directive data, and
    // refresh code lens. Runs in the background (activation must not block on a
    // `systemctl --version` round-trip, which is slow for remote hosts) and is
    // re-run whenever the host changes.
    const apply = async (): Promise<void> => {
        await applyDirectiveVersion();
        codeLens.refresh();
        refreshStatus();
        tree.refreshAll();
    };

    void apply();
    context.subscriptions.push(
        onHostChanged(() => void apply()),
        // Scope change reuses the same version data but flips which units the
        // code lens sees; refresh it (the tree refreshes itself).
        onScopeChanged(() => codeLens.refresh()),
    );
}

/**
 * Detect the systemd version on the currently selected host and load the
 * matching directive data. Clears the data (disabling language features) when
 * the version is unsupported or detection fails in a way we cannot recover.
 */
async function applyDirectiveVersion(): Promise<void> {
    const decision = await chooseVersion();

    if (decision.status === 'unsupported') {
        const supported = supportedVersions().join(', ');
        clearActiveVersion();
        void vscode.window.showErrorMessage(
            `systemd: systemd ${decision.detected ?? 'unknown'} on the current host is not supported. ` +
            `Supported versions: ${supported}. ` +
            `Set "systemd.versionOverride" to one of them to force a version. Language features disabled.`
        );
        return;
    }

    if (decision.status === 'fallback') {
        // On platforms without a native systemd (Windows, macOS, …) this is
        // expected, not an error — the Target view shows a hint instead. On
        // Linux keep the warning so a broken/unreachable target is visible.
        if (process.platform === 'linux') {
            void vscode.window.showWarningMessage(
                `systemd: could not detect the systemd version on the current host; using v${decision.version} data.`
            );
        }
    }

    if (!setActiveVersion(decision.version!)) {
        void vscode.window.showErrorMessage('systemd: failed to load directive data.');
        return;
    }

    info(`systemd extension activated (data v${decision.version})`);
}

export function deactivate(): void {
    // nothing to clean up
}
