// import * as vscode from 'vscode';
// import { AIProvider } from '../../providers/aiProvider';

// export class TypingSuggestionPanel implements vscode.Disposable {
//     private panel: vscode.WebviewPanel | undefined;
//     private debounceTimer: NodeJS.Timeout | undefined;
//     private requestSeq = 0;
//     private disposables: vscode.Disposable[] = [];

//     constructor(
//         private readonly aiProvider: AIProvider,
//         private readonly output: vscode.OutputChannel
//     ) {}

//     start(context: vscode.ExtensionContext): void {
//         this.disposables.push(
//             vscode.workspace.onDidChangeTextDocument(async (event: vscode.TextDocumentChangeEvent) => {
//                 const editor = vscode.window.activeTextEditor;
//                 if (!editor || event.document !== editor.document) {
//                     return;
//                 }
//                 this.scheduleRefresh(editor);
//             }),
//             vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
//                 if (!editor) {
//                     return;
//                 }
//                 this.scheduleRefresh(editor);
//             }),
//             vscode.commands.registerCommand('quantum-ai.openTypingSuggestions', () => {
//                 this.ensurePanel();
//                 const editor = vscode.window.activeTextEditor;
//                 if (editor) {
//                     this.scheduleRefresh(editor, 0);
//                 }
//             })
//         );

//         context.subscriptions.push(this);
//     }

//     dispose(): void {
//         if (this.debounceTimer) {
//             clearTimeout(this.debounceTimer);
//         }
//         this.panel?.dispose();
//         this.disposables.forEach((d) => d.dispose());
//         this.disposables = [];
//     }

//     private scheduleRefresh(editor: vscode.TextEditor, delayMs = 500): void {
//         const config = vscode.workspace.getConfiguration('quantum-ai');
//         const enabled = config.get('completionEnabled', true) as boolean;
//         const showPanel = config.get('showTypingSuggestionPanel', true) as boolean;
//         if (!enabled || !showPanel) {
//             return;
//         }
//         if (this.debounceTimer) {
//             clearTimeout(this.debounceTimer);
//         }
//         this.debounceTimer = setTimeout(() => {
//             void this.refresh(editor);
//         }, delayMs);
//     }

//     private async refresh(editor: vscode.TextEditor): Promise<void> {
//         try {
//             const document = editor.document;
//             if (document.uri.scheme !== 'file') {
//                 return;
//             }

//             const position = editor.selection.active;
//             const lineText = document.lineAt(position.line).text.substring(0, position.character);
//             if (lineText.trim().length < 3) {
//                 return;
//             }

//             const contextText = this.buildCompletionContext(document, position);
//             if (contextText.trim().length < 10) {
//                 return;
//             }

//             const requestId = ++this.requestSeq;
//             const suggestion = (await this.aiProvider.complete(contextText, document.languageId)).trim();
//             if (requestId !== this.requestSeq || !suggestion) {
//                 return;
//             }

//             this.ensurePanel();
//             this.renderSuggestion(suggestion, document.languageId);
//         } catch (error) {
//             this.output.appendLine(`Typing suggestion panel error: ${error instanceof Error ? error.message : String(error)}`);
//         }
//     }

//     private buildCompletionContext(document: vscode.TextDocument, position: vscode.Position): string {
//         const maxLines = vscode.workspace.getConfiguration('quantum-ai').get('maxLinesForContext', 20) as number;
//         const startLine = Math.max(0, position.line - maxLines);
//         const lines: string[] = [];
//         for (let i = startLine; i < position.line; i += 1) {
//             lines.push(document.lineAt(i).text);
//         }
//         lines.push(document.lineAt(position.line).text.substring(0, position.character));
//         return lines.join('\n');
//     }

//     private ensurePanel(): void {
//         if (this.panel) {
//             this.panel.reveal(vscode.ViewColumn.Beside, true);
//             return;
//         }

//         this.panel = vscode.window.createWebviewPanel(
//             'quantumAITypingSuggestions',
//             'Quantum AI Typing Suggestions',
//             vscode.ViewColumn.Beside,
//             { enableScripts: true, retainContextWhenHidden: true }
//         );

//         const panel = this.panel!;
//         panel.onDidDispose(() => {
//             this.panel = undefined;
//         });

//         panel.webview.onDidReceiveMessage(async (message: { command: string; suggestion?: string }) => {
//             if (message.command !== 'applySuggestion' || !message.suggestion) {
//                 return;
//             }
//             const editor = vscode.window.activeTextEditor;
//             if (!editor) {
//                 return;
//             }
//             const edit = new vscode.WorkspaceEdit();
//             edit.insert(editor.document.uri, editor.selection.active, message.suggestion);
//             await vscode.workspace.applyEdit(edit);
//         });
//     }

//     private renderSuggestion(suggestion: string, languageId: string): void {
//         if (!this.panel) {
//             return;
//         }
//         const panel = this.panel!;
//         const escaped = this.escapeHtml(suggestion);
//         panel.webview.html = `<!doctype html>
// <html>
// <head>
//   <meta charset="UTF-8" />
//   <meta name="viewport" content="width=device-width, initial-scale=1.0" />
//   <style>
//     body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
//     .meta { font-size: 12px; opacity: 0.75; margin-bottom: 8px; }
//     pre { margin: 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-textCodeBlock-background); overflow-x: auto; }
//     button { margin-top: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
//   </style>
// </head>
// <body>
//   <div class="meta">Live suggestion while typing • ${this.escapeHtml(languageId)}</div>
//   <pre><code>${escaped}</code></pre>
//   <button id="apply">Apply At Cursor</button>
//   <script>
//     const vscode = acquireVsCodeApi();
//     document.getElementById('apply').addEventListener('click', () => {
//       vscode.postMessage({ command: 'applySuggestion', suggestion: ${JSON.stringify(suggestion)} });
//     });
//   </script>
// </body>
// </html>`;
//     }

//     private escapeHtml(text: string): string {
//         return text
//             .replace(/&/g, '&amp;')
//             .replace(/</g, '&lt;')
//             .replace(/>/g, '&gt;')
//             .replace(/"/g, '&quot;')
//             .replace(/'/g, '&#039;');
//     }
// }
