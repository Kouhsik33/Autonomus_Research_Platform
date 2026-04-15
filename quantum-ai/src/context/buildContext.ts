import * as vscode from 'vscode';

export interface CodeContext {
    surroundingCode: string;
    languageId: string;
    filePath: string;
    cursorPosition?: vscode.Position;
    selection?: string;
}

export class ContextBuilder {
    /**
     * Builds context from the current editor state
     */
    static async buildContext(editor: vscode.TextEditor): Promise<CodeContext> {
        const document = editor.document;
        const selection = editor.selection;
        
        let surroundingCode = '';
        const maxLines = vscode.workspace.getConfiguration('quantum-ai').get('maxLinesForContext', 20);
        
        if (!selection.isEmpty) {
            // If there's a selection, get surrounding lines for context
            const startLine = Math.max(0, selection.start.line - 5);
            const endLine = Math.min(document.lineCount - 1, selection.end.line + 5);
            surroundingCode = document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length));
        } else {
            // Get last N lines before cursor
            const startLine = Math.max(0, editor.selection.active.line - maxLines);
            surroundingCode = document.getText(new vscode.Range(
                startLine, 
                0, 
                editor.selection.active.line, 
                document.lineAt(editor.selection.active.line).text.length
            ));
        }

        return {
            surroundingCode,
            languageId: document.languageId,
            filePath: document.fileName,
            cursorPosition: editor.selection.active,
            selection: selection.isEmpty ? undefined : document.getText(selection)
        };
    }

    /**
     * Truncates context to fit within token limits
     */
    static truncateContext(context: string, maxLength: number = 2000): string {
        if (context.length <= maxLength) {
            return context;
        }
        return context.slice(0, maxLength) + '\n// ... truncated';
    }
}