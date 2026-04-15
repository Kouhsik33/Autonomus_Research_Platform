// src/features/transpile/command.ts
import * as vscode from 'vscode';
import { AIProvider } from '../../providers/aiProvider';
import { QuantumHubApiService } from '../../services/apiService';
import { TranspilationRequest, TranspilationResponse, ClientContext } from '../../types/api';
import { getClientContext } from '../../utils/clientContext';

interface FrameworkQuickPickItem extends vscode.QuickPickItem {
    framework: string;
    status: 'stable' | 'beta';
}

export class TranspileCommand {
    private api: QuantumHubApiService;
    private supportedConversions: Array<{from: string, to: string, status: string}> = [];

    constructor(
        private aiProvider: AIProvider,
        private outputChannel: vscode.OutputChannel,
        private context: vscode.ExtensionContext
    ) {
        this.api = new QuantumHubApiService();
        this.loadSupportedConversions();
    }

    private async loadSupportedConversions() {
        try {
            const response = await this.api.getSupportedConversions();
            this.supportedConversions = response.conversions;
            this.outputChannel.appendLine(`Loaded ${this.supportedConversions.length} supported conversions`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to load supported conversions: ${error}`);
            // Fallback defaults
            this.supportedConversions = [
                {from: "qiskit", to: "pennylane", status: "stable"},
                {from: "qiskit", to: "cirq", status: "stable"},
                {from: "pennylane", to: "qiskit", status: "stable"},
                {from: "pennylane", to: "cirq", status: "beta"},
                {from: "cirq", to: "qiskit", status: "stable"},
                {from: "cirq", to: "pennylane", status: "beta"},
                {from: "qiskit", to: "torchquantum", status: "beta"},
                {from: "pennylane", to: "torchquantum", status: "beta"},
                {from: "cirq", to: "torchquantum", status: "beta"},
                {from: "jsx", to: "tsx", status: "stable"},
                {from: "tsx", to: "jsx", status: "stable"},
            ];
        }
    }

    async execute() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        // Get selected code or entire document
        const selection = editor.selection;
        const sourceCode = selection.isEmpty 
            ? editor.document.getText()
            : editor.document.getText(selection);

        if (!sourceCode || sourceCode.trim().length === 0) {
            vscode.window.showErrorMessage('No code selected to transpile');
            return;
        }

        try {
            // Detect source framework
            const sourceFramework = await this.detectFramework(sourceCode, editor.document.languageId);
            
            if (!sourceFramework) {
                return; // User cancelled
            }

            // Get available target frameworks for this source
            const availableTargets = this.getAvailableTargets(sourceFramework);
            
            if (availableTargets.length === 0) {
                vscode.window.showErrorMessage(`No supported conversions from ${sourceFramework}`);
                return;
            }

            // Let user select target framework
            const targetFramework = await this.selectTargetFramework(sourceFramework, availableTargets);
            
            if (!targetFramework) {
                return; // User cancelled
            }

            // Show progress indicator
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Transpiling from ${sourceFramework} to ${targetFramework}...`,
                cancellable: true
            }, async (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => {
                token.onCancellationRequested(() => {
                    throw new Error('Cancelled');
                });

                return await this.transpileCode(
                    sourceCode, 
                    sourceFramework, 
                    targetFramework,
                    editor.document
                );
            });

            if (!result) {
                return;
            }

            // Show result options
            await this.showResultOptions(
                sourceCode, 
                result.transpiled_code,
                sourceFramework,
                targetFramework,
                result
            );

        } catch (error) {
            if (error instanceof Error && error.message === 'Cancelled') {
                vscode.window.showInformationMessage('Transpilation cancelled');
            } else {
                vscode.window.showErrorMessage(`Transpilation failed: ${error instanceof Error ? error.message : String(error)}`);
                this.outputChannel.appendLine(`Transpilation error: ${error}`);
            }
        }
    }

    private async detectFramework(code: string, language: string): Promise<string | undefined> {
        if (language === 'javascriptreact') {
            return 'jsx';
        }
        if (language === 'typescriptreact') {
            return 'tsx';
        }
        if (language !== 'python') {
            return this.showFrameworkSelection('Select source framework', undefined);
        }

        // Auto-detect from imports
        if (code.includes('from qiskit') || code.includes('import qiskit')) {
            return 'qiskit';
        } else if (code.includes('import pennylane') || code.includes('from pennylane')) {
            return 'pennylane';
        } else if (code.includes('import cirq') || code.includes('from cirq')) {
            return 'cirq';
        } else if (code.includes('import torchquantum') || code.includes('from torchquantum')) {
            return 'torchquantum';
        }

        // If can't detect, ask user
        return this.showFrameworkSelection('Could not detect framework. Select source framework:', undefined);
    }

    private getAvailableTargets(sourceFramework: string): FrameworkQuickPickItem[] {
        const targets = this.supportedConversions
            .filter(c => c.from === sourceFramework)
            .map(c => ({
                label: this.getFrameworkLabel(c.to),
                description: this.getFrameworkDescription(c.to),
                detail: `Status: ${c.status} - ${this.getFrameworkDetail(c.to)}`,
                framework: c.to,
                status: c.status as 'stable' | 'beta'
            }));

        // Sort stable first, then beta
        return targets.sort((a, b) => {
            if (a.status === 'stable' && b.status === 'beta') return -1;
            if (a.status === 'beta' && b.status === 'stable') return 1;
            return 0;
        });
    }

    private getFrameworkLabel(framework: string): string {
        const labels: Record<string, string> = {
            'qiskit': '$(hubot) Qiskit',
            'pennylane': '$(graph) PennyLane',
            'cirq': '$(circuit-board) Cirq',
            'torchquantum': '$(flame) TorchQuantum',
            'jsx': '$(code) JSX',
            'tsx': '$(code) TSX',
        };
        return labels[framework] || framework;
    }

    private getFrameworkDescription(framework: string): string {
        const descriptions: Record<string, string> = {
            'qiskit': 'IBM Quantum SDK',
            'pennylane': 'Xanadu - Quantum ML',
            'cirq': 'Google Quantum',
            'torchquantum': 'PyTorch Quantum',
            'jsx': 'React JavaScript',
            'tsx': 'React TypeScript',
        };
        return descriptions[framework] || '';
    }

    private getFrameworkDetail(framework: string): string {
        const details: Record<string, string> = {
            'qiskit': 'Most widely used, great for circuits',
            'pennylane': 'Best for hybrid quantum-classical ML',
            'cirq': 'Good for NISQ algorithms',
            'torchquantum': 'Integrates with PyTorch ecosystem',
            'jsx': 'Convert JSX components to TSX with type annotations',
            'tsx': 'Convert TSX components to JSX by removing TS types',
        };
        return details[framework] || '';
    }

    private async showFrameworkSelection(
        placeHolder: string, 
        excludeFramework?: string
    ): Promise<string | undefined> {
        const frameworks: FrameworkQuickPickItem[] = [
            {
                label: "$(hubot) Qiskit",
                description: "IBM Quantum SDK",
                detail: "Most widely used, great for circuits",
                framework: "qiskit",
                status: "stable"
            },
            {
                label: "$(graph) PennyLane",
                description: "Xanadu - Quantum ML",
                detail: "Best for hybrid quantum-classical ML",
                framework: "pennylane",
                status: "stable"
            },
            {
                label: "$(circuit-board) Cirq",
                description: "Google Quantum",
                detail: "Good for NISQ algorithms",
                framework: "cirq",
                status: "stable"
            },
            {
                label: "$(flame) TorchQuantum",
                description: "PyTorch Quantum",
                detail: "Integrates with PyTorch ecosystem",
                framework: "torchquantum",
                status: "beta"
            },
            {
                label: "$(code) JSX",
                description: "React JavaScript",
                detail: "Convert React JSX components",
                framework: "jsx",
                status: "stable"
            },
            {
                label: "$(code) TSX",
                description: "React TypeScript",
                detail: "Convert React TSX components",
                framework: "tsx",
                status: "stable"
            }
        ];

        const filtered = excludeFramework 
            ? frameworks.filter(f => f.framework !== excludeFramework)
            : frameworks;

        const selected = await vscode.window.showQuickPick(filtered, {
            placeHolder,
            title: "Quantum Framework Selection"
        });

        return selected?.framework;
    }

    private async selectTargetFramework(
        sourceFramework: string,
        availableTargets: FrameworkQuickPickItem[]
    ): Promise<string | undefined> {
        const selected = await vscode.window.showQuickPick(availableTargets, {
            placeHolder: `Select target framework (source: ${sourceFramework})`,
            title: 'Transpile Code'
        });

        return selected?.framework;
    }

    private async transpileCode(
        sourceCode: string, 
        sourceFramework: string, 
        targetFramework: string,
        document: vscode.TextDocument
    ): Promise<TranspilationResponse | null> {
        try {
            // Get runtime preferences from settings
            const config = vscode.workspace.getConfiguration('quantum-ai');
            const runtimePreferences = {
                preferred_runtime: config.get('preferredRuntime'),
                compatibility_level: config.get('compatibilityLevel', 'balanced')
            };

            const request: TranspilationRequest = {
                source_code: sourceCode,
                source_framework: sourceFramework,
                target_framework: targetFramework,
                preserve_comments: true,
                optimize: config.get('optimizeOnTranspile', false),
                client_context: getClientContext(this.context),
                runtime_preferences: runtimePreferences
            };

            const response = await this.api.transpileCode(request);

            // Log warnings
            if (response.warnings.length > 0) {
                this.outputChannel.appendLine('Transpilation warnings:');
                response.warnings.forEach(w => this.outputChannel.appendLine(`- ${w}`));
                
                if (response.warnings.length > 0) {
                    const showWarnings = await vscode.window.showWarningMessage(
                        `Transpilation completed with ${response.warnings.length} warning(s)`,
                        'Show Details',
                        'Continue'
                    );
                    
                    if (showWarnings === 'Show Details') {
                        this.outputChannel.show();
                    }
                }
            }

            // Show validation status
            if (!response.validation_passed) {
                const validationErrors = response.metadata?.validation_errors || [];
                if (validationErrors.length > 0) {
                    const viewErrors = await vscode.window.showWarningMessage(
                        'Transpiled code failed validation',
                        'View Errors',
                        'Show Anyway'
                    );
                    
                    if (viewErrors === 'View Errors') {
                        this.outputChannel.appendLine('Validation errors:');
                        validationErrors.forEach((e: string) => this.outputChannel.appendLine(`- ${e}`));
                        this.outputChannel.show();
                    }
                    
                    if (viewErrors !== 'Show Anyway') {
                        return null;
                    }
                }
            }

            // Show modernization info if applied
            if (response.metadata?.modernization_applied) {
                vscode.window.showInformationMessage(
                    `✨ Code modernized: ${response.metadata.modernization_before_deprecations} deprecated patterns fixed`
                );
            }

            return response;

        } catch (error) {
            this.outputChannel.appendLine(`API Error: ${error}`);
            throw error;
        }
    }

    private async showResultOptions(
        originalCode: string,
        transpiledCode: string,
        sourceFramework: string,
        targetFramework: string,
        response: TranspilationResponse
    ) {
        const validationStatus = response.validation_passed ? '✅' : '⚠️';
        const modernizationStatus = response.metadata?.modernization_applied ? '✨' : '';
        
        const actions = [
            'Show Diff',
            'Replace Selection',
            'Open in New Editor',
            'Copy to Clipboard',
            'Show Details',
            'Cancel'
        ];

        const selection = await vscode.window.showInformationMessage(
            `${modernizationStatus} Transpiled from ${sourceFramework} to ${targetFramework} ${validationStatus}`,
            ...actions
        );

        switch (selection) {
            case 'Show Diff':
                await this.showDiff(originalCode, transpiledCode, sourceFramework, targetFramework);
                break;
            case 'Replace Selection':
                await this.replaceSelection(transpiledCode);
                break;
            case 'Open in New Editor':
                await this.openInNewEditor(transpiledCode, targetFramework);
                break;
            case 'Copy to Clipboard':
                await vscode.env.clipboard.writeText(transpiledCode);
                vscode.window.showInformationMessage('Transpiled code copied to clipboard');
                break;
            case 'Show Details':
                await this.showTranspilationDetails(response);
                break;
        }
    }

    private async showDiff(
        original: string, 
        transpiled: string,
        sourceFramework: string,
        targetFramework: string
    ) {
        const originalExt = sourceFramework === 'jsx' ? 'jsx' : sourceFramework === 'tsx' ? 'tsx' : 'py';
        const targetExt = targetFramework === 'jsx' ? 'jsx' : targetFramework === 'tsx' ? 'tsx' : 'py';
        const originalUri = vscode.Uri.parse(`untitled:${sourceFramework}_original.${originalExt}`);
        const transpiledUri = vscode.Uri.parse(`untitled:${targetFramework}_transpiled.${targetExt}`);

        // Create temporary documents
        const originalDoc = await vscode.workspace.openTextDocument(originalUri);
        const transpiledDoc = await vscode.workspace.openTextDocument(transpiledUri);

        // Write content
        const originalEdit = new vscode.WorkspaceEdit();
        originalEdit.insert(originalUri, new vscode.Position(0, 0), original);
        await vscode.workspace.applyEdit(originalEdit);

        const transpiledEdit = new vscode.WorkspaceEdit();
        transpiledEdit.insert(transpiledUri, new vscode.Position(0, 0), transpiled);
        await vscode.workspace.applyEdit(transpiledEdit);

        // Show diff
        await vscode.commands.executeCommand('vscode.diff',
            originalUri,
            transpiledUri,
            `Transpilation: ${sourceFramework} → ${targetFramework}`
        );
    }

    private async replaceSelection(transpiledCode: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const range = selection.isEmpty 
            ? new vscode.Range(0, 0, editor.document.lineCount, 0)
            : selection;

        const edit = new vscode.WorkspaceEdit();
        edit.replace(editor.document.uri, range, transpiledCode);

        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            vscode.window.setStatusBarMessage('$(check) Transpiled code inserted', 3000);
        }
    }

    private async openInNewEditor(transpiledCode: string, framework: string) {
        const ext = framework === 'jsx' ? 'jsx' : framework === 'tsx' ? 'tsx' : 'py';
        const uri = vscode.Uri.parse(`untitled:transpiled_${framework}.${ext}`);
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), transpiledCode);
        await vscode.workspace.applyEdit(edit);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        vscode.window.setStatusBarMessage(`$(check) Opened transpiled ${framework} code`, 3000);
    }

    private async showTranspilationDetails(response: TranspilationResponse) {
        const metadata = response.metadata;
        
        const details = [
            `## Transpilation Details`,
            `**Source:** ${response.source_framework} → **Target:** ${response.target_framework}`,
            `**Success:** ${response.success}`,
            `**Validation:** ${response.validation_passed ? '✅ Passed' : '❌ Failed'}`,
            ``,
            `### Performance`,
            `**Latency:** ${metadata.latency_ms}ms`,
            `**Method:** ${metadata.method}`,
            `**Tokens Used:** ${metadata.tokens_used}`,
            `**LLM Provider:** ${metadata.llm_provider || 'N/A'}`,
            `**Model:** ${metadata.llm_model || 'N/A'}`,
            ``,
        ];

        if (metadata.modernization_attempted) {
            details.push(
                `### Modernization`,
                `**Applied:** ${metadata.modernization_applied}`,
                `**Deprecations Fixed:** ${metadata.modernization_before_deprecations} → ${metadata.modernization_after_deprecations}`,
                `**Reason:** ${metadata.modernization_reason || 'N/A'}`,
                `**Modernization Tokens:** ${metadata.modernization_tokens_used}`,
                ``
            );
        }

        if (response.warnings.length > 0) {
            details.push(
                `### Warnings`,
                ...response.warnings.map(w => `- ${w}`),
                ``
            );
        }

        if (metadata.validation_errors?.length > 0) {
            details.push(
                `### Validation Errors`,
                ...metadata.validation_errors.map((e: string) => `- ${e}`),
                ``
            );
        }

        details.push(
            `### Runtime Requirements`,
            `**Target:** ${JSON.stringify(metadata.runtime_requirements, null, 2)}`,
            ``,
            `### Recommendations`,
            ...(metadata.runtime_recommendations || []).map((r: string) => `- ${r}`)
        );

        // Create and show webview with details
        const panel = vscode.window.createWebviewPanel(
            'transpilationDetails',
            'Transpilation Details',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = this.getDetailsWebviewContent(details.join('\n'));
    }

    private getDetailsWebviewContent(content: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        font-family: var(--vscode-editor-font-family);
                        padding: 20px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        line-height: 1.6;
                    }
                    h1, h2, h3 {
                        color: var(--vscode-editor-foreground);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding-bottom: 8px;
                    }
                    pre {
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 12px;
                        border-radius: 4px;
                        overflow-x: auto;
                    }
                    .success { color: #89d185; }
                    .warning { color: #cca700; }
                    .error { color: #f48771; }
                </style>
            </head>
            <body>
                <pre>${content}</pre>
            </body>
            </html>
        `;
    }
}
