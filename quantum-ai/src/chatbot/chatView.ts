import * as vscode from 'vscode';

export class ChatViewProvider implements vscode.WebviewViewProvider {

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (message) => {

            if (message.command === "ask") {

                try {

                    const response = await fetch("http://localhost:8000/api/chat/message", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            query: message.text,
                            detail_level: "intermediate"
                        })
                    });

                    const data: any = await response.json();

                    webviewView.webview.postMessage({
                        command: "reply",
                        text: data.reply
                    });

                } catch (err: any) {

                    webviewView.webview.postMessage({
                        command: "reply",
                        text: "❌ Backend not running!"
                    });
                }
            }
        });
    }

    private getHtml(): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
            <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
            <style>
                :root {
                    color-scheme: dark;
                }

                body {
                    margin: 0;
                    padding: 0;
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }

                .app {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                    padding: 10px 10px 8px 10px;
                    gap: 8px;
                }

                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 6px 10px;
                    border-radius: 8px;
                    background-color: var(--vscode-sideBarSectionHeader-background, #252526);
                    border: 1px solid var(--vscode-panel-border, #3c3c3c);
                }

                .title {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }

                .title-main {
                    font-size: 13px;
                    font-weight: 600;
                }

                .title-sub {
                    font-size: 11px;
                    opacity: 0.8;
                }

                .status-pill {
                    font-size: 10px;
                    padding: 2px 8px;
                    border-radius: 999px;
                    border: 1px solid rgba(125, 211, 252, 0.35);
                    background: rgba(15, 23, 42, 0.7);
                    color: #7dd3fc;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    white-space: nowrap;
                }

                .status-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                    background: #22c55e;
                    box-shadow: 0 0 6px rgba(34, 197, 94, 0.7);
                }

                .chat {
                    flex: 1;
                    min-height: 0;
                    border-radius: 10px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border, #3c3c3c);
                    padding: 10px 10px 4px 10px;
                    overflow-y: auto;
                    scroll-behavior: smooth;
                }

                .chat::-webkit-scrollbar,
                .markdown pre::-webkit-scrollbar {
                    width: 0;
                    height: 0;
                }

                .chat {
                    scrollbar-width: none;
                }

                .markdown pre {
                    scrollbar-width: none;
                }

                .chat-empty-hint {
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    font-size: 12px;
                    opacity: 0.6;
                }

                .message {
                    display: flex;
                    margin-bottom: 8px;
                    gap: 6px;
                }

                .message-avatar {
                    width: 20px;
                    height: 20px;
                    border-radius: 999px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    flex-shrink: 0;
                }

                .message.user .message-avatar {
                    background: linear-gradient(135deg, #38bdf8, #6366f1);
                    color: white;
                }

                .message.ai .message-avatar {
                    background: linear-gradient(135deg, #22c55e, #16a34a);
                    color: white;
                }

                .message-body {
                    max-width: 100%;
                }

                .message-meta {
                    font-size: 10px;
                    opacity: 0.7;
                    margin-bottom: 2px;
                }

                .bubble {
                    border-radius: 10px;
                    padding: 8px 10px;
                    font-size: 12px;
                    line-height: 1.5;
                    word-wrap: break-word;
                    white-space: pre-wrap;
                }

                .message.user .bubble {
                    background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(56, 189, 248, 0.05));
                    border: 1px solid rgba(56, 189, 248, 0.4);
                }

                .message.ai .bubble {
                    background: linear-gradient(135deg, rgba(34, 197, 94, 0.12), rgba(34, 197, 94, 0.03));
                    border: 1px solid rgba(34, 197, 94, 0.4);
                }

                .message.system .bubble {
                    background: rgba(148, 163, 184, 0.1);
                    border: 1px dashed rgba(148, 163, 184, 0.6);
                    font-size: 11px;
                }

                .typing-dot {
                    width: 4px;
                    height: 4px;
                    border-radius: 999px;
                    background: rgba(148, 163, 184, 0.9);
                    animation: typing 1.2s infinite ease-in-out;
                }

                .typing-dot:nth-child(2) { animation-delay: 0.15s; }
                .typing-dot:nth-child(3) { animation-delay: 0.3s; }

                @keyframes typing {
                    0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
                    40% { transform: translateY(-3px); opacity: 1; }
                }

                .input-shell {
                    border-radius: 10px;
                    border: 1px solid var(--vscode-panel-border, #3c3c3c);
                    background-color: rgba(15, 23, 42, 0.96);
                    padding: 6px 8px 6px 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }

                .input-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                textarea {
                    flex: 1;
                    resize: none;
                    border: none;
                    outline: none;
                    padding: 6px 8px;
                    border-radius: 6px;
                    background-color: rgba(15, 23, 42, 0.98);
                    color: var(--vscode-editor-foreground);
                    font-size: 12px;
                    max-height: 80px;
                    overflow: hidden;
                }

                textarea::placeholder {
                    color: rgba(148, 163, 184, 0.9);
                }

                button.send {
                    border: none;
                    border-radius: 999px;
                    padding: 6px 12px;
                    font-size: 11px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    background: linear-gradient(135deg, #38bdf8, #6366f1);
                    color: white;
                    white-space: nowrap;
                }

                button.send:disabled {
                    opacity: 0.5;
                    cursor: default;
                }

                .kbd {
                    border-radius: 4px;
                    padding: 1px 4px;
                    border: 1px solid rgba(148, 163, 184, 0.5);
                    font-size: 9px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                }

                .markdown pre {
                    background: rgba(15, 23, 42, 0.95);
                    padding: 8px;
                    border-radius: 6px;
                    overflow-x: auto;
                    font-size: 11px;
                }

                .markdown code {
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                }
            </style>
        </head>
        <body>
            <div class="app">
                <div class="header">
                    <div class="title">
                        <div class="title-main">Quantum AI Assistant</div>
                        <div class="title-sub"></div>
                    </div>
                    <div class="status-pill">
                        <span class="status-dot"></span>
                        QuantumCodeHub
                    </div>
                </div>

                <div id="chat" class="chat">
                    <div id="emptyHint" class="chat-empty-hint">
                        Ask a question about your project, files or errors.
                    </div>
                </div>

                <div class="input-shell">
                    <div class="input-row">
                        <textarea id="input" rows="1" placeholder="Ask anything about this workspace... (Enter to send, Shift+Enter for newline)"></textarea>
                        <button id="sendButton" class="send">
                            <span>Send</span>
                        </button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                const chatEl = document.getElementById('chat');
                const inputEl = document.getElementById('input');
                const sendButtonEl = document.getElementById('sendButton');
                const emptyHintEl = document.getElementById('emptyHint');

                let isWaitingForReply = false;
                let typingMessageId = null;

                function scrollToBottom() {
                    chatEl.scrollTop = chatEl.scrollHeight;
                }

                function autoResizeInput() {
                    if (!inputEl) return;
                    inputEl.style.height = 'auto';
                    const maxHeight = 80;
                    const newHeight = Math.min(inputEl.scrollHeight, maxHeight);
                    inputEl.style.height = newHeight + 'px';
                }

                function hideEmptyHint() {
                    if (emptyHintEl && !emptyHintEl.dataset.hidden) {
                        emptyHintEl.style.display = 'none';
                        emptyHintEl.dataset.hidden = 'true';
                    }
                }

                function createMessageElement(role, contentHtml, metaText) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'message ' + role;

                    const avatar = document.createElement('div');
                    avatar.className = 'message-avatar';
                    avatar.textContent = role === 'user' ? 'You' : role === 'ai' ? 'AI' : '!';

                    const body = document.createElement('div');
                    body.className = 'message-body';

                    if (metaText) {
                        const meta = document.createElement('div');
                        meta.className = 'message-meta';
                        meta.textContent = metaText;
                        body.appendChild(meta);
                    }

                    const bubble = document.createElement('div');
                    bubble.className = 'bubble markdown';
                    bubble.innerHTML = contentHtml;
                    body.appendChild(bubble);

                    wrapper.appendChild(avatar);
                    wrapper.appendChild(body);
                    return wrapper;
                }

                function renderMathWithin(element) {
                    if (typeof renderMathInElement !== 'function') {
                        return;
                    }
                    try {
                        renderMathInElement(element, {
                            delimiters: [
                                { left: "$$", right: "$$", display: true },
                                { left: "$", right: "$", display: false },
                                { left: "\\(", right: "\\)", display: false },
                                { left: "\\[", right: "\\]", display: true }
                            ],
                            throwOnError: false
                        });
                    } catch (e) {
                        // ignore math render errors
                    }
                }

                function addSystemMessage(text) {
                    hideEmptyHint();
                    const html = marked.parse(text || '');
                    const el = createMessageElement('system', html, 'System');
                    chatEl.appendChild(el);
                    renderMathWithin(el);
                    scrollToBottom();
                }

                function addUserMessage(text) {
                    hideEmptyHint();
                    const safe = (text || '').trim();
                    const el = createMessageElement('user', safe, 'You');
                    chatEl.appendChild(el);
                    scrollToBottom();
                }

                function addAssistantMessage(markdownText) {
                    hideEmptyHint();
                    const html = marked.parse(markdownText || '');
                    const el = createMessageElement('ai', html, 'Assistant');
                    chatEl.appendChild(el);
                    renderMathWithin(el);
                    scrollToBottom();
                }

                function showTypingIndicator() {
                    hideEmptyHint();
                    const wrapper = document.createElement('div');
                    wrapper.className = 'message ai';
                    typingMessageId = 'typing-' + Date.now();
                    wrapper.dataset.id = typingMessageId;

                    const avatar = document.createElement('div');
                    avatar.className = 'message-avatar';
                    avatar.textContent = 'AI';

                    const body = document.createElement('div');
                    body.className = 'message-body';

                    const meta = document.createElement('div');
                    meta.className = 'message-meta';
                    meta.textContent = 'Assistant is thinking...';

                    const bubble = document.createElement('div');
                    bubble.className = 'bubble';

                    const dots = document.createElement('div');
                    dots.style.display = 'inline-flex';
                    dots.style.gap = '4px';

                    for (let i = 0; i < 3; i++) {
                        const d = document.createElement('div');
                        d.className = 'typing-dot';
                        dots.appendChild(d);
                    }

                    bubble.appendChild(dots);
                    body.appendChild(meta);
                    body.appendChild(bubble);
                    wrapper.appendChild(avatar);
                    wrapper.appendChild(body);

                    chatEl.appendChild(wrapper);
                    scrollToBottom();
                }

                function clearTypingIndicator() {
                    if (!typingMessageId) return;
                    const nodes = chatEl.querySelectorAll('[data-id="' + typingMessageId + '"]');
                    nodes.forEach(n => n.remove());
                    typingMessageId = null;
                }

                function setWaiting(state) {
                    isWaitingForReply = state;
                    sendButtonEl.disabled = state;
                }

                function send() {
                    const value = (inputEl.value || '').trim();
                    if (!value || isWaitingForReply) {
                        return;
                    }

                    addUserMessage(value);
                    inputEl.value = '';
                    autoResizeInput();
                    setWaiting(true);
                    showTypingIndicator();

                    vscode.postMessage({
                        command: 'ask',
                        text: value
                    });
                }

                sendButtonEl.addEventListener('click', () => {
                    send();
                });

                inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        send();
                    }
                });


                inputEl.addEventListener('input', () => {
                    autoResizeInput();
                });
                window.addEventListener('message', event => {
                    const data = event.data || {};
                    if (data.command && data.command !== 'reply') {
                        return;
                    }

                    clearTypingIndicator();
                    setWaiting(false);

                    if (!data.text) {
                        addSystemMessage('Received empty response from backend.');
                        return;
                    }

                    addAssistantMessage(data.text);
                });

                // Initial system hint
                addSystemMessage('Ask questions about your code, errors or documentation. The assistant will use your QuantumCodeHub backend to reason about the workspace.');
                autoResizeInput();
            </script>
        </body>
        </html>
        `;
    }
}