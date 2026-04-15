// src/features/explain/command.ts
import * as vscode from 'vscode';
import { AIProvider } from '../../providers/aiProvider';

export class ExplainCommand {
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
        if (selection.isEmpty) {
            vscode.window.showErrorMessage('Please select some code to explain');
            return;
        }

        const selectedText = editor.document.getText(selection);
        const languageId = editor.document.languageId;
        
        try {
            // Show progress
            const explanation = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '🔮 Quantum AI is analyzing your code...',
                cancellable: true
            }, async (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => {
                token.onCancellationRequested(() => {
                    throw new Error('Cancelled');
                });
                progress.report({ message: 'Understanding quantum concepts...', increment: 30 });
                const result = await this.aiProvider.explain(selectedText, languageId);
                progress.report({ message: 'Formatting explanation...', increment: 70 });
                return result;
            });

            if (!explanation) {
                vscode.window.showErrorMessage('Failed to generate explanation');
                return;
            }

            // Create and show a webview panel
            const panel = vscode.window.createWebviewPanel(
                'quantumAIExplanation',
                '🔬 Quantum AI: Code Explanation',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: []
                }
            );

            panel.webview.html = this.getWebviewContent(selectedText, explanation, languageId, panel.webview);

            // Handle messages from the webview
            panel.webview.onDidReceiveMessage(async (message: any) => {
                switch (message.command) {
                    case 'copyExplanation':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('📋 Explanation copied to clipboard');
                        break;
                    case 'copyCode':
                        await vscode.env.clipboard.writeText(selectedText);
                        vscode.window.showInformationMessage('📋 Code copied to clipboard');
                        break;
                    case 'copyAll':
                        const fullText = `## Code\n\`\`\`python\n${selectedText}\n\`\`\`\n\n## Explanation\n${explanation}`;
                        await vscode.env.clipboard.writeText(fullText);
                        vscode.window.showInformationMessage('📋 Full explanation copied to clipboard');
                        break;
                }
            });

        } catch (error) {
            if (error instanceof Error && error.message === 'Cancelled') {
                vscode.window.showInformationMessage('Explanation cancelled');
            } else {
                const rawErrorMessage = error instanceof Error ? error.message : String(error);
                const normalizedErrorMessage = rawErrorMessage.trim().replace(/:\s*$/, '');
                const friendlyMessage = /^explanation generation failed$/i.test(normalizedErrorMessage)
                    ? 'Failed to get explanation: Unable to generate an explanation right now. Please try again with a clearer quantum-related code selection.'
                    : `Failed to get explanation: ${normalizedErrorMessage || 'Unknown error'}`;

                vscode.window.showErrorMessage(friendlyMessage, { modal: true });
                this.outputChannel.appendLine(`[Explain Command Error] ${rawErrorMessage}`);
            }
        }
    }

    private getWebviewContent(code: string, explanation: string, language: string, webview: vscode.Webview): string {
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const fontFamily = editorConfig.get('fontFamily') || 'Consolas, "Courier New", monospace';
        const fontSize = editorConfig.get('fontSize') + 'px' || '14px';
        
        // MathJax configuration for equation rendering
        // Update the mathJaxConfig to be more robust
const mathJaxConfig = `
    window.MathJax = {
        tex: {
            inlineMath: [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']],
            processEscapes: true,
            processEnvironments: true,
            packages: ['base', 'ams', 'noerrors', 'noundefined']
        },
        options: {
            ignoreHtmlClass: 'tex2jax_ignore',
            processHtmlClass: 'tex2jax_process',
            skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            includeHtmlTags: {br: '\\n', wbr: '', '#comment': ''}
        },
        loader: {
            load: ['[tex]/ams', '[tex]/noerrors', '[tex]/noundefined']
        },
        startup: {
            pageReady: () => {
                return MathJax.startup.defaultPageReady();
            }
        }
    };
`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Quantum AI - Code Explanation</title>
            
            <!-- MathJax configuration -->
            <script>${mathJaxConfig}</script>
            
            <!-- Load MathJax -->
            <script id="MathJax-script" async 
                src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js">
            </script>
            
            <!-- KaTeX as alternative (optional, can be used instead of MathJax) -->
            <!-- <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
            <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
            <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" 
                onload="renderMathInElement(document.body, {delimiters: [{left: '$', right: '$', display: false}, {left: '$$', right: '$$', display: true}]});">
            </script> -->
            
            <style>
                :root {
                    --vscode-editor-font-family: ${fontFamily};
                    --vscode-editor-font-size: ${fontSize};
                }

                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                    font-size: 14px;
                    padding: 24px;
                    color: var(--vscode-editor-foreground);
                    background: var(--vscode-editor-background);
                    line-height: 1.6;
                    max-width: 900px;
                    margin: 0 auto;
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

                .header h1 {
                    margin: 0;
                    font-size: 24px;
                    font-weight: 600;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }

                .badge {
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 4px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 500;
                }

                /* Button Styles */
                .button-group {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                    margin-bottom: 20px;
                }

                .btn {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                }

                .btn:hover {
                    background: var(--vscode-button-hoverBackground);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                }

                .btn-outline {
                    background: transparent;
                    border: 1px solid var(--vscode-button-background);
                }

                .btn-outline:hover {
                    background: var(--vscode-button-background);
                }

                /* Code Block Styles */
                .code-section {
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    margin-bottom: 24px;
                    overflow: hidden;
                }

                .code-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 16px;
                    background: rgba(255, 255, 255, 0.05);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .code-header h3 {
                    margin: 0;
                    font-size: 14px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .code-block {
                    padding: 16px;
                    overflow-x: auto;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    line-height: 1.5;
                }

                .code-block pre {
                    margin: 0;
                    font-family: inherit;
                }

                .code-block code {
                    font-family: inherit;
                }

                /* Explanation Section Styles */
                .explanation-section {
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    overflow: hidden;
                }

                .explanation-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 16px;
                    background: rgba(255, 255, 255, 0.05);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .explanation-header h3 {
                    margin: 0;
                    font-size: 16px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .explanation-content {
                    padding: 24px;
                    font-size: 14px;
                    line-height: 1.8;
                }

                /* Markdown-like styling */
                .explanation-content h1 {
                    font-size: 2em;
                    margin: 1em 0 0.5em;
                    padding-bottom: 0.3em;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .explanation-content h2 {
                    font-size: 1.5em;
                    margin: 1em 0 0.5em;
                }

                .explanation-content h3 {
                    font-size: 1.25em;
                    margin: 1em 0 0.5em;
                }

                .explanation-content p {
                    margin: 0 0 1em 0;
                }

                .explanation-content ul, 
                .explanation-content ol {
                    margin: 0.5em 0 1em 1.5em;
                }

                .explanation-content li {
                    margin: 0.3em 0;
                }

                /* Inline code in explanation */
                .explanation-content code {
                    background: rgba(255, 255, 255, 0.1);
                    padding: 0.2em 0.4em;
                    border-radius: 3px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 0.9em;
                }

                /* Block code in explanation */
                .explanation-content pre {
                    background: rgba(0, 0, 0, 0.3);
                    padding: 1em;
                    border-radius: 6px;
                    overflow-x: auto;
                    margin: 1em 0;
                }

                .explanation-content pre code {
                    background: none;
                    padding: 0;
                }

                /* Math equation styles */
                .explanation-content .math {
                    font-size: 1.1em;
                    overflow-x: auto;
                    overflow-y: hidden;
                    padding: 0.5em 0;
                }

                .explanation-content .math-display {
                    display: block;
                    text-align: center;
                    margin: 1.5em 0;
                    overflow-x: auto;
                    overflow-y: hidden;
                    padding: 0.5em 0;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 6px;
                }

                /* mjx container styles for MathJax */
                mjx-container {
                    font-size: 1.1em;
                    padding: 0.2em 0;
                }

                mjx-container[display="true"] {
                    display: block;
                    text-align: center;
                    margin: 1em 0;
                    padding: 0.5em;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 6px;
                }

                /* Tables */
                .explanation-content table {
                    border-collapse: collapse;
                    width: 100%;
                    margin: 1em 0;
                }

                .explanation-content th,
                .explanation-content td {
                    border: 1px solid var(--vscode-panel-border);
                    padding: 8px 12px;
                    text-align: left;
                }

                .explanation-content th {
                    background: rgba(255, 255, 255, 0.05);
                    font-weight: 600;
                }

                /* Blockquotes */
                .explanation-content blockquote {
                    margin: 1em 0;
                    padding: 0.5em 1em;
                    border-left: 4px solid var(--vscode-button-background);
                    background: rgba(255, 255, 255, 0.03);
                }

                /* Quantum states and operators */
                .quantum-state {
                    font-family: 'Times New Roman', serif;
                    font-style: italic;
                }

                .math-inline {
                    display: inline;
                }

                /* Footer */
                .footer {
                    margin-top: 24px;
                    padding-top: 16px;
                    border-top: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: flex-end;
                    gap: 12px;
                }

                /* Responsive design */
                @media (max-width: 600px) {
                    body {
                        padding: 16px;
                    }
                    
                    .button-group {
                        flex-direction: column;
                    }
                    
                    .btn {
                        width: 100%;
                        justify-content: center;
                    }
                    
                    .explanation-content {
                        padding: 16px;
                    }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🔬 Quantum Code Explanation</h1>
                <span class="badge">${language}</span>
            </div>

            <div class="button-group">
                <button class="btn" onclick="copyExplanation()">
                    📋 Copy Explanation
                </button>
                <button class="btn btn-outline" onclick="copyCode()">
                    📄 Copy Code
                </button>
                <button class="btn btn-outline" onclick="copyAll()">
                    📑 Copy All
                </button>
            </div>

            <!-- Code Section -->
            <div class="code-section">
                <div class="code-header">
                    <h3>
                        <span>📄</span>
                        Selected Code
                    </h3>
                    <button class="btn-outline" onclick="copyCode()" style="padding: 4px 8px; font-size: 12px;">
                        Copy
                    </button>
                </div>
                <div class="code-block">
                    <pre><code>${this.escapeHtml(code)}</code></pre>
                </div>
            </div>

            <!-- Explanation Section -->
            <div class="explanation-section">
                <div class="explanation-header">
                    <h3>
                        <span>💡</span>
                        Detailed Explanation
                    </h3>
                    <button class="btn-outline" onclick="copyExplanation()" style="padding: 4px 8px; font-size: 12px;">
                        Copy
                    </button>
                </div>
                <div class="explanation-content tex2jax_process">
                    ${this.formatExplanation(this.normalizeLatexEscapes(explanation))}
                </div>
            </div>

            <!-- Footer -->
            <div class="footer">
                <span style="opacity: 0.6; font-size: 12px;">
                    Powered by Quantum AI • Mathematical equations rendered with MathJax
                </span>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                function copyExplanation() {
                    const explanation = document.querySelector('.explanation-content').innerText;
                    vscode.postMessage({ 
                        command: 'copyExplanation', 
                        text: explanation 
                    });
                }
                
                function copyCode() {
                    vscode.postMessage({ 
                        command: 'copyCode', 
                        text: ${JSON.stringify(code)}
                    });
                }
                
                function copyAll() {
                    vscode.postMessage({ 
                        command: 'copyAll'
                    });
                }

                document.addEventListener('DOMContentLoaded', () => {
                    if (window.MathJax?.typesetPromise) {
                        window.MathJax.typesetPromise().catch(err => console.log('MathJax error:', err));
                    }
                });
            </script>
        </body>
        </html>`;
    }

    private normalizeLatexEscapes(text: string): string {
        return (text || "")
            .replace(/\\\\\(/g, '\\(')
            .replace(/\\\\\)/g, '\\)')
            .replace(/\\\\\[/g, '\\[')
            .replace(/\\\\\]/g, '\\]')
            .replace(/\\\\begin\{/g, '\\begin{')
            .replace(/\\\\end\{/g, '\\end{');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private formatExplanation(text: string): string {
    const segments: Array<{content: string, isMath: boolean}> = [];
    let lastIndex = 0;

    // Handle ALL delimiter styles including multiline \[...\]
    const mathRegex = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^\$\n]+?\$)/g;
    let match;

    while ((match = mathRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({
                content: text.substring(lastIndex, match.index),
                isMath: false
            });
        }
        segments.push({ content: match[0], isMath: true });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        segments.push({
            content: text.substring(lastIndex),
            isMath: false
        });
    }

    let result = '';
    for (const segment of segments) {
        if (segment.isMath) {
            // Never escape math — pass raw to MathJax
            result += segment.content;
        } else {
            // Escape HTML first, THEN process markdown
            result += this.processMarkdown(this.escapeHtml(segment.content));
        }
    }

    return result;
}

private processMarkdown(text: string): string {
    let processed = text;

    // Headers
    processed = processed
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold and italic
    processed = processed
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Inline code
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Block code — text already escaped, don't call escapeHtml again
    processed = processed.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="language-${lang || 'text'}">${code}</code></pre>`;
    });

    // Lists
    const lines = processed.split('\n');
    const processedLines: string[] = [];
    let inList = false;
    let listType: 'ul' | 'ol' | null = null;

    for (const line of lines) {
        const ulMatch = line.match(/^\s*[-*]\s+(.*)/);
        const olMatch = line.match(/^\s*\d+\.\s+(.*)/);

        if (ulMatch) {
            if (!inList || listType !== 'ul') {
                if (inList) processedLines.push(`</${listType}>`);
                processedLines.push('<ul>');
                inList = true;
                listType = 'ul';
            }
            processedLines.push(`<li>${ulMatch[1]}</li>`);
        } else if (olMatch) {
            if (!inList || listType !== 'ol') {
                if (inList) processedLines.push(`</${listType}>`);
                processedLines.push('<ol>');
                inList = true;
                listType = 'ol';
            }
            processedLines.push(`<li>${olMatch[1]}</li>`);
        } else {
            if (inList) {
                processedLines.push(`</${listType}>`);
                inList = false;
                listType = null;
            }
            processedLines.push(line);
        }
    }

    if (inList) processedLines.push(`</${listType}>`);
    processed = processedLines.join('\n');

    // Wrap bare lines in <p> tags
    processed = processed.replace(
        /^(?!<[hou]|<\/[hou]|<li|<pre|<code|<[uo]l|<strong|<em).+$/gm,
        (match) => match.trim() ? `<p>${match}</p>` : match
    );

    return processed;
}

    private isInCodeBlock(text: string, match: string): boolean {
        // Simple check to see if the match is within a code block
        const codeBlockRegex = /<pre>.*?<\/pre>/gs;
        const matches = text.match(codeBlockRegex) || [];
        return matches.some(block => block.includes(match));
    }
}
