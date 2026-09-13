import * as vscode from 'vscode';
import { lineContext } from './context';
import { resolveFile, sectionAt, findDirective } from './data';
import { isUnitDeployed } from './remote';
import { snapshotUri, preloadSnapshots, documentScope } from './unitfile';
import { error } from './logger';

/** Directives whose values are unit names (clickable to a unit preview). */
const DEPENDENCY_DIRECTIVES = new Set([
    'After', 'Before', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf',
    'Conflicts', 'Upholds', 'PropagatesReloadTo', 'ReloadPropagatedFrom',
    'JoinsNamespaceOf', 'WantedBy', 'RequiredBy', 'Also', 'UpheldBy',
    'Triggers', 'TriggeredBy',
]);

const UNIT_NAME_RE = /([\w@.:-]+\.(service|socket|target|timer|path|mount|swap|slice|scope|automount|device))/g;

/** Build the online documentation URL for a directive. */
export function docUrl(manPage: string, name: string): string {
    const base = vscode.workspace
        .getConfiguration('systemd')
        .get<string>('onlineDocBase', 'https://www.freedesktop.org/software/systemd/man/latest/');
    const anchor = encodeURIComponent(name + '=');
    return `${base}${manPage}.html#${anchor}`;
}

function hoveredDirectiveName(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    // The word under the cursor/mouse is the directive name when hovering a key.
    const range = document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9_]*/);
    if (range) {
        const word = document.getText(range);
        const ctx = lineContext(document, position);
        if (!ctx.inComment && !ctx.inSection) {
            return word;
        }
    }
    return undefined;
}

export class SystemdHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        try {
            return this.doProvideHover(document, position);
        } catch (err) {
            error(`hover provider error: ${err}`);
            return undefined;
        }
    }

    private doProvideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const resolved = resolveFile(document);
        if (!resolved) {
            return undefined;
        }
        const name = hoveredDirectiveName(document, position);
        if (!name) {
            return undefined;
        }
        const section = sectionAt(document, position);
        const directive = findDirective(resolved.scope, section, name);
        if (!directive) {
            return undefined;
        }

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${directive.name}** — \`${directive.manPage}(${directive.manVolume})\`\n\n`);
        if (directive.summary) {
            md.appendMarkdown(directive.summary + '\n\n');
        }
        if (directive.addedIn) {
            md.appendMarkdown(`*Added in version ${directive.addedIn}.*\n\n`);
        }
        if (directive.values.length > 0) {
            md.appendMarkdown('Allowed values: ');
            md.appendMarkdown(directive.values.map((v) => `\`${v}\``).join(', '));
            md.appendMarkdown('\n\n');
        }
        md.appendMarkdown('---\n\n');
        const source = vscode.workspace.getConfiguration('systemd').get<string>('docSource', 'online');
        if (source === 'man') {
            md.appendMarkdown(`See \`man ${directive.manPage}\``);
        } else {
            md.appendMarkdown(`[Open ${directive.manPage}(${directive.manVolume}) documentation](${docUrl(directive.manPage, directive.linkName ?? directive.name)})`);
        }
        md.isTrusted = true;

        return new vscode.Hover(md);
    }
}

export class SystemdDocumentLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentLink[]> {
        try {
            return this.doProvideDocumentLinks(document);
        } catch (err) {
            error(`document link provider error: ${err}`);
            return [];
        }
    }

    private async doProvideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const online = vscode.workspace
            .getConfiguration('systemd')
            .get<string>('docSource', 'online') === 'online';
        const resolved = resolveFile(document);
        if (!resolved) {
            return [];
        }

        const links: vscode.DocumentLink[] = [];
        const dependencyUnits = new Set<string>();
        const docScope = documentScope(document);
        let section: string | undefined;
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const secMatch = /^\s*\[([^\]]+)\]\s*$/.exec(text);
            if (secMatch) {
                section = secMatch[1].trim();
                continue;
            }
            const keyMatch = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(text);
            if (!keyMatch) {
                continue;
            }
            const name = keyMatch[1];
            const directive = findDirective(resolved.scope, section, name);

            // Key link → online man page (only when docSource is "online").
            if (online && directive) {
                const start = text.indexOf(name);
                const range = new vscode.Range(line, start, line, start + name.length);
                const target = vscode.Uri.parse(docUrl(directive.manPage, directive.linkName ?? directive.name));
                links.push(new vscode.DocumentLink(range, target));
            }

            // Value links → unit preview, for dependency directives whose values
            // are deployed unit names.
            if (DEPENDENCY_DIRECTIVES.has(name)) {
                await this.addUnitValueLinks(text, line, links, dependencyUnits, docScope);
            }
        }

        // Warm the snapshot cache with the document's direct dependencies so a
        // Ctrl+Click opens instantly instead of showing "Loading".
        preloadSnapshots([...dependencyUnits], docScope);

        return links;
    }

    private async addUnitValueLinks(
        text: string,
        line: number,
        links: vscode.DocumentLink[],
        collect: Set<string>,
        docScope: 'system' | 'user'
    ): Promise<void> {
        const eq = text.indexOf('=');
        if (eq < 0) {
            return;
        }
        const valueStr = text.slice(eq + 1);
        UNIT_NAME_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = UNIT_NAME_RE.exec(valueStr))) {
            const unit = m[1];
            if (!(await isUnitDeployed(unit, docScope))) {
                continue;
            }
            collect.add(unit);
            const start = eq + 1 + m.index;
            const range = new vscode.Range(line, start, line, start + unit.length);
            links.push(new vscode.DocumentLink(range, snapshotUri(unit, docScope)));
        }
    }
}
