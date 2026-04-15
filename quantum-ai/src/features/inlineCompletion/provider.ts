// src/features/inlineCompletion/provider.ts
import * as vscode from 'vscode';
import { AIProvider } from '../../providers/aiProvider';

export class QuantumInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debounceTimer: NodeJS.Timeout | undefined;
    private abortController: AbortController | undefined;

    constructor(private aiProvider: AIProvider) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {
        
        const config = vscode.workspace.getConfiguration('quantum-ai');
        const enabled = config.get('completionEnabled', true) as boolean;
        
        if (!enabled) {
            return null;
        }

        // Cancel previous request
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const prefixRange = new vscode.Range(new vscode.Position(0, 0), position);
        const codePrefix = document.getText(prefixRange);
        if (codePrefix.trim().length < 10) {
            return null;
        }

        // Debounce to avoid too many requests
        const debounceDelay = (config.get('debounceDelay', 300) as number);
        
        return new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(async () => {
                try {
                    const completion = await this.aiProvider.complete(codePrefix, document.languageId);
                    const cleanedCompletion = this.cleanCompletion(completion);

                    if (!cleanedCompletion || token.isCancellationRequested) {
                        resolve(null);
                        return;
                    }

                    const item = new vscode.InlineCompletionItem(
                        cleanedCompletion,
                        new vscode.Range(position, position)
                    );

                    resolve([item]);

                } catch (error) {
                    console.error('Inline completion error:', error);
                    resolve(null);
                }
            }, debounceDelay);
        });
    }

    private cleanCompletion(completion: string): string {
        if (!completion) {
            return '';
        }

        let cleaned = completion.trim();
        cleaned = cleaned.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');
        return cleaned;
    }
}
