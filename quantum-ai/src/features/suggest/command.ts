// src/features/suggest/command.ts
import * as vscode from 'vscode';
import { AIProvider} from '../../providers/aiProvider';
import { SuggestionResult } from '../../providers/quantumHubProvider';

export class SuggestCommand {
    constructor(
        private aiProvider: AIProvider,
        private outputChannel: vscode.OutputChannel
    ) {}

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const selectedText = selection.isEmpty 
            ? editor.document.getText()
            : editor.document.getText(selection);
        
        if (!selectedText.trim()) {
            vscode.window.showWarningMessage('No code selected to improve');
            return;
        }

        const languageId = editor.document.languageId;
        
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '🔮 AI: Generating improvements...',
                cancellable: true   
            }, async (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => {
                token.onCancellationRequested(() => {
                    throw new Error('Cancelled');
                });

                progress.report({ message: 'Analyzing code...', increment: 20 });
                
                // Small delay to show progress
                await new Promise(resolve => setTimeout(resolve, 500));
                
                progress.report({ message: 'Applying optimizations...', increment: 40 });
                
                const suggestion = await this.aiProvider.suggest(selectedText, languageId);
                
                progress.report({ message: 'Formatting results...', increment: 30 });
                
                return suggestion;
            });

            if (!result) {
                return;
            }

            await this.showSuggestionsInWebview(result, selectedText, languageId);

        } catch (error) {
            if (error instanceof Error && error.message === 'Cancelled') {
                vscode.window.showInformationMessage('Suggestions cancelled');
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to get suggestions: ${errorMessage}`);
                this.outputChannel.appendLine(`[Suggest Command Error] ${errorMessage}`);
                
                // Show error in output channel
                this.outputChannel.show();
            }
        }
    }

    private async showSuggestionsInWebview(
        suggestion: SuggestionResult, 
        originalCode: string, 
        language: string
    ): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'quantumAISuggestions',
            '✨ Quantum AI Code Improvements',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
                enableCommandUris: true
            }
        );

        panel.webview.html = this.getWebviewContent(suggestion, originalCode, language, panel.webview);

        panel.webview.onDidReceiveMessage(async (message: any) => {
            switch (message.command) {
                case 'applySuggestion':
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        const success = await this.applySuggestion(editor, message.code);
                        if (success) {
                            vscode.window.showInformationMessage('✅ Suggestion applied successfully!');
                            // Close panel after successful apply
                            setTimeout(() => panel.dispose(), 1500);
                        }
                    }
                    break;
                    
                case 'copyCode':
                    await vscode.env.clipboard.writeText(message.code);
                    vscode.window.showInformationMessage('📋 Code copied to clipboard');
                    break;
                    
                case 'copyExplanation':
                    await vscode.env.clipboard.writeText(message.explanation);
                    vscode.window.showInformationMessage('📋 Explanation copied to clipboard');
                    break;
                    
                case 'copyAll':
                    const framework = this.detectFramework(originalCode);
                    const fullText = `# Quantum AI Code Improvements (${framework})\n\n## Improved Code\n\`\`\`python\n${suggestion.code}\n\`\`\`\n\n## Explanation\n${suggestion.explanation}`;
                    await vscode.env.clipboard.writeText(fullText);
                    vscode.window.showInformationMessage('📋 Full suggestion copied to clipboard');
                    break;
                    
                case 'openInNewFile':
                    await this.openInNewFile(suggestion.code, language);
                    vscode.window.showInformationMessage('📄 Opened in new file');
                    break;
                    
                case 'compareWithOriginal':
                    await this.showDiff(originalCode, suggestion.code, language);
                    break;
                    
                case 'close':
                    panel.dispose();
                    break;
            }
        });
    }

    private getWebviewContent(
        suggestion: SuggestionResult, 
        originalCode: string, 
        language: string,
        webview: vscode.Webview
    ): string {
        // Escape for HTML
        const escapeHtml = (text: string) => {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')
                .replace(/\n/g, '&#10;');
        };

        // For displaying in pre tags, we need a different escaping
        const escapeForPre = (text: string) => {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        };

        const escapedOriginalCode = escapeForPre(originalCode);
        const escapedSuggestionCode = escapeForPre(suggestion.code);
        const escapedExplanation = this.formatExplanationWithMath(suggestion.explanation);

        const framework = this.detectFramework(originalCode);
        const lineDiff = this.calculateLineDiff(originalCode, suggestion.code);
        const improvementCount = this.countImprovements(suggestion.explanation);
        const charCount = suggestion.code.length;
        const lineCount = suggestion.code.split('\n').length;

         const getCssVar = (property: string, fallback: string): string => {
        // This will be called in the webview context
        return `var(${property}, ${fallback})`;
    };

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Quantum AI Code Improvements</title>
            <script>
                window.MathJax = {
                    tex: {
                        inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                        displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
                        processEscapes: true,
                        processEnvironments: true
                    },
                    options: {
                        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
                    }
                };
            </script>
            <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
            <style>
                :root {
                   --vscode-editor-font-family: ${getCssVar('--vscode-editor-font-family', 'Consolas, "Courier New", monospace')};
                --vscode-editor-font-size: ${getCssVar('--vscode-editor-font-size', '14px')};
                --vscode-editor-foreground: ${getCssVar('--vscode-editor-foreground', '#d4d4d4')};
                --vscode-editor-background: ${getCssVar('--vscode-editor-background', '#1e1e1e')};
                --vscode-button-background: ${getCssVar('--vscode-button-background', '#0e639c')};
                --vscode-button-hoverBackground: ${getCssVar('--vscode-button-hoverBackground', '#1177bb')};
                --vscode-button-foreground: ${getCssVar('--vscode-button-foreground', '#ffffff')};
                --vscode-panel-border: ${getCssVar('--vscode-panel-border', '#3e3e42')};
                --vscode-textCodeBlock-background: ${getCssVar('--vscode-textCodeBlock-background', '#2d2d30')};
                --vscode-badge-background: ${getCssVar('--vscode-badge-background', '#4d4d4d')};
                --vscode-badge-foreground: ${getCssVar('--vscode-badge-foreground', '#ffffff')};
                --vscode-input-background: ${getCssVar('--vscode-input-background', '#3c3c3c')};
                --vscode-input-foreground: ${getCssVar('--vscode-input-foreground', '#cccccc')};
                --vscode-input-border: ${getCssVar('--vscode-input-border', '#3c3c3c')};
                }

                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    padding: 0;
                    margin: 0;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                    line-height: 1.6;
                }

                .container {
                    max-width: 1400px;
                    margin: 0 auto;
                    padding: 24px;
                }

                /* Header Styles */
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 24px;
                    padding-bottom: 16px;
                    border-bottom: 2px solid var(--vscode-panel-border);
                    flex-wrap: wrap;
                    gap: 16px;
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    flex-wrap: wrap;
                }

                .header h1 {
                    margin: 0;
                    font-size: 24px;
                    font-weight: 600;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }

                .badge-container {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }

                .badge {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 4px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 500;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }

                .badge.primary {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                }

                /* Stats Bar */
                .stats-bar {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 16px;
                    padding: 16px 20px;
                    background-color: rgba(255, 255, 255, 0.03);
                    border-radius: 12px;
                    margin: 20px 0;
                }

                .stat {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .stat-icon {
                    font-size: 20px;
                    opacity: 0.8;
                }

                .stat-content {
                    display: flex;
                    flex-direction: column;
                }

                .stat-label {
                    font-size: 11px;
                    opacity: 0.7;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .stat-value {
                    font-weight: 600;
                    font-size: 16px;
                }

                .stat-value.positive {
                    color: #4caf50;
                }

                .stat-value.negative {
                    color: #f44336;
                }

                /* Content Grid */
                .content {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 24px;
                    margin-bottom: 24px;
                }

                /* Section Styles */
                .section {
                    background-color: var(--vscode-textCodeBlock-background);
                    border-radius: 12px;
                    overflow: hidden;
                    border: 1px solid var(--vscode-panel-border);
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }

                .section-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 12px 16px;
                    background-color: rgba(255, 255, 255, 0.05);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .section-header h2 {
                    margin: 0;
                    font-size: 14px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    opacity: 0.9;
                }

                .section-header .icon {
                    font-size: 16px;
                }

                .button-group {
                    display: flex;
                    gap: 6px;
                    flex-wrap: wrap;
                }

                /* Button Styles */
                .btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-family: inherit;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                }

                .btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                }

                .btn:active {
                    transform: translateY(0);
                }

                .btn-outline {
                    background-color: transparent;
                    border: 1px solid var(--vscode-button-background);
                }

                .btn-outline:hover {
                    background-color: var(--vscode-button-background);
                }

                .btn-sm {
                    padding: 4px 8px;
                    font-size: 11px;
                }

                .btn-icon {
                    padding: 6px;
                    gap: 0;
                }

                /* Code Container */
                .code-container {
                    padding: 16px;
                    max-height: 500px;
                    overflow: auto;
                    position: relative;
                }

        pre {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            white-space: pre-wrap;
            word-wrap: break-word;
            tab-size: 4;
        }

        code {
            font-family: inherit;
        }

        /* Line Numbers (optional - can be added) */
        .code-with-lines {
            counter-reset: line;
        }

        .code-line {
            counter-increment: line;
            display: block;
        }

        .code-line::before {
            content: counter(line);
            display: inline-block;
            width: 30px;
            padding-right: 12px;
            text-align: right;
            color: var(--vscode-editor-foreground);
            opacity: 0.5;
            font-size: 0.9em;
        }

        /* Explanation Section */
        .explanation-section {
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 12px;
            border: 1px solid var(--vscode-panel-border);
            margin-top: 24px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .explanation-content {
            padding: 20px;
            line-height: 1.8;
        }

        .explanation-content h1 {
            font-size: 1.5em;
            margin: 1em 0 0.5em;
            color: var(--vscode-editor-foreground);
        }

        .explanation-content h2 {
            font-size: 1.3em;
            margin: 1em 0 0.5em;
            opacity: 0.9;
        }

        .explanation-content h3 {
            font-size: 1.1em;
            margin: 1em 0 0.5em;
            opacity: 0.8;
        }

        .explanation-content p {
            margin: 0 0 1em 0;
        }

        .explanation-content ul, .explanation-content ol {
            margin: 0.5em 0 1em 1.5em;
        }

        .explanation-content li {
            margin: 0.3em 0;
        }

        .explanation-content code {
            background-color: rgba(255, 255, 255, 0.1);
            padding: 0.2em 0.4em;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }

        .explanation-content pre {
            background-color: rgba(0, 0, 0, 0.3);
            padding: 1em;
            border-radius: 6px;
            overflow-x: auto;
            margin: 1em 0;
        }

        /* Footer Actions */
        .footer-actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-wrap: wrap;
        }

        /* Diff Highlighting */
        .diff-added {
            background-color: rgba(76, 175, 80, 0.2);
            border-left: 3px solid #4caf50;
            padding-left: 8px;
        }

        .diff-removed {
            background-color: rgba(244, 67, 54, 0.2);
            border-left: 3px solid #f44336;
            padding-left: 8px;
        }

        /* Loading State */
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: var(--vscode-button-background);
            animation: spin 1s ease-in-out infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Toast Notifications */
        .toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--vscode-panel-border);
            z-index: 1000;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }

        /* Responsive Design */
        @media (max-width: 768px) {
            .container {
                padding: 16px;
            }

            .content {
                grid-template-columns: 1fr;
            }

            .header {
                flex-direction: column;
                align-items: flex-start;
            }

            .stats-bar {
                grid-template-columns: 1fr;
            }

            .button-group {
                width: 100%;
                justify-content: flex-start;
            }

            .footer-actions {
                justify-content: center;
            }
        }

        /* Tooltips */
        [data-tooltip] {
            position: relative;
            cursor: help;
        }

        [data-tooltip]:before {
            content: attr(data-tooltip);
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 11px;
            white-space: nowrap;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
            z-index: 1000;
        }

        [data-tooltip]:hover:before {
            opacity: 1;
            visibility: visible;
        }

        /* Custom Scrollbar */
        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        ::-webkit-scrollbar-track {
            background: var(--vscode-editor-background);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--vscode-panel-border);
            border-radius: 5px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-button-background);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="header-left">
                <h1>✨ Quantum AI Code Improvements</h1>
                <div class="badge-container">
                    <span class="badge primary">
                        <span>⚛️</span> ${framework}
                    </span>
                    <span class="badge" data-tooltip="Programming Language">
                        <span>📄</span> ${language}
                    </span>
                </div>
            </div>
            <div class="button-group">
                <button class="btn-outline btn-sm" onclick="closePanel()" data-tooltip="Close (Esc)">
                    <span>✕</span> Close
                </button>
            </div>
        </div>

        <!-- Stats Bar -->
        <div class="stats-bar">
            <div class="stat">
                <span class="stat-icon">📊</span>
                <div class="stat-content">
                    <span class="stat-label">Lines Changed</span>
                    <span class="stat-value ${lineDiff.startsWith('+') ? 'positive' : lineDiff.startsWith('-') ? 'negative' : ''}">
                        ${lineDiff}
                    </span>
                </div>
            </div>
            <div class="stat">
                <span class="stat-icon">✨</span>
                <div class="stat-content">
                    <span class="stat-label">Improvements</span>
                    <span class="stat-value">${improvementCount}</span>
                </div>
            </div>
            <div class="stat">
                <span class="stat-icon">📏</span>
                <div class="stat-content">
                    <span class="stat-label">Lines of Code</span>
                    <span class="stat-value">${lineCount}</span>
                </div>
            </div>
            <div class="stat">
                <span class="stat-icon">📝</span>
                <div class="stat-content">
                    <span class="stat-label">Characters</span>
                    <span class="stat-value">${charCount.toLocaleString()}</span>
                </div>
            </div>
        </div>

        <!-- Main Content -->
        <div class="content">
            <!-- Original Code -->
            <div class="section">
                <div class="section-header">
                    <h2>
                        <span class="icon">📄</span>
                        Original Code
                    </h2>
                    <div class="button-group">
                        <button class="btn-outline btn-sm" onclick="copyOriginal()" data-tooltip="Copy original code">
                            📋 Copy
                        </button>
                    </div>
                </div>
                <div class="code-container">
                    <pre><code>${escapedOriginalCode}</code></pre>
                </div>
            </div>

            <!-- Improved Code -->
            <div class="section">
                <div class="section-header">
                    <h2>
                        <span class="icon">✨</span>
                        Improved Code
                    </h2>
                    <div class="button-group">
                        <button class="btn btn-sm" onclick="applySuggestion()" data-tooltip="Apply to current editor (Ctrl+Enter)">
                            🔧 Apply
                        </button>
                        <button class="btn-outline btn-sm" onclick="copySuggestion()" data-tooltip="Copy improved code">
                            📋 Copy
                        </button>
                        <button class="btn-outline btn-sm" onclick="openInNewFile()" data-tooltip="Open in new file">
                            📄 New
                        </button>
                        <button class="btn-outline btn-sm" onclick="compareWithOriginal()" data-tooltip="Compare with original">
                            🔍 Diff
                        </button>
                    </div>
                </div>
                <div class="code-container">
                    <pre><code>${escapedSuggestionCode}</code></pre>
                </div>
            </div>
        </div>

        <!-- Explanation Section -->
        <div class="explanation-section">
            <div class="section-header">
                <h2>
                    <span class="icon">💡</span>
                    Explanation of Improvements
                </h2>
                <div class="button-group">
                    <button class="btn-outline btn-sm" onclick="copyExplanation()" data-tooltip="Copy explanation">
                        📋 Copy
                    </button>
                    <button class="btn-outline btn-sm" onclick="copyAll()" data-tooltip="Copy everything">
                        📋 Copy All
                    </button>
                </div>
            </div>
            <div class="explanation-content">
                ${escapedExplanation}
            </div>
        </div>

        <!-- Footer Actions -->
        <div class="footer-actions">
            <button class="btn-outline" onclick="copyAll()">
                📋 Copy All
            </button>
            <button class="btn-outline" onclick="openInNewFile()">
                📄 Open in New File
            </button>
            <button class="btn-outline" onclick="compareWithOriginal()">
                🔍 Compare with Original
            </button>
            <button class="btn" onclick="applySuggestion()">
                🔧 Apply Changes
            </button>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const suggestion = ${JSON.stringify(suggestion)};
            const originalCode = ${JSON.stringify(originalCode)};

            // Store state
            vscode.setState({ suggestion, originalCode });

            // Helper function to show toast
            function showToast(message, type = 'info') {
                const toast = document.createElement('div');
                toast.className = 'toast';
                toast.textContent = message;
                document.body.appendChild(toast);
                
                setTimeout(() => {
                    toast.remove();
                }, 3000);
            }

            // Message handlers
            window.applySuggestion = function() {
                vscode.postMessage({ 
                    command: 'applySuggestion', 
                    code: suggestion.code 
                });
                showToast('Applying suggestion...', 'info');
            };

            window.copySuggestion = function() {
                vscode.postMessage({ 
                    command: 'copyCode', 
                    code: suggestion.code 
                });
                showToast('Code copied to clipboard!', 'success');
            };

            window.copyOriginal = function() {
                vscode.postMessage({ 
                    command: 'copyCode', 
                    code: originalCode 
                });
                showToast('Original code copied to clipboard!', 'success');
            };

            window.copyExplanation = function() {
                vscode.postMessage({ 
                    command: 'copyExplanation', 
                    explanation: suggestion.explanation 
                });
                showToast('Explanation copied to clipboard!', 'success');
            };

            window.copyAll = function() {
                vscode.postMessage({ 
                    command: 'copyAll' 
                });
                showToast('Full suggestion copied to clipboard!', 'success');
            };

            window.openInNewFile = function() {
                vscode.postMessage({ 
                    command: 'openInNewFile', 
                    code: suggestion.code 
                });
            };

            window.compareWithOriginal = function() {
                vscode.postMessage({ 
                    command: 'compareWithOriginal' 
                });
            };

            window.closePanel = function() {
                vscode.postMessage({ command: 'close' });
            };

            // Keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                // Ctrl+Enter to apply
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    applySuggestion();
                }
                // Ctrl+C to copy code (when no text selected)
                else if (e.ctrlKey && e.key === 'c' && !window.getSelection().toString()) {
                    e.preventDefault();
                    copySuggestion();
                }
                // Escape to close
                else if (e.key === 'Escape') {
                    closePanel();
                }
                // Ctrl+Shift+C to copy explanation
                else if (e.ctrlKey && e.shiftKey && e.key === 'C') {
                    e.preventDefault();
                    copyExplanation();
                }
                // Ctrl+Shift+A to copy all
                else if (e.ctrlKey && e.shiftKey && e.key === 'A') {
                    e.preventDefault();
                    copyAll();
                }
            });

            // Add syntax highlighting (if needed, you can integrate a library like Prism.js)
            console.log('Quantum AI Suggestions panel loaded');
            document.addEventListener('DOMContentLoaded', () => {
                if (window.MathJax?.typesetPromise) {
                    window.MathJax.typesetPromise().catch(() => {});
                }
            });
        })();
    </script>
</body>
</html>`;

        // Helper function to get computed style with fallback
        // Helper function to get computed style with fallback
    const getComputedStyleStyle = (property: string, fallback: string): string => {
        try {
            // In VS Code webview, we need to access document if available
        if (typeof document !== 'undefined') {
            return getComputedStyle(document.body).getPropertyValue(property) || fallback;
        }
            return fallback;
        } catch (error) {
            return fallback;
        }
};
    }

    private formatExplanationWithMath(explanation: string): string {
        const normalized = (explanation || '')
            .replace(/\\\\\(/g, '\\(')
            .replace(/\\\\\)/g, '\\)')
            .replace(/\\\\\[/g, '\\[')
            .replace(/\\\\\]/g, '\\]')
            .replace(/\\\\begin\{/g, '\\begin{')
            .replace(/\\\\end\{/g, '\\end{');

        return normalized
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
    }

    private calculateLineDiff(original: string, improved: string): string {
        const originalLines = original.split('\n').length;
        const improvedLines = improved.split('\n').length;
        const diff = improvedLines - originalLines;
        return diff > 0 ? `+${diff}` : diff.toString();
    }

    private countImprovements(explanation: string): number {
        // Simple heuristic to count improvements mentioned
        const improvementIndicators = [
            'improved', 'optimized', 'added', 'fixed', 'enhanced',
            'better', 'using', 'implemented', 'refactored', 'updated',
            'modernized', 'upgraded', 'simplified', 'streamlined'
        ];
        const words = explanation.toLowerCase().split(/\s+/);
        return words.filter(word => improvementIndicators.includes(word)).length;
    }

    private detectFramework(code: string): string {
        const lowerCode = code.toLowerCase();
        if (lowerCode.includes('qiskit')) return 'Qiskit';
        if (lowerCode.includes('pennylane')) return 'PennyLane';
        if (lowerCode.includes('cirq')) return 'Cirq';
        if (lowerCode.includes('torchquantum')) return 'TorchQuantum';
        if (lowerCode.includes('quil') || lowerCode.includes('pyquil')) return 'pyQuil';
        if (lowerCode.includes('braket')) return 'Amazon Braket';
        if (lowerCode.includes('qsharp')) return 'Q#';
        return 'Quantum';
    }

    private async applySuggestion(editor: vscode.TextEditor, code: string): Promise<boolean> {
        try {
            const selection = editor.selection;
            const range = selection.isEmpty 
                ? new vscode.Range(0, 0, editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length)
                : selection;
            
            // Create edit
            const edit = new vscode.WorkspaceEdit();
            edit.replace(editor.document.uri, range, code);
            
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                // Format the document after applying
                await vscode.commands.executeCommand('editor.action.formatDocument');
                
                // Save the document if auto-save is enabled
                const config = vscode.workspace.getConfiguration('quantum-ai');
                if (config.get('autoSaveAfterApply', false)) {
                    await editor.document.save();
                }
            }
            
            return success;
        } catch (error) {
            this.outputChannel.appendLine(`[Apply Suggestion Error] ${error}`);
            return false;
        }
    }

    private async openInNewFile(code: string, language: string): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument({
                content: code,
                language: language
            });
            await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        } catch (error) {
            this.outputChannel.appendLine(`[Open in New File Error] ${error}`);
            vscode.window.showErrorMessage('Failed to open in new file');
        }
    }

    private async showDiff(original: string, improved: string, language: string): Promise<void> {
        try {
            const originalUri = vscode.Uri.parse('untitled:Original Code');
            const improvedUri = vscode.Uri.parse('untitled:Improved Code');
            
            const originalDoc = await vscode.workspace.openTextDocument(originalUri);
            const improvedDoc = await vscode.workspace.openTextDocument(improvedUri);
            
            const originalEdit = new vscode.WorkspaceEdit();
            originalEdit.insert(originalUri, new vscode.Position(0, 0), original);
            await vscode.workspace.applyEdit(originalEdit);
            
            const improvedEdit = new vscode.WorkspaceEdit();
            improvedEdit.insert(improvedUri, new vscode.Position(0, 0), improved);
            await vscode.workspace.applyEdit(improvedEdit);
            
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                improvedUri,
                'Original ↔ Improved'
            );
        } catch (error) {
            this.outputChannel.appendLine(`[Show Diff Error] ${error}`);
            vscode.window.showErrorMessage('Failed to show diff');
        }
    }
}
