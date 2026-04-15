import * as vscode from "vscode";
import { ChatSessionController } from "./sessionController";
import type { ChatSessionState } from "./types";

type CreatePanelOptions = {
  title: string;
  autoScroll: boolean;
  defaultProjectRoot: string;
};

const WEBVIEW_BUILD_ID = "arp-rebuild-2026-02-26";

export class ArpChatPanel {
  public static current: ArpChatPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly controller: ChatSessionController;
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly autoScroll: boolean;
  private readonly defaultProjectRoot: string;

  constructor(
    context: vscode.ExtensionContext,
    controller: ChatSessionController,
    output: vscode.OutputChannel,
    options: CreatePanelOptions
  ) {
    this.controller = controller;
    this.output = output;
    this.autoScroll = options.autoScroll;
    this.defaultProjectRoot = options.defaultProjectRoot;

    this.panel = vscode.window.createWebviewPanel("arpAssistantChat", options.title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false
    });

    this.panel.webview.html = this.html();

    const unsub = this.controller.onUpdate((state) => this.postState(state));
    this.disposables.push({ dispose: unsub });

    this.panel.webview.onDidReceiveMessage((msg) => {
      void this.onMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.controller.dispose();
      this.dispose();
    });

    void this.controller.hydrateFromPersistedState();
    void context;
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    controller: ChatSessionController,
    output: vscode.OutputChannel,
    options: CreatePanelOptions
  ): ArpChatPanel {
    if (ArpChatPanel.current) {
      ArpChatPanel.current.panel.dispose();
      ArpChatPanel.current = null;
    }
    ArpChatPanel.current = new ArpChatPanel(context, controller, output, options);
    return ArpChatPanel.current;
  }

  public dispose(): void {
    ArpChatPanel.current = null;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case "webviewReady":
          this.output.appendLine(`ARP webview ready: ${String(message.buildId || "unknown")}`);
          break;
        case "askQuery":
          await this.controller.startFromChatQuery(
            String(message.query || ""),
            String(message.researchType || "ai").toLowerCase() === "quantum" ? "quantum" : "ai",
            String(message.projectRoot || "")
          );
          break;
        case "acceptQuestion":
          await this.controller.acceptQuestion();
          break;
        case "denyQuestion":
          await this.controller.denyQuestionEdit(String(message.value || ""));
          break;
        case "acceptConfirm":
          await this.controller.acceptConfirm();
          break;
        case "denyConfirm":
          await this.controller.denyConfirm(String(message.reason || ""), String(message.alternativePreference || ""));
          break;
        case "newChat":
          await this.controller.startFreshSession();
          break;
        case "uiError":
          this.output.appendLine(`ARP UI error: ${String(message.error || "unknown")}`);
          break;
        default:
          break;
      }
    } catch (error) {
      this.output.appendLine(`ARP action error: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`ARP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.postState(this.controller.getState());
    }
  }

  private postState(state: ChatSessionState): void {
    this.panel.webview.postMessage({ type: "state", state });
  }

  private html(): string {
    const autoScroll = this.autoScroll ? "true" : "false";
    const defaultRoot = this.defaultProjectRoot.replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ARP Assistant</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-panel-border);
      --sidebar: color-mix(in srgb, var(--bg) 95%, #0c1620);
      --surface: color-mix(in srgb, var(--bg) 97%, #0f1e2a);
      --assistant: color-mix(in srgb, var(--bg) 89%, #244157);
      --user: color-mix(in srgb, var(--bg) 87%, #2f5a84);
      --system: color-mix(in srgb, var(--bg) 90%, #5a4a2f);
      --btn: var(--vscode-button-background);
      --btnfg: var(--vscode-button-foreground);
      --inputbg: var(--vscode-input-background);
      --inputfg: var(--vscode-input-foreground);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
      display: grid;
      grid-template-columns: 330px 1fr;
      height: 100%;
      background: var(--bg);
      color: var(--fg);
      font-family: "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .left {
      border-right: 1px solid var(--line);
      background: var(--sidebar);
      display: grid;
      grid-template-rows: auto auto auto 1fr;
      min-height: 0;
    }
    .card { padding: 12px; border-bottom: 1px solid var(--line); }
    .title { font-weight: 700; font-size: 15px; }
    .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .chip { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: 12px; display: inline-block; margin: 2px 4px 2px 0; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--inputbg);
      color: var(--inputfg);
      padding: 8px;
      font-family: inherit;
      font-size: 13px;
    }
    textarea { min-height: 110px; resize: vertical; }
    .row { display: flex; gap: 8px; }
    button {
      border: 0;
      border-radius: 8px;
      background: var(--btn);
      color: var(--btnfg);
      padding: 8px 10px;
      font-weight: 600;
      cursor: pointer;
    }
    button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }

    .main {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 0;
      background: var(--surface);
    }
    .header {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .timeline {
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .msg {
      max-width: 88%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .assistant { background: var(--assistant); margin-right: auto; }
    .user { background: var(--user); margin-left: auto; }
    .system { background: var(--system); margin-right: auto; }
    .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }

    .composer {
      border-top: 1px solid var(--line);
      padding: 10px 12px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
  </style>
</head>
<body>
  <aside class="left">
    <div class="card">
      <div class="title">ARP Chatbot</div>
      <div class="sub">Copilot-style guided research workflow</div>
    </div>

    <div class="card" id="meta"></div>

    <div class="card">
      <div class="label">Workflow Setup</div>
      <textarea id="workflowPrompt" placeholder="Example: Build and evaluate a quantum-classical classifier on synthetic data."></textarea>
      <div style="height:8px"></div>
      <input id="projectRoot" value="${defaultRoot}" placeholder="Optional project root override" />
      <div style="height:8px"></div>
      <div class="row">
        <button id="startAiBtn" class="ghost">Start AI</button>
        <button id="startQuantumBtn" class="ghost">Start Quantum</button>
      </div>
      <div style="height:8px"></div>
      <button id="newChatBtn" class="ghost">New Session</button>
    </div>

    <div class="card">
      <div class="sub">Build: ${WEBVIEW_BUILD_ID}</div>
    </div>
  </aside>

  <main class="main">
    <div class="header">
      <div>
        <div class="title">Conversation</div>
        <div class="sub">Clarifications and approvals appear here.</div>
      </div>
      <span class="chip">Interactive</span>
    </div>

    <section class="timeline" id="timeline"></section>

    <div class="composer">
      <input id="queryInput" placeholder="Describe what you want to research..." />
      <button id="sendQueryBtn">Start</button>
    </div>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const autoScroll = ${autoScroll};

    const timeline = document.getElementById("timeline");
    const meta = document.getElementById("meta");
    const workflowPrompt = document.getElementById("workflowPrompt");
    const queryInput = document.getElementById("queryInput");
    const projectRoot = document.getElementById("projectRoot");

    let state = null;
    let actionBusy = false;

    function esc(v) {
      return String(v || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function post(type, payload = {}) {
      vscode.postMessage({ type, ...payload });
    }

    function renderMeta() {
      if (!state || !state.experimentId) {
        meta.innerHTML = '<span class="chip">No active workflow</span>';
        return;
      }
      meta.innerHTML = [
        '<span class="chip">Exp: ' + esc(state.experimentId) + '</span>',
        '<span class="chip">Status: ' + esc(state.status) + '</span>',
        '<span class="chip">Phase: ' + esc(state.phase || '-') + '</span>',
        '<span class="chip">Type: ' + esc(state.researchType || 'ai') + '</span>',
        '<span class="chip">Progress: ' + esc(state.progressPct || 0) + '%</span>'
      ].join('');
    }

    function renderTimeline() {
      const messages = (state && state.messages) ? state.messages : [];
      if (!messages.length) {
        timeline.innerHTML = '<div class="msg system">No messages yet. Enter a research prompt and click Start.</div>';
        return;
      }

      let html = "";
      for (const m of messages) {
        const cls = m.role === "user" ? "user" : (m.role === "assistant" ? "assistant" : "system");
        html += '<div class="msg ' + cls + '">' + esc(m.content) + '</div>';
      }

      if (state && state.pendingQuestion) {
        const q = state.pendingQuestion;
        html += '<div class="msg system">';
        html += '<strong>Clarification:</strong> ' + esc(q.text);
        html += '<div class="actions">';
        html += '<button data-action="acceptQuestion">Accept Suggested</button>';
        html += '<input id="denyQuestionInput" value="' + esc(state.lastSuggestedAnswer || '') + '" placeholder="Custom answer" />';
        html += '<button data-action="denyQuestion">Deny / Send Custom Answer</button>';
        html += '</div></div>';
      }

      if (state && state.pendingAction) {
        html += '<div class="msg system">';
        html += '<strong>Approval:</strong> ' + esc(state.pendingAction.action || 'action');
        html += '<div class="actions">';
        html += '<button data-action="acceptConfirm">Accept and Execute</button>';
        html += '<input id="denyReasonInput" placeholder="Deny reason (optional)" />';
        html += '<button data-action="denyConfirm">Deny</button>';
        html += '</div></div>';
      }

      timeline.innerHTML = html;
      if (autoScroll) {
        requestAnimationFrame(() => {
          timeline.scrollTop = timeline.scrollHeight;
        });
      }
    }

    function startWorkflow(researchType, prompt) {
      const query = (prompt || "").trim();
      if (!query) return;
      const root = (projectRoot.value || "").trim();
      post("askQuery", {
        query,
        researchType,
        projectRoot: root
      });
      queryInput.value = "";
    }

    function startFromComposer() {
      const query = (queryInput.value || "").trim();
      if (!query) return;
      if (state && state.pendingQuestion) {
        post("denyQuestion", { value: query });
        queryInput.value = "";
        return;
      }
      startWorkflow("ai", query);
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const button = target.closest("button");
      if (!button) return;
      const id = button.id || "";

      if (id === "sendQueryBtn") return startFromComposer();
      if (id === "startAiBtn") return startWorkflow("ai", workflowPrompt.value || "");
      if (id === "startQuantumBtn") return startWorkflow("quantum", workflowPrompt.value || "");
      if (id === "newChatBtn") return post("newChat");

      const action = button.getAttribute("data-action");
      if (!action) return;

      if (action === "acceptQuestion") {
        if (actionBusy) return;
        actionBusy = true;
        return post("acceptQuestion");
      }
      if (action === "denyQuestion") {
        if (actionBusy) return;
        const input = document.getElementById("denyQuestionInput");
        const value = input ? input.value : "";
        actionBusy = true;
        return post("denyQuestion", { value });
      }
      if (action === "acceptConfirm") {
        if (actionBusy) return;
        actionBusy = true;
        return post("acceptConfirm");
      }
      if (action === "denyConfirm") {
        if (actionBusy) return;
        const input = document.getElementById("denyReasonInput");
        const reason = input ? input.value : "";
        actionBusy = true;
        return post("denyConfirm", { reason, alternativePreference: "" });
      }
    });

    queryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        startFromComposer();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") {
        actionBusy = false;
        state = message.state;
        if (state && state.inputPlaceholder) {
          queryInput.placeholder = state.inputPlaceholder;
        }
        renderMeta();
        renderTimeline();
      }
    });

    window.addEventListener("error", (event) => {
      post("uiError", { error: String(event.message || "unknown") });
    });

    post("webviewReady", { buildId: "${WEBVIEW_BUILD_ID}" });
  </script>
</body>
</html>`;
  }
}
