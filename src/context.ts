import * as vscode from 'vscode';

/** Parsed view of the line the cursor is on. */
export interface LineContext {
    /** Full line text. */
    lineText: string;
    /** Text before the cursor on this line. */
    beforeCursor: string;
    /** Text after the cursor on this line. */
    afterCursor: string;
    /** true when the line begins (after whitespace) with '[' (section context). */
    inSection: boolean;
    /** Directive key (text before the first '='), if any. */
    key: string | undefined;
    /** true when the cursor is after the '=' (value position). */
    inValue: boolean;
    /** true when the line is a comment. */
    inComment: boolean;
}

export function lineContext(document: vscode.TextDocument, position: vscode.Position): LineContext {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.slice(0, position.character);
    const afterCursor = lineText.slice(position.character);
    const trimmed = lineText.trim();

    const inComment = /^[#;]/.test(trimmed);
    const inSection = /^\s*\[/.test(lineText) && !inComment;

    let key: string | undefined;
    let inValue = false;
    const eq = beforeCursor.indexOf('=');
    if (eq >= 0) {
        key = beforeCursor.slice(0, eq).trim();
        inValue = true;
    } else {
        key = trimmed;
    }

    return {
        lineText,
        beforeCursor,
        afterCursor,
        inSection,
        key,
        inValue,
        inComment,
    };
}
