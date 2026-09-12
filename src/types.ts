// Shared type definitions for the generated directives.json data file.

export interface Directive {
    /** Directive name without the trailing '=', e.g. "ExecStart". */
    name: string;
    /** Man page that documents this directive, e.g. "systemd.service". */
    manPage: string;
    /** Man volume, e.g. "5". */
    manVolume: string;
    /** First paragraph(s) of the man page description, as Markdown. */
    summary: string;
    /** Allowed enum values (best-effort), empty when not enumerable. */
    values: string[];
    /** Per-value markdown descriptions for non-boolean values (value → description). */
    valueDocs?: Record<string, string>;
    /** systemd release that introduced this directive, e.g. "254" ("" if unknown). */
    addedIn: string;
    /** Anchor name for the man-page link, when it differs from `name` (deprecated aliases). */
    linkName?: string;
}

export interface ScopeData {
    sections: Record<string, Directive[]>;
}

export interface FileTypeInfo {
    /** Key into `scopes`. */
    scope: string;
    /** Valid [Section] names for this file type. */
    sections: string[];
    /** Man page documenting the file type. */
    doc: string;
}

export interface DirectivesData {
    version: number;
    generatedFrom: string;
    scopes: Record<string, ScopeData>;
    fileTypes: Record<string, FileTypeInfo>;
    filenames: Record<string, FileTypeInfo>;
}

export interface ManifestEntry {
    /** systemd release number, e.g. "262". */
    version: string;
    /** Data file name relative to the data/ directory. */
    file: string;
    /** Human-readable source, e.g. "systemd-262~rc2". */
    generatedFrom: string;
}

export interface Manifest {
    /** Supported versions, sorted ascending. */
    versions: ManifestEntry[];
}
