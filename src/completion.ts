import * as vscode from 'vscode';
import { lineContext } from './context';
import { resolveFile, sectionAt, directivesFor, findDirective } from './data';
import { error } from './logger';

export class SystemdCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[]> {
        try {
            return this.doProvideCompletionItems(document, position);
        } catch (err) {
            error(`completion provider error: ${err}`);
            return undefined;
        }
    }

    private doProvideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined {
        const resolved = resolveFile(document);
        if (!resolved) {
            return undefined;
        }
        const ctx = lineContext(document, position);
        if (ctx.inComment) {
            return undefined;
        }

        // Section header completion: user is typing "[...".
        if (ctx.inSection) {
            const range = sectionHeaderRange(document, position, ctx);
            return resolved.sections.map((name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                item.range = range;
                item.detail = 'Section';
                item.insertText = name;
                item.sortText = '0' + name;
                return item;
            });
        }

        // Value completion: cursor is after "Key=".
        if (ctx.inValue && ctx.key) {
            const section = sectionAt(document, position);
            const directive = findDirective(resolved.scope, section, ctx.key);
            if (directive && directive.values.length > 0) {
                const range = valueRange(document, position, ctx);
                return directive.values.map((value) => {
                    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
                    item.range = range;
                    item.detail = `${ctx.key}=`;
                    item.insertText = value;
                    item.sortText = '0' + value;
                    const doc = directive.valueDocs?.[value];
                    if (doc) {
                        item.documentation = new vscode.MarkdownString(doc);
                    }
                    return item;
                });
            }
            return undefined;
        }

        // Directive (key) completion: cursor is before "=".
        const section = sectionAt(document, position);
        if (!section) {
            return undefined;
        }
        if (!resolved.sections.includes(section)) {
            return undefined;
        }
        const directives = directivesFor(resolved.scope, section);
        const prefix = ctx.key ?? '';
        const range = new vscode.Range(
            position.line,
            lineStartOfKey(ctx),
            position.line,
            position.character
        );
        return directives
            .filter((d) => d.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .map((d) => {
                const item = new vscode.CompletionItem(d.name, vscode.CompletionItemKind.Property);
                item.range = range;
                item.insertText = d.name + '=';
                item.detail = `${d.manPage}(${d.manVolume})`;
                item.documentation = new vscode.MarkdownString(d.summary);
                item.sortText = '1' + d.name;
                return item;
            });
    }
}

function sectionHeaderRange(
    document: vscode.TextDocument,
    position: vscode.Position,
    ctx: ReturnType<typeof lineContext>
): vscode.Range {
    const open = ctx.beforeCursor.lastIndexOf('[');
    const start = open >= 0 ? open + 1 : position.character;
    const close = ctx.afterCursor.indexOf(']');
    const end = close >= 0 ? position.character + close : position.character;
    return new vscode.Range(position.line, start, position.line, end);
}

function valueRange(
    document: vscode.TextDocument,
    position: vscode.Position,
    ctx: ReturnType<typeof lineContext>
): vscode.Range {
    const eq = ctx.beforeCursor.lastIndexOf('=');
    const start = eq >= 0 ? eq + 1 : position.character;
    return new vscode.Range(position.line, start, position.line, position.character);
}

function lineStartOfKey(ctx: ReturnType<typeof lineContext>): number {
    const trimmed = ctx.lineText.length - ctx.lineText.trimStart().length;
    return trimmed;
}
