// src/features/fix/command.ts
import * as vscode from 'vscode';
import { AIProvider } from '../../providers/aiProvider';  // Fixed import path

export class ApplyFixCommand {
    constructor(
        private aiProvider: AIProvider,
        private outputChannel: vscode.OutputChannel
    ) {}

    async execute(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
        const selectedText = document.getText(range);
        const languageId = document.languageId;
        
        try {
            // Create a preview first
            const preview = await this.createPreview(selectedText, languageId);
            
            if (!preview) {
                return;
            }

            // Apply the fix
            await this.applyFix(document, range, preview);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async createPreview(selectedText: string, languageId: string): Promise<string | undefined> {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating fix...',
            cancellable: true
        }, async (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => {
            token.onCancellationRequested(() => {
                throw new Error('Cancelled');
            });

            const fixedCode = await this.aiProvider.fix(selectedText, languageId);
            
            if (!fixedCode || fixedCode.trim().length === 0) {
                throw new Error('AI returned empty fix');
            }

            // Show diff preview
            const shouldApply = await this.showDiffPreview(selectedText, fixedCode, languageId);
            
            return shouldApply ? fixedCode : undefined;
        });
    }

    private async showDiffPreview(original: string, fixed: string, languageId: string): Promise<boolean> {
        const originalUri = vscode.Uri.parse('untitled:original');
        const fixedUri = vscode.Uri.parse('untitled:fixed');

        const originalDoc = await vscode.workspace.openTextDocument(originalUri);
        const fixedDoc = await vscode.workspace.openTextDocument(fixedUri);

        const originalEdit = new vscode.WorkspaceEdit();
        originalEdit.insert(originalUri, new vscode.Position(0, 0), original);
        await vscode.workspace.applyEdit(originalEdit);

        const fixedEdit = new vscode.WorkspaceEdit();
        fixedEdit.insert(fixedUri, new vscode.Position(0, 0), fixed);
        await vscode.workspace.applyEdit(fixedEdit);

        await vscode.commands.executeCommand('vscode.diff',
            originalUri,
            fixedUri,
            'AI Fix Preview: Original ↔ Fixed'
        );

        const result = await vscode.window.showInformationMessage(
            'Apply this fix?',
            { modal: false },
            'Apply',
            'Cancel'
        );

        // Clean up
        try {
            await vscode.workspace.fs.delete(originalUri);
            await vscode.workspace.fs.delete(fixedUri);
        } catch (error) {
            // Ignore cleanup errors
        }

        return result === 'Apply';
    }

    private async applyFix(document: vscode.TextDocument, range: vscode.Range, fixedCode: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, fixedCode);
        
        const success = await vscode.workspace.applyEdit(edit);
        
        if (success) {
            vscode.window.setStatusBarMessage('$(check) AI fix applied', 3000);
            
            const undo = await vscode.window.showInformationMessage(
                'Fix applied successfully',
                'Undo'
            );
            
            if (undo === 'Undo') {
                await vscode.commands.executeCommand('undo');
            }
        } else {
            vscode.window.showErrorMessage('Failed to apply AI fix');
        }
    }
}