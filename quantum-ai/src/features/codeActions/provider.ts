// src/features/codeActions/provider.ts
import * as vscode from 'vscode';
import { AIProvider } from '../../providers/aiProvider';

export class QuantumCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.Refactor
    ];

    constructor(private aiProvider: AIProvider) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
        const actions: vscode.CodeAction[] = [];

        // Only provide actions for non-empty selections
        if (range.isEmpty) {
            return actions;
        }

        const selectedText = document.getText(range);
        if (!selectedText || selectedText.trim().length === 0) {
            return actions;
        }

        // Fix action
        const fixAction = new vscode.CodeAction('✎ Fix with AI', vscode.CodeActionKind.QuickFix);
        fixAction.command = {
            command: 'quantum-ai.applyFix',
            title: 'Fix with AI',
            arguments: [document, range]
        };
        fixAction.isPreferred = true;
        actions.push(fixAction);

        // Explain action
        const explainAction = new vscode.CodeAction('? Explain with AI', vscode.CodeActionKind.QuickFix);
        explainAction.command = {
            command: 'quantum-ai.explain',
            title: 'Explain with AI'
        };
        actions.push(explainAction);

        // Suggest improvements
        const suggestAction = new vscode.CodeAction('✨ Suggest improvements', vscode.CodeActionKind.Refactor);
        suggestAction.command = {
            command: 'quantum-ai.suggest',
            title: 'Suggest improvements'
        };
        actions.push(suggestAction);

        // Transpile action for quantum Python and JSX/TSX conversions.
        if (document.languageId === 'python' || document.languageId === 'javascriptreact' || document.languageId === 'typescriptreact') {
            const transpileAction = new vscode.CodeAction('🔄 Transpile Code', vscode.CodeActionKind.Refactor);
            transpileAction.command = {
                command: 'quantum-ai.transpile',
                title: 'Transpile Code'
            };
            actions.push(transpileAction);
        }

        // Add diagnostics-based fixes if available
        if (context.diagnostics.length > 0) {
            const diagnosticFix = new vscode.CodeAction(
                '🔧 Fix errors with AI',
                vscode.CodeActionKind.QuickFix
            );
            diagnosticFix.command = {
                command: 'quantum-ai.applyFix',
                title: 'Fix errors with AI',
                arguments: [document, range]
            };
            diagnosticFix.isPreferred = true;
            actions.push(diagnosticFix);
        }

        return actions;
    }
}
