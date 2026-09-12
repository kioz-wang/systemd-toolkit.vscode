import * as vscode from 'vscode';
import * as path from 'path';
import { DirectivesData, Directive, FileTypeInfo, Manifest, ManifestEntry } from './types';

const DATA_DIR = path.join(__dirname, '..', 'data');

let manifest: Manifest | undefined;
let activeEntry: ManifestEntry | undefined;
let data: DirectivesData | undefined;

/** A deprecated alias (still parsed by systemd) mapped to its canonical directive. */
interface LegacyAlias {
    scope: string;
    section: string;
    name: string;
    canonical: string;
    canonicalSection: string;
}

let legacyAliases: LegacyAlias[] | undefined;

/** Load (once) the curated list of deprecated directive aliases. */
function loadLegacyAliases(): LegacyAlias[] {
    if (legacyAliases) {
        return legacyAliases;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const raw = require(path.join(DATA_DIR, 'legacy-aliases.json')) as Record<string, unknown>;
        const collected: LegacyAlias[] = [];
        for (const [scope, list] of Object.entries(raw)) {
            if (scope === 'description' || !Array.isArray(list)) {
                continue;
            }
            for (const item of list) {
                if (item && typeof item === 'object') {
                    const a = item as Record<string, unknown>;
                    if (typeof a.section === 'string' && typeof a.name === 'string' &&
                        typeof a.canonical === 'string' && typeof a.canonicalSection === 'string') {
                        collected.push({
                            scope,
                            section: a.section,
                            name: a.name,
                            canonical: a.canonical,
                            canonicalSection: a.canonicalSection,
                        });
                    }
                }
            }
        }
        legacyAliases = collected;
    } catch {
        legacyAliases = [];
    }
    return legacyAliases;
}

/**
 * Merge deprecated aliases into the loaded data so hover/link still work for
 * legacy directive names that systemd accepts but the man pages no longer
 * document (e.g. the `[Service]` `StartLimitBurst=` compatibility alias).
 */
function applyLegacyAliases(d: DirectivesData): void {
    for (const alias of loadLegacyAliases()) {
        const scope = d.scopes[alias.scope];
        if (!scope) {
            continue;
        }
        const canonical = (scope.sections[alias.canonicalSection] ?? []).find(
            (x) => x.name === alias.canonical
        );
        if (!canonical) {
            continue;
        }
        const section = (scope.sections[alias.section] ??= []);
        if (section.some((x) => x.name === alias.name)) {
            continue;
        }
        section.push({
            ...canonical,
            name: alias.name,
            linkName: alias.canonical,
            summary: `*Deprecated alias of \`${alias.canonical}=\`.*\n\n${canonical.summary}`,
        });
    }
}

/** Load (once) the data/manifest.json listing supported systemd versions. */
export function loadManifest(): Manifest | undefined {
    if (manifest) {
        return manifest;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        manifest = require(path.join(DATA_DIR, 'manifest.json')) as Manifest;
    } catch (err) {
        vscode.window.showErrorMessage(`systemd: failed to load manifest: ${err}`);
        manifest = undefined;
    }
    return manifest;
}

/** Return the manifest entry for a version key, or undefined. */
export function manifestEntry(version: string): ManifestEntry | undefined {
    const m = loadManifest();
    if (!m) {
        return undefined;
    }
    return m.versions.find((e) => e.version === version);
}

/** The newest supported version key, or undefined. */
export function latestVersion(): string | undefined {
    const m = loadManifest();
    if (!m || m.versions.length === 0) {
        return undefined;
    }
    return m.versions[m.versions.length - 1].version;
}

/** Sorted list of supported version keys. */
export function supportedVersions(): string[] {
    const m = loadManifest();
    return m ? m.versions.map((e) => e.version) : [];
}

/**
 * Select and load the data for the given version key. Returns true on success.
 * Loading is lazy: the file is only read the first time it is requested.
 */
export function setActiveVersion(version: string): boolean {
    const entry = manifestEntry(version);
    if (!entry) {
        data = undefined;
        activeEntry = undefined;
        return false;
    }
    if (activeEntry && activeEntry.version === version && data) {
        return true;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        data = require(path.join(DATA_DIR, entry.file)) as DirectivesData;
        applyLegacyAliases(data);
        activeEntry = entry;
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`systemd: failed to load data for v${version}: ${err}`);
        data = undefined;
        activeEntry = undefined;
        return false;
    }
}

/** Return the active directives data, or undefined if none is loaded. */
export function loadData(): DirectivesData | undefined {
    return data;
}

/** Clear the active data, disabling the language features that depend on it. */
export function clearActiveVersion(): void {
    data = undefined;
    activeEntry = undefined;
}

/** The active version key, or undefined. */
export function activeVersion(): string | undefined {
    return activeEntry?.version;
}

export interface ResolvedFile {
    /** Key into `scopes`. */
    scope: string;
    /** Valid [Section] names for this file. */
    sections: string[];
    /** Man page documenting the file type. */
    doc: string;
    /** Whether the file was matched exactly (by extension/filename). */
    exact: boolean;
}

/**
 * Resolve the systemd scope for a document based on its extension or filename.
 * Returns undefined when the file is not recognised as a systemd file.
 */
export function resolveFile(document: vscode.TextDocument): ResolvedFile | undefined {
    const d = loadData();
    if (!d) {
        return undefined;
    }
    const fileName = path.basename(document.fileName);
    const ext = path.extname(fileName).slice(1).toLowerCase();

    if (ext && d.fileTypes[ext]) {
        const info = d.fileTypes[ext];
        return { scope: info.scope, sections: info.sections, doc: info.doc, exact: true };
    }
    if (d.filenames[fileName]) {
        const info = d.filenames[fileName];
        return { scope: info.scope, sections: info.sections, doc: info.doc, exact: true };
    }
    // Generic `.conf` file: try to map its [Section] to a known config scope.
    if (ext === 'conf') {
        const section = firstSection(document);
        if (section) {
            const scope = findConfigScopeForSection(section);
            if (scope) {
                const info = scope.fileType;
                return { scope: scope.scopeName, sections: info.sections, doc: info.doc, exact: false };
            }
        }
    }
    return undefined;
}

interface ConfigScopeMatch {
    scopeName: string;
    fileType: FileTypeInfo;
}

/**
 * Find a config scope (config:* or a daemon scope) whose sections include the
 * given section name. Used to recognise `.conf` drop-in files.
 */
export function findConfigScopeForSection(section: string): ConfigScopeMatch | undefined {
    const d = loadData();
    if (!d) {
        return undefined;
    }
    for (const filename in d.filenames) {
        const info = d.filenames[filename];
        if (info.sections.includes(section)) {
            return { scopeName: info.scope, fileType: info };
        }
    }
    return undefined;
}

/** Return the first [Section] header in a document, or undefined. */
export function firstSection(document: vscode.TextDocument): string | undefined {
    const text = document.getText();
    const re = /^\s*\[([^\]]+)\]\s*$/m;
    const m = re.exec(text);
    return m ? m[1].trim() : undefined;
}

/**
 * Determine the [Section] that contains the given position by scanning
 * backwards for the nearest section header line.
 */
export function sectionAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    for (let line = position.line; line >= 0; line--) {
        const text = document.lineAt(line).text;
        const m = /^\s*\[([^\]]+)\]\s*$/.exec(text);
        if (m) {
            return m[1].trim();
        }
    }
    return undefined;
}

/** Look up a directive by name within a scope and section. */
export function findDirective(
    scope: string,
    section: string | undefined,
    name: string
): Directive | undefined {
    const d = loadData();
    if (!d) {
        return undefined;
    }
    const scopeData = d.scopes[scope];
    if (!scopeData || !section) {
        return undefined;
    }
    const directives = scopeData.sections[section];
    if (!directives) {
        return undefined;
    }
    return directives.find((x) => x.name === name);
}

/** Look up all directives in a scope/section (empty if unknown). */
export function directivesFor(scope: string, section: string | undefined): Directive[] {
    const d = loadData();
    if (!d || !section) {
        return [];
    }
    const scopeData = d.scopes[scope];
    if (!scopeData) {
        return [];
    }
    return scopeData.sections[section] || [];
}

/** Return the data version string, e.g. "systemd-262~rc2". */
export function dataVersion(): string {
    const d = loadData();
    return d ? d.generatedFrom : 'unknown';
}
