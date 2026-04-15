import * as vscode from 'vscode';
import * as path from 'node:path';
import { ArpApiClient } from './arp/apiClient';
import { ChatSessionController } from './arp/sessionController';

type PersistedArpSession = {
    experimentId: string;
    researchType: 'ai' | 'quantum';
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private quantumApiUrl = "http://localhost:8000"; // Quantum bot backend
    private arpApi: ArpApiClient;
    private arpController?: ChatSessionController;
    private currentMode: 'quantum' | 'arp' = 'quantum';
    private arpOutput: vscode.OutputChannel;
    private webviewView?: vscode.WebviewView;
    private requestedMode: 'quantum' | 'arp' | null = null;
    private messageIds: Set<string> = new Set();
    private currentExperimentId: string | null = null;
    private pollInterval: NodeJS.Timeout | null = null;
    private readonly arpPersistKey = 'arp.session.v1';

    constructor(
        private readonly context: vscode.ExtensionContext,
        getArpBaseUrl?: () => string
    ) {
        // Initialize ARP API
        const getBaseUrl = getArpBaseUrl || (() => {
            const config = vscode.workspace.getConfiguration('quantum-ai');
            return ((config.get('arp.baseUrl') as string) || "http://127.0.0.1:8001/api/v1");
        });
        this.arpOutput = vscode.window.createOutputChannel('ARP Backend');
        this.arpApi = new ArpApiClient(getBaseUrl, this.arpOutput);
        this.context.subscriptions.push(this.arpOutput);
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = this.getHtml();

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'switchMode':
                        await this.handleModeSwitch(message.mode, webviewView);
                        break;

                    case 'sendMessage':
                        await this.handleSendMessage(message.text, webviewView);
                        break;

                    case 'checkBackend':
                        await this.checkBackendHealth(webviewView);
                        break;

                    // Question handling
                    case 'acceptQuestion':
                        await this.handleAcceptQuestion(webviewView);
                        break;

                    case 'denyQuestion':
                        await this.handleDenyQuestion(message.value, webviewView);
                        break;

                    // Confirmation handling
                    case 'acceptConfirm':
                        await this.handleAcceptConfirm(webviewView);
                        break;

                    case 'denyConfirm':
                        await this.handleDenyConfirm(message.reason, webviewView);
                        break;

                    // Session management
                    case 'newSession':
                        await this.handleNewSession(webviewView);
                        break;

                    case 'pollStatus':
                        if (this.currentExperimentId) {
                            await this.pollExperimentStatus(this.currentExperimentId, webviewView);
                        }
                        break;
                }
            } catch (err: any) {
                webviewView.webview.postMessage({
                    command: "error",
                    text: this.formatErrorMessage(err)
                });
            }
        });

        // Check backend health on load
        this.checkBackendHealth(webviewView);

        if (this.requestedMode) {
            const mode = this.requestedMode;
            this.requestedMode = null;
            void this.handleModeSwitch(mode, webviewView);
        }
    }

    public requestModeSwitch(mode: 'quantum' | 'arp') {
        this.requestedMode = mode;
        if (this.webviewView) {
            this.requestedMode = null;
            void this.handleModeSwitch(mode, this.webviewView);
        }
    }

    private async handleModeSwitch(mode: 'quantum' | 'arp', webviewView: vscode.WebviewView) {
        this.currentMode = mode;
        
        // Clear any existing polling
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        webviewView.webview.postMessage({
            command: 'modeSwitched',
            mode: this.currentMode
        });

        if (this.currentMode === 'arp') {
            await this.initializeArpController(webviewView);
            await this.handleArpResumeDecision(webviewView);
        }
    }

    private async initializeArpController(webviewView: vscode.WebviewView) {
        if (!this.arpController) {
            this.arpController = new ChatSessionController(
                this.arpApi,
                this.context,
                { pollIntervalMs: 5000 }
            );

            // Listen for ARP state updates
            this.arpController.onUpdate((state) => {
                if (this.currentMode === 'arp') {
                    this.sendArpStateToWebview(state, webviewView);
                }
            });
            this.currentExperimentId = this.arpController.getState().experimentId;
        }
    }

    private async handleArpResumeDecision(webviewView: vscode.WebviewView): Promise<void> {
        if (!this.arpController) {
            return;
        }

        const current = this.arpController.getState();
        if (current.experimentId && current.status !== 'idle') {
            this.sendArpStateToWebview(current, webviewView);
            return;
        }

        const persisted = this.context.globalState.get<PersistedArpSession | null>(this.arpPersistKey, null);
        if (!persisted?.experimentId) {
            await this.arpController.startFreshSession();
            return;
        }

        let incomplete = false;
        let statusUnknown = false;
        try {
            const status = await this.arpApi.getStatus(persisted.experimentId);
            incomplete = !['success', 'failed', 'aborted'].includes(String(status.status || '').toLowerCase());
        } catch {
            statusUnknown = true;
        }

        if (!incomplete && !statusUnknown) {
            await this.arpController.startFreshSession();
            return;
        }

        const continueLabel = 'Continue Previous (Recommended)';
        const startNewLabel = 'Start New';
        const choice = await vscode.window.showInformationMessage(
            statusUnknown
                ? `Could not verify previous ARP experiment ${persisted.experimentId}.`
                : `Previous ARP experiment ${persisted.experimentId} is not complete.`,
            { modal: true },
            continueLabel,
            startNewLabel
        );

        if (choice === continueLabel) {
            await this.arpController.hydrateFromPersistedState();
            return;
        }

        await this.arpController.startFreshSession();
    }

    private async handleSendMessage(text: string, webviewView: vscode.WebviewView) {
        webviewView.webview.postMessage({ command: 'showLoading' });

        try {
            if (this.currentMode === 'quantum') {
                await this.handleQuantumQuery(text, webviewView);
            } else {
                await this.handleArpQuery(text, webviewView);
            }
        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: this.formatErrorMessage(err)
            });
        } finally {
            webviewView.webview.postMessage({ command: 'hideLoading' });
        }
    }

    private async handleQuantumQuery(query: string, webviewView: vscode.WebviewView) {
        try {
            const formattedQuery = `${query}\n\n` +
                'Formatting instructions: When you write equations, always use LaTeX math syntax with proper delimiters ' +
                '($...$, $$...$$, \\( ... \\), \\[ ... \\]) and matrix environments like \\begin{bmatrix} a & b \\\ c & d \\end{bmatrix} ' +
                'instead of inline Unicode or plain text formatting.';

            const response = await fetch(`${this.quantumApiUrl}/api/chat/message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: formattedQuery,
                    detail_level: "intermediate"
                })
            });

            if (!response.ok) {
                throw new Error(`Quantum backend error: ${response.status}`);
            }

            const data = await response.json();
            const reply = data.reply || data.data?.answer || "No response";

            webviewView.webview.postMessage({
                command: "quantumReply",
                text: reply
            });

        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: `Quantum backend error: ${err.message}`
            });
        }
    }

    private async handleArpQuery(query: string, webviewView: vscode.WebviewView) {
        if (!this.arpController) {
            await this.initializeArpController(webviewView);
        }

        try {
            const trimmed = String(query || "").trim();
            const projectRoot = this.resolveArpProjectRoot();
            if (/^\/new(\s+|$)/i.test(trimmed)) {
                const nextPrompt = trimmed.replace(/^\/new\s*/i, "").trim();
                await this.handleNewSession(webviewView);
                if (!nextPrompt) {
                    webviewView.webview.postMessage({
                        command: "status",
                        text: "Started new ARP session. Enter a prompt to begin.",
                        type: "info"
                    });
                    return;
                }
                webviewView.webview.postMessage({
                    command: "status",
                    text: "Starting fresh experiment...",
                    type: "info"
                });
                await this.arpController!.startFromChatQuery(nextPrompt, "ai", projectRoot);
                return;
            }

            const state = this.arpController!.getState();
            if (state.experimentId && state.status === "waiting_user" && state.pendingQuestion) {
                webviewView.webview.postMessage({
                    command: "status",
                    text: "Clarification is pending. Use Accept/Custom Answer or click New Session.",
                    type: "warning"
                });
                return;
            }
            if (state.confirmationInFlight) {
                webviewView.webview.postMessage({
                    command: "status",
                    text: "Command is currently running in background. Wait for completion.",
                    type: "info"
                });
                return;
            }
            if (state.experimentId && state.status === "waiting_user" && state.pendingAction) {
                webviewView.webview.postMessage({
                    command: "status",
                    text: "Approval is pending. Use Accept/Deny or click New Session.",
                    type: "warning"
                });
                return;
            }
            if (state.experimentId && (state.status === "running" || state.status === "pending")) {
                webviewView.webview.postMessage({
                    command: "status",
                    text: "Workflow is running. Use New Session to start a fresh experiment.",
                    type: "info"
                });
                return;
            }

            // Clear previous session data
            this.currentExperimentId = null;
            this.messageIds.clear();

            // Show status message
            webviewView.webview.postMessage({
                command: "status",
                text: "Starting research experiment...",
                type: "info"
            });

            // Start experiment using the controller
            await this.arpController!.startFromChatQuery(query, "ai", projectRoot);

        } catch (err: any) {
            throw new Error(`Failed to start experiment: ${err.message}`);
        }
    }

    private resolveArpProjectRoot(): string {
        const config = vscode.workspace.getConfiguration('quantum-ai');
        const configured = String((config.get('arp.defaultProjectRoot') as string) || "").trim();
        if (configured) {
            return configured;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        if (!workspaceRoot) {
            return "";
        }
        const normalized = workspaceRoot.replace(/[\\\/]+$/, "");
        const baseName = path.basename(normalized).toLowerCase();
        if (baseName === "research_platform") {
            return path.join(path.dirname(normalized), "workspace", "projects");
        }
        return path.join(normalized, "workspace", "projects");
    }

    private async handleAcceptQuestion(webviewView: vscode.WebviewView) {
        if (!this.arpController) return;

        try {
            webviewView.webview.postMessage({
                command: "status",
                text: "Submitting answer...",
                type: "info"
            });

            await this.arpController.acceptQuestion();

        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: `Failed to submit answer: ${err.message}`
            });
        }
    }

    private async handleDenyQuestion(value: string, webviewView: vscode.WebviewView) {
        if (!this.arpController || !value.trim()) return;

        try {
            webviewView.webview.postMessage({
                command: "status",
                text: "Submitting custom answer...",
                type: "info"
            });

            await this.arpController.denyQuestionEdit(value);

        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: `Failed to submit answer: ${err.message}`
            });
        }
    }

    private async handleAcceptConfirm(webviewView: vscode.WebviewView) {
        if (!this.arpController) return;

        try {
            webviewView.webview.postMessage({
                command: "status",
                text: "Executing action...",
                type: "info"
            });

            await this.arpController.acceptConfirm();

        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: `Failed to execute action: ${err.message}`
            });
        }
    }

    private async handleDenyConfirm(reason: string, webviewView: vscode.WebviewView) {
        if (!this.arpController) return;

        try {
            webviewView.webview.postMessage({
                command: "status",
                text: "Denying action...",
                type: "info"
            });

            await this.arpController.denyConfirm(reason || "User denied", "");

        } catch (err: any) {
            webviewView.webview.postMessage({
                command: "error",
                text: `Failed to deny action: ${err.message}`
            });
        }
    }

    private async handleNewSession(webviewView: vscode.WebviewView) {
        if (this.arpController) {
            await this.arpController.startFreshSession();
        }
        
        this.currentExperimentId = null;
        this.messageIds.clear();
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        webviewView.webview.postMessage({
            command: "clearChat"
        });
    }

    private async pollExperimentStatus(experimentId: string, webviewView: vscode.WebviewView) {
        try {
            const response = await fetch(`${this.arpApi.baseUrl()}/research/${experimentId}/status`);
            if (!response.ok) return;

            const result = await response.json();
            if (result.success && result.data) {
                webviewView.webview.postMessage({
                    command: "experimentStatus",
                    status: result.data
                });
            }
        } catch (err) {
            // Silent fail for polling
        }
    }

    private sendArpStateToWebview(state: any, webviewView: vscode.WebviewView) {
        // Update experiment ID
        if (state.experimentId && state.experimentId !== this.currentExperimentId) {
            this.currentExperimentId = state.experimentId;
        }

        // Send state to webview
        webviewView.webview.postMessage({
            command: 'arpState',
            state: {
                experimentId: state.experimentId,
                status: state.status,
                phase: state.phase,
                progressPct: state.progressPct,
                confirmationInFlight: Boolean(state.confirmationInFlight),
                pendingQuestion: state.pendingQuestion,
                pendingAction: state.confirmationInFlight ? null : state.pendingAction,
                lastSuggestedAnswer: state.lastSuggestedAnswer,
                researchType: state.researchType
            }
        });

        // Forward only unseen non-user messages to avoid repeated "resuming" spam.
        const messages = Array.isArray(state.messages) ? state.messages : [];
        for (const item of messages) {
            if (!item || item.role === "user") {
                continue;
            }
            const messageId = String(item.id || `${item.role}-${String(item.content || "").slice(0, 80)}-${item.createdAt || 0}`);
            if (!messageId || this.messageIds.has(messageId)) {
                continue;
            }
            this.messageIds.add(messageId);

            let content = String(item.content || "");
            let type = "assistant";
            if (item.kind === "question") {
                type = "question";
                content = `[Question] ${content}`;
            } else if (item.kind === "confirmation") {
                type = "confirmation";
                content = `[Confirm] ${content}`;
            } else if (item.kind === "error") {
                type = "error";
                content = `[Error] ${content}`;
            } else if (item.kind === "status") {
                type = "status";
                content = `[Info] ${content}`;
            } else if (item.kind === "summary") {
                type = "summary";
                content = `[Summary] ${content}`;
            }

            webviewView.webview.postMessage({
                command: "arpMessage",
                message: {
                    role: item.role,
                    content,
                    type,
                    kind: item.kind,
                    meta: item.meta
                }
            });
        }

        // Bound memory usage for long sessions.
        if (this.messageIds.size > 2000) {
            this.messageIds.clear();
            for (const item of messages.slice(-300)) {
                const id = String(item?.id || `${item?.role}-${String(item?.content || "").slice(0, 80)}-${item?.createdAt || 0}`);
                if (id) {
                    this.messageIds.add(id);
                }
            }
        }
    }

    private async checkBackendHealth(webviewView: vscode.WebviewView) {
        try {
            // Check Quantum backend
            let quantumHealth = false;
            try {
                const response = await fetch(`${this.quantumApiUrl}/health`);
                quantumHealth = response.ok;
            } catch {
                quantumHealth = false;
            }
            
            // Check ARP backend
            let arpHealth = false;
            try {
                const response = await fetch(`${this.arpApi.baseUrl()}/research?limit=1`);
                arpHealth = response.ok;
            } catch {
                arpHealth = false;
            }

            webviewView.webview.postMessage({
                command: 'backendStatus',
                quantum: quantumHealth,
                arp: arpHealth
            });
        } catch {
            webviewView.webview.postMessage({
                command: 'backendStatus',
                quantum: false,
                arp: false
            });
        }
    }

    private formatErrorMessage(err: any): string {
        if (err.response?.data?.error?.message) {
            return err.response.data.error.message;
        }
        if (err.message) {
            return err.message;
        }
        return "An unknown error occurred";
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
            <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                :root {
                    --bg-primary: #0a0a0f;
                    --bg-secondary: #14141f;
                    --bg-tertiary: #1a1a2a;
                    --accent-quantum: #6366f1;
                    --accent-quantum-glow: rgba(99, 102, 241, 0.3);
                    --accent-arp: #10b981;
                    --accent-arp-glow: rgba(16, 185, 129, 0.3);
                    --text-primary: #ffffff;
                    --text-secondary: #a0a0b0;
                    --text-muted: #6b6b7c;
                    --border-color: #2a2a3a;
                    --error-color: #ef4444;
                    --success-color: #10b981;
                    --warning-color: #f59e0b;
                    --info-color: #3b82f6;
                    --gradient-quantum: linear-gradient(135deg, #6366f1, #8b5cf6);
                    --gradient-arp: linear-gradient(135deg, #10b981, #34d399);
                }

                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    height: 100vh;
                    overflow: hidden;
                }

                .app {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    position: relative;
                }

                /* Mode Toggle */
                .mode-toggle {
                    padding: 12px 16px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-color);
                    z-index: 10;
                }

                .toggle-container {
                    display: flex;
                    gap: 8px;
                    padding: 4px;
                    background: var(--bg-tertiary);
                    border-radius: 40px;
                    border: 1px solid var(--border-color);
                }

                .mode-btn {
                    flex: 1;
                    padding: 8px 16px;
                    border: none;
                    border-radius: 32px;
                    background: transparent;
                    color: var(--text-secondary);
                    font-weight: 500;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .mode-btn.quantum.active {
                    background: var(--gradient-quantum);
                    color: white;
                    box-shadow: 0 0 15px var(--accent-quantum-glow);
                }

                .mode-btn.arp.active {
                    background: var(--gradient-arp);
                    color: white;
                    box-shadow: 0 0 15px var(--accent-arp-glow);
                }

                /* Status Bar */
                .status-bar {
                    padding: 8px 16px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-color);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    font-size: 12px;
                }

                .status-info {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .status-actions {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .status-badge {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 10px;
                    border-radius: 16px;
                    background: var(--bg-tertiary);
                }

                .status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    transition: all 0.3s;
                }

                .status-dot.connected {
                    background: var(--success-color);
                    box-shadow: 0 0 8px var(--success-color);
                }

                .status-dot.disconnected {
                    background: var(--error-color);
                }

                .experiment-badge {
                    padding: 4px 10px;
                    border-radius: 16px;
                    background: rgba(16, 185, 129, 0.1);
                    color: var(--accent-arp);
                    font-family: 'Monaco', monospace;
                    font-size: 11px;
                    border: 1px solid var(--accent-arp);
                }

                .phase-badge {
                    padding: 2px 8px;
                    border-radius: 12px;
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    font-size: 11px;
                }

                .progress-bar {
                    width: 120px;
                    height: 4px;
                    background: var(--bg-tertiary);
                    border-radius: 2px;
                    overflow: hidden;
                }

                .progress-fill {
                    height: 100%;
                    background: var(--gradient-arp);
                    transition: width 0.3s ease;
                }

                .status-btn {
                    border: 1px solid var(--border-color);
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    border-radius: 8px;
                    font-size: 11px;
                    padding: 4px 8px;
                    cursor: pointer;
                }

                .status-btn:hover {
                    color: var(--text-primary);
                    border-color: var(--accent-arp);
                }

                /* Chat Container */
                .chat-container {
                    flex: 1;
                    overflow-y: auto;
                    padding: 16px;
                    scroll-behavior: smooth;
                }

                .chat-container::-webkit-scrollbar {
                    width: 6px;
                }

                .chat-container::-webkit-scrollbar-track {
                    background: var(--bg-secondary);
                }

                .chat-container::-webkit-scrollbar-thumb {
                    background: var(--border-color);
                    border-radius: 3px;
                }

                /* Messages */
                .message {
                    margin-bottom: 16px;
                    max-width: 85%;
                    animation: fadeIn 0.3s ease;
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .message.user {
                    margin-left: auto;
                }

                .message.assistant {
                    margin-right: auto;
                }

                .message.system {
                    margin: 12px auto;
                    text-align: center;
                    max-width: 90%;
                }

                .message-bubble {
                    padding: 10px 14px;
                    border-radius: 18px;
                    font-size: 13px;
                    line-height: 1.5;
                    word-wrap: break-word;
                    white-space: pre-wrap;
                }

                .message.user .message-bubble {
                    background: var(--gradient-quantum);
                    color: white;
                    border-bottom-right-radius: 4px;
                }

                .message.assistant .message-bubble {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-bottom-left-radius: 4px;
                }

                .message.system .message-bubble {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px dashed var(--border-color);
                    color: var(--text-secondary);
                    font-size: 12px;
                }

                .message.assistant.question .message-bubble {
                    border-left: 3px solid var(--warning-color);
                }

                .message.assistant.confirmation .message-bubble {
                    border-left: 3px solid var(--info-color);
                }

                .message.assistant.error .message-bubble {
                    border-left: 3px solid var(--error-color);
                }

                .message.assistant.status .message-bubble {
                    border-left: 3px solid var(--accent-arp);
                }

                .message.assistant.summary .message-bubble {
                    border-left: 3px solid var(--success-color);
                }

                .message-meta {
                    font-size: 10px;
                    color: var(--text-muted);
                    margin-top: 4px;
                    padding: 0 8px;
                }

                /* Action Panel */
                .action-panel {
                    margin: 12px 16px;
                    padding: 16px;
                    background: var(--bg-tertiary);
                    border-radius: 12px;
                    border: 1px solid var(--border-color);
                    animation: slideUp 0.3s ease;
                }

                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }

                .action-title {
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--text-primary);
                    margin-bottom: 8px;
                }

                .action-content {
                    color: var(--text-secondary);
                    font-size: 13px;
                    line-height: 1.5;
                    margin-bottom: 12px;
                    padding: 10px;
                    background: var(--bg-secondary);
                    border-radius: 8px;
                }

                .action-options {
                    margin-top: 8px;
                    font-size: 12px;
                    color: var(--text-muted);
                }

                .action-buttons {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }

                .btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 20px;
                    font-weight: 500;
                    font-size: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                    background: var(--bg-secondary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                }

                .btn:hover {
                    transform: translateY(-1px);
                    border-color: var(--text-secondary);
                }

                .btn.primary {
                    background: var(--gradient-arp);
                    color: white;
                    border: none;
                }

                .btn.primary:hover {
                    box-shadow: 0 0 12px var(--accent-arp-glow);
                }

                .btn.danger {
                    background: var(--error-color);
                    color: white;
                    border: none;
                }

                .btn.secondary {
                    background: transparent;
                    border: 1px solid var(--border-color);
                }

                .input-group {
                    margin-top: 12px;
                }

                .input-group input {
                    width: 100%;
                    padding: 10px 12px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 20px;
                    color: var(--text-primary);
                    font-size: 13px;
                }

                .input-group input:focus {
                    outline: none;
                    border-color: var(--accent-arp);
                    box-shadow: 0 0 0 2px var(--accent-arp-glow);
                }

                /* Input Area */
                .input-area {
                    padding: 12px 16px;
                    background: var(--bg-secondary);
                    border-top: 1px solid var(--border-color);
                    display: flex;
                    gap: 8px;
                }

                .input-wrapper {
                    flex: 1;
                }

                #messageInput {
                    width: 100%;
                    padding: 10px 14px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 24px;
                    color: var(--text-primary);
                    font-size: 13px;
                }

                #messageInput:focus {
                    outline: none;
                    border-color: var(--accent-quantum);
                    box-shadow: 0 0 0 2px var(--accent-quantum-glow);
                }

                #messageInput.arp-mode:focus {
                    border-color: var(--accent-arp);
                    box-shadow: 0 0 0 2px var(--accent-arp-glow);
                }

                #sendButton {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 24px;
                    font-weight: 500;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s;
                    background: var(--gradient-quantum);
                    color: white;
                }

                #sendButton.arp-mode {
                    background: var(--gradient-arp);
                }

                #sendButton:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 0 12px var(--accent-quantum-glow);
                }

                #sendButton.arp-mode:hover:not(:disabled) {
                    box-shadow: 0 0 12px var(--accent-arp-glow);
                }

                #sendButton:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* Typing Indicator */
                .typing-indicator {
                    display: flex;
                    gap: 4px;
                    padding: 8px 12px;
                    background: var(--bg-tertiary);
                    border-radius: 20px;
                    width: fit-content;
                }

                .typing-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--text-secondary);
                    animation: typing 1.4s infinite ease-in-out;
                }

                .typing-dot:nth-child(1) { animation-delay: 0s; }
                .typing-dot:nth-child(2) { animation-delay: 0.2s; }
                .typing-dot:nth-child(3) { animation-delay: 0.4s; }

                @keyframes typing {
                    0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
                    30% { transform: translateY(-4px); opacity: 1; }
                }

                /* Welcome Screen */
                .welcome-screen {
                    text-align: center;
                    padding: 40px 20px;
                    color: var(--text-secondary);
                }

                .welcome-title {
                    font-size: 20px;
                    font-weight: 600;
                    margin-bottom: 8px;
                    background: var(--gradient-quantum);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }

                .welcome-subtitle {
                    font-size: 13px;
                    max-width: 400px;
                    margin: 0 auto;
                    line-height: 1.5;
                    color: var(--text-muted);
                }

                /* Status Message */
                .status-message {
                    margin: 8px 16px;
                    padding: 8px 12px;
                    border-radius: 8px;
                    font-size: 12px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .status-message.info {
                    background: rgba(59, 130, 246, 0.1);
                    border: 1px solid var(--info-color);
                    color: var(--info-color);
                }

                .status-message.success {
                    background: rgba(16, 185, 129, 0.1);
                    border: 1px solid var(--success-color);
                    color: var(--success-color);
                }

                .status-message.warning {
                    background: rgba(245, 158, 11, 0.1);
                    border: 1px solid var(--warning-color);
                    color: var(--warning-color);
                }

                .status-message.error {
                    background: rgba(239, 68, 68, 0.1);
                    border: 1px solid var(--error-color);
                    color: var(--error-color);
                }

                .message-bubble pre {
                    position: relative;
                    background: #050510;
                    border-radius: 10px;
                    padding: 10px 12px 10px 12px;
                    margin: 6px 0;
                    overflow-x: auto;
                    font-size: 12px;
                }

                .message-bubble code {
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
                }

                .code-copy-btn {
                    position: absolute;
                    top: 6px;
                    right: 8px;
                    border: none;
                    border-radius: 6px;
                    padding: 2px 6px;
                    font-size: 11px;
                    cursor: pointer;
                    background: rgba(15, 23, 42, 0.9);
                    color: var(--text-secondary);
                    border: 1px solid rgba(148, 163, 184, 0.4);
                }

                .code-copy-btn:hover {
                    color: var(--text-primary);
                    border-color: var(--accent-quantum);
                }

                .hidden {
                    display: none !important;
                }
            </style>
        </head>
        <body>
            <div class="app">
                <!-- Mode Toggle -->
                <div class="mode-toggle">
                    <div class="toggle-container">
                        <button class="mode-btn quantum active" data-mode="quantum">Code</button>
                        <button class="mode-btn arp" data-mode="arp">ARP</button>
                    </div>
                </div>

                <!-- Status Bar -->
                <div class="status-bar">
                    <div class="status-info">
                        <span id="modeIndicator" class="status-badge">
                            <span class="status-dot connected"></span>
                            <span>Code Mode</span>
                        </span>
                        <span id="experimentBadge" class="experiment-badge hidden"></span>
                        <span id="phaseBadge" class="phase-badge hidden"></span>
                    </div>
                    <div class="status-actions">
                        <button id="newSessionButton" class="status-btn hidden" title="Start a fresh ARP experiment">New Session</button>
                        <div id="progressContainer" class="progress-bar hidden">
                            <div class="progress-fill" style="width: 0%"></div>
                        </div>
                    </div>
                </div>

                <!-- Chat Container -->
                <div class="chat-container" id="chatContainer">
                    <div class="welcome-screen" id="welcomeScreen">
                        <div class="welcome-title">Welcome to Quantum AI</div>
                        <div class="welcome-subtitle">
                            Select a mode to begin. Code for coding assistance,
                            ARP for autonomous research workflows.
                        </div>
                    </div>
                </div>

                <!-- Action Panel -->
                <div id="actionPanel" class="action-panel hidden">
                    <div class="action-title" id="actionTitle"></div>
                    <div class="action-content" id="actionContent"></div>
                    <div class="action-options" id="actionOptions"></div>
                    <div class="action-buttons" id="actionButtons"></div>
                    <div class="input-group hidden" id="actionInput">
                        <input type="text" id="actionInputField" placeholder="Enter your response..." />
                    </div>
                </div>

                <!-- Input Area -->
                <div class="input-area">
                    <div class="input-wrapper">
                        <input 
                            type="text" 
                            id="messageInput" 
                            placeholder="Type your message..." 
                            autocomplete="off"
                        />
                    </div>
                    <button id="sendButton">Send</button>
                </div>
            </div>

            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    
                    // DOM Elements
                    const chatContainer = document.getElementById('chatContainer');
                    const welcomeScreen = document.getElementById('welcomeScreen');
                    const messageInput = document.getElementById('messageInput');
                    const sendButton = document.getElementById('sendButton');
                    const modeButtons = document.querySelectorAll('.mode-btn');
                    const modeIndicator = document.getElementById('modeIndicator');
                    const experimentBadge = document.getElementById('experimentBadge');
                    const phaseBadge = document.getElementById('phaseBadge');
                    const progressContainer = document.getElementById('progressContainer');
                    const progressFill = document.querySelector('.progress-fill');
                    const newSessionButton = document.getElementById('newSessionButton');
                    const actionPanel = document.getElementById('actionPanel');
                    const actionTitle = document.getElementById('actionTitle');
                    const actionContent = document.getElementById('actionContent');
                    const actionOptions = document.getElementById('actionOptions');
                    const actionButtons = document.getElementById('actionButtons');
                    const actionInput = document.getElementById('actionInput');
                    const actionInputField = document.getElementById('actionInputField');

                    // State
                    let currentMode = 'quantum';
                    let isWaiting = false;
                    let currentArpState = null;
                    let statusMessageTimeout = null;
                    let actionPanelMode = 'none';
                    let lockedQuestionId = '';
                    let lockedActionId = '';
                    let lastConfirmationInFlight = false;

                    // Mode Switching
                    modeButtons.forEach(btn => {
                        btn.addEventListener('click', () => {
                            const mode = btn.dataset.mode;
                            if (mode === currentMode) return;

                            modeButtons.forEach(b => b.classList.remove('active'));
                            btn.classList.add('active');
                            currentMode = mode;

                            updateModeUI();
                            
                            vscode.postMessage({
                                command: 'switchMode',
                                mode: currentMode
                            });

                            // Clear chat when switching modes
                            if (mode === 'quantum') {
                                clearChat();
                            }
                        });
                    });

                    function updateModeUI() {
                        const dot = modeIndicator.querySelector('.status-dot');
                        const text = modeIndicator.querySelector('span:last-child');
                        
                        if (currentMode === 'quantum') {
                            text.textContent = 'Code Mode';
                            messageInput.classList.remove('arp-mode');
                            sendButton.classList.remove('arp-mode');
                            dot.className = 'status-dot ' + (window.quantumConnected ? 'connected' : 'disconnected');
                            newSessionButton.classList.add('hidden');
                        } else {
                            text.textContent = 'ARP Mode';
                            messageInput.classList.add('arp-mode');
                            sendButton.classList.add('arp-mode');
                            dot.className = 'status-dot ' + (window.arpConnected ? 'connected' : 'disconnected');
                            newSessionButton.classList.remove('hidden');
                        }

                        // Hide ARP-specific UI in quantum mode
                        if (currentMode === 'quantum') {
                            experimentBadge.classList.add('hidden');
                            phaseBadge.classList.add('hidden');
                            progressContainer.classList.add('hidden');
                            actionPanel.classList.add('hidden');
                        } else if (currentArpState) {
                            updateArpUI(currentArpState);
                        }
                    }

                    function clearChat() {
                        const messages = chatContainer.querySelectorAll('.message:not(.welcome-screen)');
                        messages.forEach(msg => msg.remove());
                        welcomeScreen.classList.remove('hidden');
                        actionPanel.classList.add('hidden');
                        actionPanelMode = 'none';
                        lockedQuestionId = '';
                        lockedActionId = '';
                        lastConfirmationInFlight = false;
                        experimentBadge.classList.add('hidden');
                        phaseBadge.classList.add('hidden');
                        progressContainer.classList.add('hidden');
                    }

                    // Send Message
                    sendButton.addEventListener('click', sendMessage);
                    newSessionButton.addEventListener('click', () => {
                        if (currentMode !== 'arp') return;
                        vscode.postMessage({ command: 'newSession' });
                        showStatusMessage('Started new ARP session.', 'info');
                    });
                    messageInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                        }
                    });

                    function sendMessage() {
                        const text = messageInput.value.trim();
                        if (!text || isWaiting) return;

                        addMessage('user', text);
                        messageInput.value = '';

                        showTypingIndicator();
                        isWaiting = true;

                        vscode.postMessage({
                            command: 'sendMessage',
                            text: text
                        });
                    }

                    function addMessage(role, content, type = 'assistant') {
                        welcomeScreen.classList.add('hidden');

                        const messageDiv = document.createElement('div');
                        messageDiv.className = \`message \${role}\`;
                        if (role === 'assistant' && type !== 'assistant') {
                            messageDiv.classList.add(type);
                        }

                        let displayContent = content;
                        try {
                            displayContent = marked.parse(content);
                        } catch {
                            displayContent = content.replace(/\\n/g, '<br>');
                        }

                        messageDiv.innerHTML = \`
                            <div class="message-bubble">\${displayContent}</div>
                            <div class="message-meta">\${role === 'user' ? 'You' : (currentMode === 'quantum' ? 'Code' : 'ARP')}</div>
                        \`;

                        chatContainer.appendChild(messageDiv);
                        renderMathInNode(messageDiv);
                        attachCopyButtons(messageDiv);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }

                    function showTypingIndicator() {
                        hideTypingIndicator();
                        
                        const indicator = document.createElement('div');
                        indicator.className = 'message assistant';
                        indicator.id = 'typingIndicator';
                        indicator.innerHTML = \`
                            <div class="typing-indicator">
                                <span class="typing-dot"></span>
                                <span class="typing-dot"></span>
                                <span class="typing-dot"></span>
                            </div>
                        \`;
                        chatContainer.appendChild(indicator);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }

                    function hideTypingIndicator() {
                        const indicator = document.getElementById('typingIndicator');
                        if (indicator) indicator.remove();
                        isWaiting = false;
                    }

                    function showStatusMessage(text, type = 'info') {
                        if (statusMessageTimeout) {
                            clearTimeout(statusMessageTimeout);
                        }

                        let statusDiv = document.getElementById('statusMessage');
                        if (!statusDiv) {
                            statusDiv = document.createElement('div');
                            statusDiv.id = 'statusMessage';
                            statusDiv.className = \`status-message \${type}\`;
                            chatContainer.insertBefore(statusDiv, chatContainer.firstChild);
                        } else {
                            statusDiv.className = \`status-message \${type}\`;
                        }
                        
                        statusDiv.innerHTML = \`
                            <span>\${text}</span>
                        \`;

                        renderMathInNode(statusDiv);

                        statusMessageTimeout = setTimeout(() => {
                            if (statusDiv) statusDiv.remove();
                        }, 5000);
                    }

                    function updateArpUI(state) {
                        if (!state) return;

                        if (state.experimentId) {
                            experimentBadge.classList.remove('hidden');
                            experimentBadge.textContent = \`Exp: \${state.experimentId.slice(0, 8)}\`;
                        } else {
                            experimentBadge.classList.add('hidden');
                        }

                        if (state.phase) {
                            phaseBadge.classList.remove('hidden');
                            phaseBadge.textContent = state.phase.replace(/_/g, ' ');
                        } else {
                            phaseBadge.classList.add('hidden');
                        }

                        if (state.progressPct > 0) {
                            progressContainer.classList.remove('hidden');
                            progressFill.style.width = state.progressPct + '%';
                        } else {
                            progressContainer.classList.add('hidden');
                        }

                        const confirmationInFlight = Boolean(state.confirmationInFlight);
                        if (confirmationInFlight) {
                            actionPanel.classList.add('hidden');
                            actionPanelMode = 'none';
                            lockedQuestionId = '';
                            lockedActionId = '';
                            if (!lastConfirmationInFlight) {
                                showStatusMessage('Command is running in background...', 'info');
                            }
                            lastConfirmationInFlight = true;
                            return;
                        }
                        lastConfirmationInFlight = false;

                        if (state.pendingQuestion) {
                            const questionId = String(state.pendingQuestion.id || '');
                            const keepCustomAnswerOpen = actionPanelMode === 'question_custom' && lockedQuestionId && lockedQuestionId === questionId;
                            if (!keepCustomAnswerOpen) {
                                showQuestionPanel(state.pendingQuestion, state.lastSuggestedAnswer);
                            }
                        } else if (state.pendingAction) {
                            const actionId = String(state.pendingAction.action_id || '');
                            const keepDenyOpen = actionPanelMode === 'confirm_deny' && lockedActionId && lockedActionId === actionId;
                            if (!keepDenyOpen) {
                                showConfirmationPanel(state.pendingAction);
                            }
                        } else {
                            actionPanel.classList.add('hidden');
                            actionPanelMode = 'none';
                            lockedQuestionId = '';
                            lockedActionId = '';
                        }
                    }

                    function showQuestionPanel(question, suggestedAnswer) {
                        actionPanel.classList.remove('hidden');
                        actionPanelMode = 'none';
                        lockedQuestionId = String((question && question.id) || '');
                        actionTitle.textContent = 'Clarification Needed';
                        actionContent.textContent = question.text;
                        
                        if (question.options && question.options.length > 0) {
                            actionOptions.textContent = \`Options: \${question.options.join(', ')}\`;
                        } else {
                            actionOptions.textContent = '';
                        }

                        actionButtons.innerHTML = \`
                            <button class="btn primary" onclick="\${suggestedAnswer ? 'acceptQuestion()' : 'showCustomAnswer()'}">\${suggestedAnswer ? ('Accept "' + suggestedAnswer + '"') : 'Provide Answer'}</button>
                            \${suggestedAnswer ? '<button class="btn secondary" onclick="showCustomAnswer()">Custom Answer</button>' : ''}
                        \`;
                        
                        actionInput.classList.add('hidden');
                        actionInputField.value = '';
                    }

                    function showConfirmationPanel(action) {
                        actionPanel.classList.remove('hidden');
                        actionPanelMode = 'none';
                        lockedActionId = String((action && action.action_id) || '');
                        actionTitle.textContent = 'Action Required';
                        actionContent.textContent = action.action;
                        
                        let details = [];
                        if (action.reason) details.push(\`Reason: \${action.reason}\`);
                        if (action.cwd) details.push(\`Directory: \${action.cwd}\`);
                        if (action.file_operations) details.push(\`Files: \${action.file_operations.length}\`);
                        if (action.command) details.push(\`Command: \${action.command}\`);
                        if (Array.isArray(action.commands) && action.commands.length > 0) {
                            const first = action.commands[0];
                            const normalized = Array.isArray(first)
                                ? action.commands.map((cmd) => Array.isArray(cmd) ? cmd.join(' ') : String(cmd))
                                : [action.commands.join(' ')];
                            details.push(\`Commands: \${normalized.join(' | ')}\`);
                        }
                        
                        actionOptions.textContent = details.join(' | ');

                        actionButtons.innerHTML = \`
                            <button class="btn primary" onclick="acceptConfirm()">Accept & Execute</button>
                            <button class="btn danger" onclick="showDenyReason()">Deny</button>
                        \`;
                        
                        actionInput.classList.add('hidden');
                        actionInputField.value = '';
                    }

                    // Action Handlers
                    window.acceptQuestion = () => {
                        actionPanelMode = 'none';
                        lockedQuestionId = '';
                        vscode.postMessage({ command: 'acceptQuestion' });
                        actionPanel.classList.add('hidden');
                        showStatusMessage('Submitting answer...', 'info');
                    };

                    window.showCustomAnswer = () => {
                        actionPanelMode = 'question_custom';
                        lockedQuestionId = String((currentArpState && currentArpState.pendingQuestion && currentArpState.pendingQuestion.id) || lockedQuestionId || '');
                        actionButtons.innerHTML = '';
                        actionInput.classList.remove('hidden');
                        actionInputField.placeholder = 'Enter your custom answer...';
                        
                        const submitBtn = document.createElement('button');
                        submitBtn.className = 'btn primary';
                        submitBtn.textContent = 'Submit Answer';
                        submitBtn.onclick = () => {
                            const answer = actionInputField.value.trim();
                            if (answer) {
                                vscode.postMessage({
                                    command: 'denyQuestion',
                                    value: answer
                                });
                                actionPanelMode = 'none';
                                lockedQuestionId = '';
                                actionPanel.classList.add('hidden');
                                actionInputField.value = '';
                                showStatusMessage('Submitting custom answer...', 'info');
                            }
                        };
                        
                        const cancelBtn = document.createElement('button');
                        cancelBtn.className = 'btn secondary';
                        cancelBtn.textContent = 'Cancel';
                        cancelBtn.onclick = () => {
                            actionPanelMode = 'none';
                            actionInput.classList.add('hidden');
                            if (currentArpState?.pendingQuestion) {
                                showQuestionPanel(currentArpState.pendingQuestion, currentArpState.lastSuggestedAnswer);
                            }
                        };
                        
                        actionButtons.appendChild(submitBtn);
                        actionButtons.appendChild(cancelBtn);
                    };

                    window.acceptConfirm = () => {
                        actionPanelMode = 'none';
                        lockedActionId = '';
                        vscode.postMessage({ command: 'acceptConfirm' });
                        actionPanel.classList.add('hidden');
                        showStatusMessage('Executing action...', 'info');
                    };

                    window.showDenyReason = () => {
                        actionPanelMode = 'confirm_deny';
                        lockedActionId = String((currentArpState && currentArpState.pendingAction && currentArpState.pendingAction.action_id) || lockedActionId || '');
                        actionButtons.innerHTML = '';
                        actionInput.classList.remove('hidden');
                        actionInputField.placeholder = 'Reason for denial...';
                        
                        const submitBtn = document.createElement('button');
                        submitBtn.className = 'btn danger';
                        submitBtn.textContent = 'Submit Denial';
                        submitBtn.onclick = () => {
                            const reason = actionInputField.value.trim();
                            vscode.postMessage({
                                command: 'denyConfirm',
                                reason: reason
                            });
                            actionPanelMode = 'none';
                            lockedActionId = '';
                            actionPanel.classList.add('hidden');
                            actionInputField.value = '';
                            showStatusMessage('Denying action...', 'warning');
                        };
                        
                        const cancelBtn = document.createElement('button');
                        cancelBtn.className = 'btn secondary';
                        cancelBtn.textContent = 'Cancel';
                        cancelBtn.onclick = () => {
                            actionPanelMode = 'none';
                            actionInput.classList.add('hidden');
                            if (currentArpState?.pendingAction) {
                                showConfirmationPanel(currentArpState.pendingAction);
                            }
                        };
                        
                        actionButtons.appendChild(submitBtn);
                        actionButtons.appendChild(cancelBtn);
                    };

                    // Handle messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;

                        switch (message.command) {
                            case 'quantumReply':
                                hideTypingIndicator();
                                addMessage('assistant', message.text);
                                break;

                            case 'arpMessage':
                                hideTypingIndicator();
                                addMessage('assistant', message.message.content, message.message.type);
                                break;

                            case 'arpState':
                                currentArpState = message.state;
                                if (currentMode === 'arp') {
                                    updateArpUI(message.state);
                                }
                                break;

                            case 'backendStatus':
                                window.quantumConnected = message.quantum;
                                window.arpConnected = message.arp;
                                updateModeUI();
                                
                                if (!message.quantum && !message.arp) {
                                    showStatusMessage('Backend servers not responding', 'warning');
                                } else if (currentMode === 'arp' && !message.arp) {
                                    showStatusMessage('ARP backend not responding', 'warning');
                                } else if (currentMode === 'quantum' && !message.quantum) {
                                    showStatusMessage('Code backend not responding', 'warning');
                                }
                                break;

                            case 'status':
                                showStatusMessage(message.text, message.type || 'info');
                                break;

                            case 'experimentStatus':
                                if (currentMode === 'arp' && currentArpState) {
                                    currentArpState.progressPct = message.status.progress_pct || 0;
                                    updateArpUI(currentArpState);
                                }
                                break;

                            case 'error':
                                hideTypingIndicator();
                                showStatusMessage(message.text, 'error');
                                break;

                            case 'modeSwitched':
                                hideTypingIndicator();
                                break;

                            case 'showLoading':
                                showTypingIndicator();
                                break;

                            case 'hideLoading':
                                hideTypingIndicator();
                                break;

                            case 'clearChat':
                                clearChat();
                                break;
                        }
                    });

                    // Check backend health on load
                    vscode.postMessage({ command: 'checkBackend' });
                })();
            </script>
        </body>
        </html>`;
    }
}
