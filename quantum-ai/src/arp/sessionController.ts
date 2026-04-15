import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { ArpApiClient } from "./apiClient";
import type {
  ChatMessage,
  ChatSessionState,
  ClarificationQuestion,
  ConfirmationAction,
  ExperimentLogEntry,
  ExperimentLifecycleStatus,
  PendingQuestionPayload,
  StatusData
} from "./types";

type UpdateListener = (state: ChatSessionState) => void;

type SessionControllerOptions = {
  pollIntervalMs: number;
};

type CommandProbeResult = {
  returncode: number;
  stdout: string;
  stderr: string;
};

type CommandRunResult = {
  command: string;
  returncode: number;
  stdout: string;
  stderr: string;
  duration_sec: number;
};

type PersistedArpSession = {
  experimentId: string;
  researchType: "ai" | "quantum";
};

export class ChatSessionController {
  private static readonly fetchedTerminalArtifactsByExperiment = new Set<string>();
  private readonly api: ArpApiClient;
  private readonly context?: vscode.ExtensionContext;
  private readonly options: SessionControllerOptions;
  private readonly listeners = new Set<UpdateListener>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollBusy = false;
  private pollErrorCount = 0;
  private lastPollErrorMessage = "";
  private messageCounter = 0;
  private terminalArtifactsFetched = false;
  private lastAnnouncedActionId: string | null = null;
  private lastAnnouncedQuestionId: string | null = null;
  private actionTerminal: vscode.Terminal | null = null;
  private runtimeContextCache:
    | { hardwareTarget: "cpu" | "cuda"; localPythonCommand: string; localHardwareProfile: Record<string, unknown> }
    | null = null;
  private confirmationInFlight = false;
  private confirmationActionId: string | null = null;
  private backendAutoAllowResearch = false;
  private lastLiveMessageAt = 0;
  private lastLiveMessageText = "";
  private lastBackendLatencyNoticeAt = 0;
  private seenLogIds = new Set<string>();
  private logStreamPrimedExperimentId: string | null = null;

  private state: ChatSessionState = {
    experimentId: null,
    status: "idle",
    phase: null,
    researchType: "ai",
    executionMode: null,
    executionTarget: null,
    progressPct: 0,
    confirmationInFlight: false,
    pendingQuestion: null,
    pendingAction: null,
    lastSuggestedAnswer: "",
    inputPlaceholder: "Describe what you want to research...",
    messages: [],
    polling: {
      enabled: false,
      intervalMs: 3000
    }
  };

  private readonly persistKey = "arp.session.v1";

  constructor(api: ArpApiClient, context: vscode.ExtensionContext | undefined, options: SessionControllerOptions) {
    this.api = api;
    this.context = context;
    this.options = options;
    this.state.polling.intervalMs = options.pollIntervalMs;
  }

  getState(): ChatSessionState {
    return { ...this.state, messages: [...this.state.messages] };
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopPolling();
    if (this.actionTerminal) {
      this.actionTerminal.dispose();
      this.actionTerminal = null;
    }
    this.listeners.clear();
  }

  async hydrateFromPersistedState(): Promise<boolean> {
    if (!this.context) {
      return false;
    }
    const persisted = this.context.globalState.get<PersistedArpSession | null>(this.persistKey, null);
    if (!persisted || !persisted.experimentId) {
      return false;
    }
    this.state.experimentId = persisted.experimentId;
    this.resetLogStreamTracking();
    this.state.researchType = persisted.researchType === "quantum" ? "quantum" : "ai";
    this.state.status = "pending";
    this.state.phase = this.state.phase || "clarifier";
    this.pushMessage("system", "status", `Resuming experiment: ${persisted.experimentId}`);

    try {
      const status = await this.api.getStatus(persisted.experimentId);
      this.applyStatus(status);
      const pendingAction = status.pending_action || null;
      const pendingQuestion = this.extractQuestion(status.pending_questions);
      this.state.pendingAction = pendingAction;
      this.state.pendingQuestion = pendingAction ? null : pendingQuestion;
      await this.resumeRunningExperimentIfNeeded(status, pendingAction, pendingQuestion);
      if (this.isTerminal(this.state.status)) {
        this.state.pendingAction = null;
        this.state.pendingQuestion = null;
        this.stopPolling();
      } else {
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
      return true;
    } catch (error) {
      this.pushMessage("system", "error", error instanceof Error ? error.message : "Failed to restore previous session");
      await this.clearPersistedSession();
      this.state.experimentId = null;
      this.state.status = "idle";
      this.state.phase = null;
      this.state.pendingAction = null;
      this.state.pendingQuestion = null;
      this.updateInputPlaceholder();
      this.notify();
      return false;
    }
  }

  private async resumeRunningExperimentIfNeeded(
    status: StatusData,
    pendingAction: ConfirmationAction | null,
    pendingQuestion: ClarificationQuestion | null
  ): Promise<void> {
    if (!this.state.experimentId) {
      return;
    }
    const lifecycle = this.normalizeStatus(status.status);
    if (lifecycle !== "running" && lifecycle !== "pending") {
      return;
    }
    if (pendingAction || pendingQuestion) {
      return;
    }
    const phase = String(status.phase || "").trim();
    if (!phase || phase === "finished" || phase === "aborted") {
      return;
    }

    try {
      const resumed = await this.api.retryExperiment(this.state.experimentId, phase, false, {});
      const resumedStatus = this.normalizeStatus(String(resumed.status || lifecycle));
      this.state.status = resumedStatus;
      this.state.phase = phase;
      this.pushMessage("system", "status", `Continue requested from phase: ${phase}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resume request failed";
      this.pushMessage("system", "error", `Could not auto-resume backend run: ${message}`);
    }
  }

  async startFreshSession(): Promise<void> {
    this.stopPolling();
    this.resetLogStreamTracking();
    this.terminalArtifactsFetched = false;
    this.pollErrorCount = 0;
    this.lastPollErrorMessage = "";
    this.state.experimentId = null;
    this.state.status = "idle";
    this.state.phase = null;
    this.state.progressPct = 0;
    this.state.pendingQuestion = null;
    this.state.pendingAction = null;
    this.state.confirmationInFlight = false;
    this.state.lastSuggestedAnswer = "";
    this.state.inputPlaceholder = "Describe what you want to research...";
    this.state.messages = [];
    this.backendAutoAllowResearch = false;
    this.lastAnnouncedActionId = null;
    this.lastAnnouncedQuestionId = null;
    await this.clearPersistedSession();
    this.notify();
  }

  async startFromChatQuery(query: string, researchType: "ai" | "quantum", projectRoot = ""): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    if (this.state.experimentId && this.state.status === "waiting_user" && this.state.pendingQuestion) {
      this.pushMessage("system", "status", "Clarification is pending. Use Accept or Custom Answer on the question card.");
      this.updateInputPlaceholder();
      this.notify();
      return;
    }
    if (this.state.experimentId && this.state.status === "waiting_user" && this.state.pendingAction) {
      this.pushMessage("system", "status", "Approval is pending. Use Accept or Deny on the current action.");
      this.updateInputPlaceholder();
      this.notify();
      return;
    }
    if (this.state.experimentId && (this.state.status === "running" || this.state.status === "pending")) {
      this.pushMessage("system", "status", "Workflow is already running. Wait for the next user-required step.");
      this.updateInputPlaceholder();
      this.notify();
      return;
    }
    if (trimmed.length < 10) {
      this.pushMessage("system", "error", "Prompt must be at least 10 characters to start a new experiment.");
      this.updateInputPlaceholder();
      this.notify();
      return;
    }

    const configOverrides: Record<string, unknown> = {
      research_type: researchType,
      research_mode: researchType,
      default_allow_research: this.defaultAllowResearchEnabled()
    };
    if (projectRoot.trim()) {
      configOverrides.project_root = projectRoot.trim();
    }
    await this.startFromUserPrompt(trimmed, "normal", configOverrides);
  }

  async startFromUserPrompt(prompt: string, _priority: string, configOverrides: Record<string, unknown>): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    this.stopPolling();
    this.resetLogStreamTracking();
    this.terminalArtifactsFetched = false;
    this.pollErrorCount = 0;
    this.lastPollErrorMessage = "";
    this.state.experimentId = null;
    this.state.status = "pending";
    this.state.phase = "clarifier";
    this.state.messages = [];
    this.state.pendingQuestion = null;
    this.state.pendingAction = null;
    this.state.confirmationInFlight = false;
    this.state.progressPct = 0;
    this.lastAnnouncedActionId = null;
    this.lastAnnouncedQuestionId = null;
    this.backendAutoAllowResearch = false;
    this.pushMessage("user", "text", trimmed);

    const researchType = String(configOverrides.research_type || configOverrides.research_mode || "ai").toLowerCase().includes("quantum")
      ? "quantum"
      : "ai";

    try {
      const projectRootOverride = String(configOverrides.project_root || "").trim();
      const runtimeContext = await this.collectRuntimeContext(projectRootOverride);
      const mergedOverrides: Record<string, unknown> = {
        ...configOverrides,
        default_allow_research: this.defaultAllowResearchEnabled(),
        execution_mode: "vscode_extension",
        local_python_command: runtimeContext.localPythonCommand,
        local_hardware_profile: runtimeContext.localHardwareProfile
      };
      if (!mergedOverrides.hardware_target) {
        mergedOverrides.hardware_target = runtimeContext.hardwareTarget;
      }
      const gpuName = String(runtimeContext.localHardwareProfile.gpu_name || "").trim();
      const packageCount = Number(runtimeContext.localHardwareProfile.python_packages_count || 0);
      this.pushMessage(
        "system",
        "status",
        `Hardware diagnostics: target=${runtimeContext.hardwareTarget}, python=${runtimeContext.localPythonCommand}${gpuName ? `, gpu=${gpuName}` : ""}, installed_packages=${packageCount}`
      );

      const start = await this.api.startExperiment(trimmed, researchType, mergedOverrides);
      this.state.experimentId = start.experiment_id;
      this.state.status = this.normalizeStatus(start.status);
      this.state.phase = start.phase;
      this.state.researchType = start.research_type === "quantum" ? "quantum" : researchType;
      this.state.executionMode = start.execution_mode || null;
      this.state.executionTarget = start.execution_target || null;
      this.backendAutoAllowResearch = Boolean(start.default_allow_research);
      this.pushMessage("assistant", "status", `Experiment started: ${start.experiment_id}`);

      const question = this.extractQuestion(start.pending_questions);
      if (question) {
        if (this.autoResearchEnabled()) {
          await this.autoAnswerQuestion(question, "startup");
        } else {
          this.setPendingQuestion(question);
        }
      } else {
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
    } catch (error) {
      this.state.status = "idle";
      this.state.phase = null;
      this.state.experimentId = null;
      this.state.pendingQuestion = null;
      this.state.pendingAction = null;
      const code = String((error as { code?: unknown })?.code || "").trim().toUpperCase();
      const message = error instanceof Error ? error.message : "Failed to start workflow";
      if (code === "UNSUPPORTED_RESEARCH_DOMAIN") {
        this.pushMessage(
          "system",
          "error",
          "Only AI and Quantum research prompts are supported. Rephrase your prompt as an AI/ML or Quantum research task."
        );
      } else if (code === "DOMAIN_CLASSIFIER_UNAVAILABLE") {
        this.pushMessage(
          "system",
          "error",
          "Domain classifier is temporarily unavailable. Retry in a moment."
        );
      } else {
        this.pushMessage("system", "error", message);
      }
      this.updateInputPlaceholder();
      this.notify();
    }
  }

  async submitCustomClarification(value: string): Promise<void> {
    if (!this.state.pendingQuestion) {
      return;
    }
    await this.submitClarification(this.state.pendingQuestion, value);
  }

  async acceptQuestion(): Promise<void> {
    if (!this.state.pendingQuestion) {
      return;
    }
    const value = this.suggestedAnswer(this.state.pendingQuestion);
    if (typeof value === "string" && value.trim() === "") {
      this.pushMessage("system", "error", "No suggested answer for this question. Use Custom Answer.");
      this.updateInputPlaceholder();
      this.notify();
      return;
    }
    await this.submitClarification(this.state.pendingQuestion, value);
  }

  async denyQuestionEdit(value: string): Promise<void> {
    if (!this.state.pendingQuestion) {
      return;
    }
    await this.submitClarification(this.state.pendingQuestion, value);
  }

  async acceptConfirm(): Promise<void> {
    if (!this.state.pendingAction || !this.state.experimentId) {
      return;
    }
    const actionId = String(this.state.pendingAction.action_id || "").trim();
    if (this.confirmationInFlight) {
      const runningId = this.confirmationActionId ? ` (${this.confirmationActionId})` : "";
      this.pushMessage("system", "status", `Another action is already running${runningId}. Please wait for it to finish.`);
      this.notify();
      return;
    }
    this.confirmationInFlight = true;
    this.state.confirmationInFlight = true;
    this.confirmationActionId = actionId || null;
    const wasPolling = this.state.polling.enabled;
    if (wasPolling) {
      this.stopPolling();
    }
    this.pushMessage(
      "system",
      "status",
      `Executing local action '${this.state.pendingAction.action}' and waiting for completion before backend confirmation...`
    );
    this.notify();
    try {
      const executionResult = await this.executePendingAction(this.state.pendingAction);
      await this.submitConfirmation("confirm", "", "", executionResult);
      if (wasPolling && !this.state.polling.enabled && !this.state.pendingAction && !this.isTerminal(this.state.status)) {
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
    } finally {
      this.confirmationInFlight = false;
      this.state.confirmationInFlight = false;
      this.confirmationActionId = null;
      if (wasPolling && !this.state.polling.enabled && !this.state.pendingAction && !this.isTerminal(this.state.status)) {
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
    }
  }

  async denyConfirm(reason: string, alternativePreference: string): Promise<void> {
    await this.submitConfirmation("deny", reason, alternativePreference);
  }

  private async submitClarification(question: ClarificationQuestion, value: unknown): Promise<void> {
    if (!this.state.experimentId) {
      return;
    }
    const cleaned = typeof value === "string" ? value.trim() : value;
    if (cleaned === "") {
      this.pushMessage("system", "error", "Answer cannot be empty.");
      this.notify();
      return;
    }

    try {
      this.pushMessage("user", "text", `${question.text}\nAnswer: ${String(cleaned)}`);
      const data = await this.api.answerQuestion(this.state.experimentId, question.id, cleaned);
      this.state.status = this.normalizeStatus(data.status);
      this.state.phase = data.phase;
      this.state.researchType = data.research_type === "quantum" ? "quantum" : this.state.researchType;
      this.state.pendingAction = null;

      const nextQuestion = this.extractQuestion(data.pending_questions);
      if (nextQuestion && this.state.status === "waiting_user") {
        if (this.autoResearchEnabled()) {
          this.state.pendingQuestion = null;
          this.startPolling();
        } else {
          this.setPendingQuestion(nextQuestion);
        }
      } else {
        this.state.pendingQuestion = null;
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
    } catch (error) {
      this.pushMessage("system", "error", error instanceof Error ? error.message : "Failed to submit answer");
      this.updateInputPlaceholder();
      this.notify();
    }
  }

  private async submitConfirmation(
    decision: "confirm" | "deny",
    reason = "",
    alternativePreference = "",
    executionResult?: Record<string, unknown>
  ): Promise<void> {
    if (!this.state.experimentId || !this.state.pendingAction) {
      return;
    }
    const current = this.state.pendingAction;

    try {
      this.pushMessage("user", "text", `${decision.toUpperCase()}: ${current.action}`);
      if (decision === "confirm" && executionResult) {
        const returncode = Number(executionResult.returncode ?? 1);
        const stderr = String(executionResult.stderr || "").trim();
        if (returncode !== 0) {
          this.pushMessage(
            "system",
            "error",
            `Local action failed before backend confirmation (${current.action}). returncode=${returncode}${stderr ? `\n${stderr.slice(0, 600)}` : ""}`
          );
        } else {
          this.pushMessage("system", "status", `Local action succeeded: ${current.action}`);
        }
      }
      const data = await this.api.submitConfirmation(
        this.state.experimentId,
        current.action_id,
        decision,
        reason,
        alternativePreference,
        executionResult
      );

      this.state.status = this.normalizeStatus(data.status);
      this.state.phase = data.phase;
      this.state.pendingQuestion = null;
      this.state.pendingAction = data.pending_action || null;
      this.lastAnnouncedQuestionId = null;

      if (this.state.pendingAction) {
        const actionId = String(this.state.pendingAction.action_id || "");
        if (!this.autoResearchEnabled() && actionId && actionId !== this.lastAnnouncedActionId) {
          this.lastAnnouncedActionId = actionId;
          this.pushMessage("assistant", "confirmation", this.describeConfirmation(this.state.pendingAction));
        }
      } else {
        this.lastAnnouncedActionId = null;
        this.startPolling();
      }
      this.updateInputPlaceholder();
      this.notify();
    } catch (error) {
      this.pushMessage("system", "error", error instanceof Error ? error.message : "Failed to confirm action");
      this.updateInputPlaceholder();
      this.notify();
    }
  }

  private startPolling(): void {
    if (!this.state.experimentId || this.pollTimer) {
      return;
    }
    this.pollErrorCount = 0;
    this.lastPollErrorMessage = "";
    this.state.polling.enabled = true;
    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, this.options.pollIntervalMs);
    void this.pollTick();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.state.polling.enabled = false;
  }

  private async pollTick(): Promise<void> {
    if (!this.state.experimentId || this.pollBusy || this.confirmationInFlight) {
      return;
    }
    this.pollBusy = true;
    try {
      const started = Date.now();
      const status = await this.api.getStatus(this.state.experimentId);
      const latencyMs = Date.now() - started;
      this.pollErrorCount = 0;
      this.lastPollErrorMessage = "";
      this.applyStatus(status);
      await this.streamIncrementalLogs(this.state.experimentId);
      this.maybeNotifyBackendLatency(latencyMs);
      const autoMode = this.autoResearchEnabled();

      if (this.state.status === "waiting_user") {
        if (status.pending_action && status.pending_action.action_id) {
          if (!this.state.pendingAction || this.state.pendingAction.action_id !== status.pending_action.action_id) {
            this.state.pendingAction = status.pending_action;
            this.state.pendingQuestion = null;
            this.lastAnnouncedQuestionId = null;
            const actionId = String(status.pending_action.action_id || "");
            if (!autoMode && actionId && actionId !== this.lastAnnouncedActionId) {
              this.lastAnnouncedActionId = actionId;
              this.pushMessage("assistant", "confirmation", this.describeConfirmation(status.pending_action));
            }
          }
          if (autoMode && !this.confirmationInFlight) {
            await this.acceptConfirm();
            return;
          }
        } else {
          this.state.pendingAction = null;
          const questionFromStatus = this.extractQuestion(status.pending_questions);
          if (questionFromStatus) {
            if (autoMode) {
              await this.autoAnswerQuestion(questionFromStatus, "poll");
              return;
            }
            this.setPendingQuestion(questionFromStatus);
          } else if (!this.state.pendingQuestion) {
            await this.refreshPendingQuestion();
            if (autoMode && this.state.pendingQuestion) {
              await this.autoAnswerQuestion(this.state.pendingQuestion, "poll");
              return;
            }
          }
        }
      } else {
        this.lastAnnouncedActionId = null;
      }

      if (this.isTerminal(this.state.status)) {
        this.stopPolling();
        this.state.pendingQuestion = null;
        this.state.pendingAction = null;
        const terminalNote = this.buildTerminalSummary();
        if (terminalNote) {
          this.pushMessage("assistant", "summary", terminalNote);
        }
        await this.fetchTerminalArtifacts();
      }

      this.updateInputPlaceholder();
      this.notify();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Polling failed";
      this.pollErrorCount += 1;
      const repeated = this.lastPollErrorMessage === message;
      this.lastPollErrorMessage = message;
      if (!repeated || this.pollErrorCount <= 2) {
        this.pushMessage("system", "error", message);
      }
      if (this.pollErrorCount >= 3) {
        this.stopPolling();
        this.pushMessage("system", "status", "Polling paused due to backend interruption. Reopen ARP mode to resume.");
      }
      this.updateInputPlaceholder();
      this.notify();
    } finally {
      this.pollBusy = false;
    }
  }

  private async refreshPendingQuestion(): Promise<void> {
    if (!this.state.experimentId) {
      return;
    }
    try {
      const details = await this.api.getExperiment(this.state.experimentId);
      const question = this.extractQuestion(details.pending_questions);
      if (question) {
        this.setPendingQuestion(question);
      }
    } catch {
      // no-op; status polling will continue
    }
  }

  private async fetchTerminalArtifacts(): Promise<void> {
    if (!this.state.experimentId || this.terminalArtifactsFetched) {
      return;
    }
    const experimentId = String(this.state.experimentId || "").trim();
    if (!experimentId) {
      return;
    }
    if (ChatSessionController.fetchedTerminalArtifactsByExperiment.has(experimentId)) {
      this.terminalArtifactsFetched = true;
      return;
    }
    this.terminalArtifactsFetched = true;
    ChatSessionController.fetchedTerminalArtifactsByExperiment.add(experimentId);
    try {
      const results = await this.api.getResults(experimentId);
      const hasResultPayload =
        results &&
        typeof results === "object" &&
        Object.keys(results as Record<string, unknown>).length > 0;
      if (hasResultPayload) {
        this.pushMessage("assistant", "summary", `Results:\n${this.pretty(results)}`);
      } else if (this.state.status === "failed") {
        this.pushMessage("assistant", "summary", "No metrics were produced before failure.");
      }
    } catch (error) {
      this.pushMessage("system", "error", error instanceof Error ? error.message : "Failed to fetch results");
    }

    if (this.state.status === "success") {
      try {
        const report = await this.api.getReport(experimentId);
        const content = this.reportToText(report.content);
        if (content.trim()) {
          this.pushMessage("assistant", "summary", `Research Report:\n${content.slice(0, 6000)}`);
          const downloadPath = await this.saveReportToDownloads(content, experimentId, String(report.report_path || ""));
          if (downloadPath) {
            this.pushMessage("system", "status", `Report downloaded: ${downloadPath}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch report";
        if (!/report not available yet/i.test(message)) {
          this.pushMessage("system", "error", message);
        }
      }
    }

    if (this.state.status === "failed") {
      await this.fetchFailureDiagnostics();
    }
  }

  private async fetchFailureDiagnostics(): Promise<void> {
    if (!this.state.experimentId) {
      return;
    }
    try {
      const logs = await this.api.getLogs(this.state.experimentId, 150);
      const entries = Array.isArray(logs.logs) ? logs.logs : [];
      const critical = entries
        .filter((entry) => this.isErrorLog(entry))
        .slice(0, 5)
        .map((entry) => this.formatLog(entry))
        .filter((line) => line.length > 0);

      if (critical.length > 0) {
        this.pushMessage("system", "error", `Failure diagnostics:\n${critical.join("\n")}`);
      } else {
        this.pushMessage("system", "status", "Failure diagnostics are not available in backend logs yet.");
      }
    } catch (error) {
      this.pushMessage("system", "error", error instanceof Error ? error.message : "Failed to fetch failure diagnostics");
    }
  }

  private resetLogStreamTracking(): void {
    this.seenLogIds.clear();
    this.logStreamPrimedExperimentId = null;
  }

  private buildTerminalSummary(): string {
    const phaseText = this.state.phase ? ` (phase: ${this.state.phase})` : "";
    if (this.state.status === "success") {
      return `Workflow completed successfully${phaseText}.`;
    }
    if (this.state.status === "failed") {
      return `Workflow failed${phaseText}. Fetching diagnostics...`;
    }
    if (this.state.status === "aborted") {
      return `Workflow aborted${phaseText}.`;
    }
    return `Workflow ${this.state.status}${phaseText}.`;
  }

  private async streamIncrementalLogs(experimentId: string): Promise<void> {
    try {
      const response = await this.api.getLogs(experimentId, 80);
      const entries = Array.isArray(response.logs) ? response.logs : [];
      const ordered = [...entries].reverse();
      const isPrimed = this.logStreamPrimedExperimentId === experimentId;
      for (const entry of ordered) {
        const key = this.logEntryKey(entry);
        if (!key) {
          continue;
        }
        if (this.seenLogIds.has(key)) {
          continue;
        }
        this.seenLogIds.add(key);
        if (!isPrimed) {
          continue;
        }
        const line = this.formatLog(entry);
        if (!line) {
          continue;
        }
        const level = String(entry.level || "").toLowerCase();
        if (level === "error") {
          this.pushMessage("system", "error", line);
          continue;
        }
        this.pushMessage("system", "status", line);
      }
      if (!isPrimed) {
        this.logStreamPrimedExperimentId = experimentId;
      }
      if (this.seenLogIds.size > 2000) {
        const tail = ordered.slice(-300).map((entry) => this.logEntryKey(entry)).filter((key) => key.length > 0);
        this.seenLogIds = new Set(tail);
      }
    } catch {
      // Keep polling resilient even if log endpoint has transient issues.
    }
  }

  private logEntryKey(entry: ExperimentLogEntry): string {
    const id = String(entry.id || "").trim();
    if (id) {
      return id;
    }
    const phase = String(entry.phase || "").trim();
    const level = String(entry.level || "").trim();
    const message = String(entry.message || "").trim();
    const timestamp = String(entry.timestamp || "").trim();
    const fallback = `${phase}|${level}|${message}|${timestamp}`;
    return fallback === "|||" ? "" : fallback;
  }

  private async collectRuntimeContext(
    projectRootOverride: string
  ): Promise<{ hardwareTarget: "cpu" | "cuda"; localPythonCommand: string; localHardwareProfile: Record<string, unknown> }> {
    if (this.runtimeContextCache) {
      return this.runtimeContextCache;
    }

    const cwd = projectRootOverride ? resolve(projectRootOverride) : process.cwd();
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? String(cpus[0].model || "") : "";
    const logicalCores = cpus.length;
    const totalMemoryGb = Number((os.totalmem() / (1024 ** 3)).toFixed(2));
    const freeMemoryGb = Number((os.freemem() / (1024 ** 3)).toFixed(2));
    const gpuName = await this.detectNvidiaGpuName(cwd);
    const localPythonCommand = await this.detectLocalPythonCommand(cwd);
    const installedPackages = await this.detectInstalledPythonPackages(cwd, localPythonCommand);
    const hardwareTarget: "cpu" | "cuda" = gpuName ? "cuda" : "cpu";

    const localHardwareProfile: Record<string, unknown> = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpu_model: cpuModel,
      logical_cores: logicalCores,
      total_memory_gb: totalMemoryGb,
      free_memory_gb: freeMemoryGb,
      gpu_name: gpuName || null,
      python_packages_count: installedPackages.length,
      python_packages: installedPackages
    };

    this.runtimeContextCache = {
      hardwareTarget,
      localPythonCommand,
      localHardwareProfile
    };
    return this.runtimeContextCache;
  }

  private async detectLocalPythonCommand(cwd: string): Promise<string> {
    const candidates = this.pythonCandidates(cwd, "python");
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = String(candidate || "").trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const probe = await this.runProbe(candidate, ["--version"], cwd, 8);
      if (probe.returncode === 0) {
        return candidate;
      }
    }
    return "python";
  }

  private async detectNvidiaGpuName(cwd: string): Promise<string | null> {
    const probe = await this.runProbe(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader"],
      cwd,
      6
    );
    if (probe.returncode !== 0) {
      return null;
    }
    const first = String(probe.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!first) {
      return null;
    }
    const name = first.split(",")[0]?.trim();
    return name || null;
  }

  private async detectInstalledPythonPackages(cwd: string, pythonCommand: string): Promise<string[]> {
    const probe = await this.runProbe(
      pythonCommand,
      ["-m", "pip", "list", "--format=json"],
      cwd,
      20,
      200000
    );
    if (probe.returncode !== 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(String(probe.stdout || ""));
      if (!Array.isArray(parsed)) {
        return [];
      }
      const packages = parsed
        .map((row) => {
          if (!row || typeof row !== "object") {
            return "";
          }
          const name = String((row as { name?: unknown }).name || "").trim();
          const version = String((row as { version?: unknown }).version || "").trim();
          if (!name || !version) {
            return "";
          }
          return `${name}==${version}`;
        })
        .filter((entry) => entry.length > 0);
      return packages.slice(0, 500);
    } catch {
      return [];
    }
  }

  private runProbe(
    command: string,
    args: string[],
    cwd: string,
    timeoutSeconds: number,
    maxCaptureChars = 4000
  ): Promise<CommandProbeResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(command, args, { cwd, shell: false, env: process.env });
      let stdout = "";
      let stderr = "";
      let resolved = false;

      const finish = (result: CommandProbeResult) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolvePromise(result);
      };

      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-maxCaptureChars);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-maxCaptureChars);
      });

      let timer: NodeJS.Timeout | null = null;
      if (timeoutSeconds > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish({ returncode: 124, stdout, stderr: `${stderr}\nTimed out`.trim() });
        }, timeoutSeconds * 1000);
      }

      child.on("error", (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        finish({ returncode: 1, stdout, stderr: error.message });
      });

      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        finish({ returncode: code ?? 1, stdout, stderr });
      });
    });
  }

  private applyStatus(status: StatusData): void {
    this.state.status = this.normalizeStatus(status.status);
    this.state.phase = status.phase;
    this.state.researchType = status.research_type === "quantum" ? "quantum" : this.state.researchType;
    this.state.executionMode = status.execution_mode || this.state.executionMode;
    this.state.executionTarget = status.execution_target || this.state.executionTarget;
    this.backendAutoAllowResearch = this.backendAutoAllowResearch || Boolean(status.default_allow_research);
    this.state.progressPct = Number.isFinite(status.progress_pct) ? Number(status.progress_pct) : this.state.progressPct;
  }

  private extractQuestion(raw: unknown): ClarificationQuestion | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const payload = raw as PendingQuestionPayload | ClarificationQuestion;
    const queued = (payload as PendingQuestionPayload).questions;
    const candidate =
      (payload as PendingQuestionPayload).current_question ||
      (Array.isArray(queued) && queued.length > 0 ? queued[0] : null) ||
      (payload as ClarificationQuestion);
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.text !== "string") {
      return null;
    }
    return candidate;
  }

  private setPendingQuestion(question: ClarificationQuestion): void {
    this.state.pendingQuestion = question;
    this.state.pendingAction = null;
    this.state.lastSuggestedAnswer = String(this.suggestedAnswer(question));
    const questionId = String(question.id || "");
    if (questionId && questionId === this.lastAnnouncedQuestionId) {
      return;
    }
    this.lastAnnouncedQuestionId = questionId || this.lastAnnouncedQuestionId;
    const optionsText = Array.isArray(question.options) && question.options.length ? `\nOptions: ${question.options.join(", ")}` : "";
    this.pushMessage(
      "assistant",
      "question",
      `${question.text}${optionsText}\nSuggested answer: ${this.state.lastSuggestedAnswer || "(none)"}`
    );
  }

  private suggestedAnswer(question: ClarificationQuestion): unknown {
    if (question.default !== undefined && question.default !== null) {
      return question.default;
    }
    if (Array.isArray(question.options) && question.options.length > 0) {
      return question.options[0];
    }
    if (question.type === "boolean") {
      return true;
    }
    if (question.type === "number") {
      return 1;
    }
    return "";
  }

  private defaultAllowResearchEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("quantum-ai");
    return Boolean(config.get("arp.defaultAllowResearch", false));
  }

  private autoResearchEnabled(): boolean {
    return this.defaultAllowResearchEnabled() || this.backendAutoAllowResearch;
  }

  private autoAnswerValue(question: ClarificationQuestion): unknown {
    if (question.default !== undefined && question.default !== null) {
      if (typeof question.default !== "string" || question.default.trim().length > 0) {
        return question.default;
      }
    }
    if (Array.isArray(question.options) && question.options.length > 0) {
      return question.options[0];
    }
    const topic = String(question.topic || question.id || "").trim().toLowerCase();
    if (question.type === "boolean") {
      if (topic === "requires_quantum") {
        return this.state.researchType === "quantum";
      }
      return true;
    }
    if (question.type === "number") {
      if (topic === "max_epochs" || topic === "epochs") {
        return 50;
      }
      if (topic === "batch_size") {
        return 32;
      }
      if (topic === "random_seed" || topic === "seed") {
        return 42;
      }
      return 1;
    }
    if (topic.includes("path")) {
      return process.cwd();
    }
    if (topic === "output_format") {
      return "hybrid";
    }
    if (topic === "framework_preference") {
      return "auto";
    }
    return "auto";
  }

  private async autoAnswerQuestion(question: ClarificationQuestion, source: "startup" | "poll"): Promise<void> {
    const answer = this.autoAnswerValue(question);
    this.pushMessage("system", "status", `Auto-answering question (${question.id}) from ${source}...`);
    await this.submitClarification(question, answer);
  }

  private describeConfirmation(action: ConfirmationAction): string {
    const fileCount = Array.isArray(action.file_operations) ? action.file_operations.length : 0;
    const commands = this.normalizeCommands(action.commands, action.command);
    const commandCount = commands.length;
    const reason = action.reason ? `\nReason: ${action.reason}` : "";
    const cwd = action.cwd ? `\nCWD: ${action.cwd}` : "";
    const commandText = commandCount
      ? `\nCommands:\n${commands.map((cmd) => `- ${cmd.join(" ")}`).join("\n")}`
      : "\nCommands: none";
    const fileList = Array.isArray(action.file_operations)
      ? action.file_operations.map((op) => String(op.path || "").trim()).filter(Boolean)
      : [];
    const fileText = fileList.length ? `\nFiles:\n${fileList.slice(0, 8).map((path) => `- ${path}`).join("\n")}` : "";
    return `Approval required: ${action.action}${reason}${cwd}\nWill run ${fileCount} file ops and ${commandCount} command(s).${commandText}${fileText}`;
  }

  private async executePendingAction(action: ConfirmationAction): Promise<Record<string, unknown>> {
    const started = Date.now();
    const cwd = resolve(String(action.cwd || process.cwd()));
    const fileResults: Array<Record<string, unknown>> = [];
    const createdFiles: string[] = [];
    const commandResults: Array<Record<string, unknown>> = [];
    let installVerificationError = "";
    let installResolvedSpec = "";
    let installPythonCommand = "";
    this.previewActionInTerminal(action, cwd);
    await mkdir(cwd, { recursive: true });

    for (const op of Array.isArray(action.file_operations) ? action.file_operations : []) {
      const rawPath = String(op.path || "").trim();
      if (!rawPath) {
        continue;
      }
      const mode = String(op.mode || "write").trim().toLowerCase() || "write";
      const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
      if (!this.isWithin(absolute, cwd)) {
        fileResults.push({ path: absolute, success: false, reason: "Path escapes action cwd" });
        continue;
      }
      if (mode === "mkdir" || mode === "directory") {
        await mkdir(absolute, { recursive: true });
        fileResults.push({ path: absolute, success: true, mode: "mkdir" });
        createdFiles.push(absolute);
        continue;
      }
      if (mode !== "write" && mode !== "create" && mode !== "overwrite") {
        fileResults.push({ path: absolute, success: false, mode, reason: "Unsupported file operation mode" });
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, String(op.content || ""), "utf-8");
      fileResults.push({ path: absolute, success: true, mode: "write" });
      createdFiles.push(absolute);
    }

    const normalizedCommands = this.normalizeCommands(action.commands, action.command);
    if (normalizedCommands.length === 0) {
      const count = fileResults.filter((row) => row.success === true).length;
      const message = `Applied ${count} file operation(s) for action '${action.action}'.`;
      this.pushMessage("system", "status", message);
      this.notify();
      this.writeActionTerminalLine(`[ARP] ${message}`);
    }
    for (let index = 0; index < normalizedCommands.length; index += 1) {
      const command = this.normalizeCommandForAction(action, normalizedCommands[index], cwd);
      const commandLabel = command.join(" ");
      this.pushMessage("system", "status", `Running command ${index + 1}/${normalizedCommands.length}: ${commandLabel}`);
      this.notify();
      this.writeActionTerminalLine(`[ARP] Running command ${index + 1}/${normalizedCommands.length}: ${commandLabel}`);

      const commandSequence = this.expandCommandFallbacks(command, action.action, cwd);
      let finalResult: Record<string, unknown> | null = null;
      for (const variant of commandSequence) {
        const result = await this.runCommandWithAutoRepair(action, variant, cwd, Number(action.timeout_seconds || 0));
        finalResult = result;
        if (Number(result.returncode) === 0) {
          if (action.action === "install_package" && variant.length > 0) {
            installPythonCommand = String(variant[0] || "").trim();
          }
          break;
        }
      }
      if (finalResult) {
        commandResults.push(finalResult);
        const rc = Number(finalResult.returncode ?? 1);
        if (rc === 0) {
          this.pushMessage(
            "system",
            "status",
            `Command ${index + 1}/${normalizedCommands.length} completed successfully.`
          );
          this.notify();
          this.writeActionTerminalLine(`[ARP] Command ${index + 1}/${normalizedCommands.length} completed.`);
        } else {
          const stderrTail = String(finalResult.stderr || "").trim().slice(-240);
          this.pushMessage(
            "system",
            "error",
            `Command ${index + 1}/${normalizedCommands.length} failed (returncode=${rc})${stderrTail ? `\n${stderrTail}` : ""}`
          );
          this.notify();
          this.writeActionTerminalLine(
            `[ARP] Command ${index + 1}/${normalizedCommands.length} failed (returncode=${rc}).`
          );
        }
      }
      if (!finalResult || Number(finalResult.returncode) !== 0) {
        break;
      }
    }

    const failedFile = fileResults.some((row) => row.success === false);
    let failedCommand = commandResults.some((row) => Number(row.returncode) !== 0);
    if (!failedFile && !failedCommand && action.action === "install_package") {
      const verification = await this.verifyInstallAction(action, cwd, installPythonCommand || undefined);
      if (!verification.ok) {
        failedCommand = true;
        installVerificationError = verification.message;
        this.pushMessage("system", "error", verification.message);
      } else {
        this.pushMessage("system", "status", verification.message);
        installResolvedSpec = String(verification.resolvedSpec || "").trim();
      }
      this.notify();
    }

    const returncode = failedFile || failedCommand ? 1 : 0;

    const combinedStdout = commandResults
      .map((row) => String(row.stdout || ""))
      .filter(Boolean)
      .join("\n")
      .slice(-10000);

    const combinedStderr = commandResults
      .map((row) => String(row.stderr || ""))
      .filter(Boolean)
      .join("\n")
      .concat(installVerificationError ? `\n${installVerificationError}` : "")
      .slice(-10000);

    return {
      returncode,
      stdout: combinedStdout,
      stderr: combinedStderr,
      duration_sec: Number(((Date.now() - started) / 1000).toFixed(3)),
      command: this.commandSummary(commandResults),
      cwd,
      created_files: createdFiles,
      metadata: {
        action: action.action,
        action_id: action.action_id,
        resolved_package_spec: installResolvedSpec,
        file_results: fileResults,
        command_results: commandResults
      }
    };
  }

  private normalizeCommands(commands: ConfirmationAction["commands"], command?: ConfirmationAction["command"]): string[][] {
    if ((!commands || (Array.isArray(commands) && commands.length === 0)) && command) {
      if (Array.isArray(command)) {
        const single = command.map((part) => String(part)).filter((part) => part.trim().length > 0);
        return single.length ? [single] : [];
      }
      if (typeof command === "string" && command.trim()) {
        return [[command.trim()]];
      }
    }

    if (!commands || !Array.isArray(commands) || commands.length === 0) {
      return [];
    }

    const first = commands[0] as unknown;
    if (Array.isArray(first)) {
      return (commands as unknown[])
        .map((entry) => (Array.isArray(entry) ? entry.map((part) => String(part)) : []))
        .filter((entry) => entry.length > 0);
    }
    const flat = (commands as unknown[]).map((part) => String(part)).filter((part) => part.trim().length > 0);
    if (flat.length === 0) {
      return [];
    }
    const allHaveSpaces = flat.length > 1 && flat.every((entry) => entry.trim().includes(" "));
    if (allHaveSpaces) {
      return flat.map((entry) => [entry.trim()]);
    }
    return [flat];
  }

  private runCommand(command: string[], cwd: string, timeoutSeconds: number): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise) => {
      const started = Date.now();
      const cmd = command[0] || "";
      const args = command.slice(1);

      if (!cmd) {
        resolvePromise({ command: "", returncode: 1, stdout: "", stderr: "Empty command", duration_sec: 0 });
        return;
      }

      const shellMode = command.length === 1 && this.isShellCommandText(cmd);
      const child = shellMode
        ? spawn(cmd, { cwd, shell: true, env: process.env })
        : spawn(cmd, args, { cwd, shell: false, env: process.env });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-12000);
        this.emitLiveCommandMessage(cmd, String(chunk), "stdout");
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-12000);
        this.emitLiveCommandMessage(cmd, String(chunk), "stderr");
      });

      let timer: NodeJS.Timeout | null = null;
      if (timeoutSeconds > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
        }, timeoutSeconds * 1000);
      }

      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolvePromise({
          command: shellMode ? cmd : [cmd, ...args].join(" "),
          returncode: code ?? 1,
          stdout,
          stderr,
          duration_sec: Number(((Date.now() - started) / 1000).toFixed(3))
        });
      });

      child.on("error", (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolvePromise({
          command: shellMode ? cmd : [cmd, ...args].join(" "),
          returncode: 1,
          stdout,
          stderr: error.message,
          duration_sec: Number(((Date.now() - started) / 1000).toFixed(3))
        });
      });
    });
  }

  private expandCommandFallbacks(command: string[], actionName: string, cwd: string): string[][] {
    if (!command.length) {
      return [command];
    }
    const primary = [command];
    const supportsPythonFallback = actionName === "prepare_venv" || actionName === "install_package" || actionName === "run_local_commands";
    if (!supportsPythonFallback) {
      return primary;
    }
    const rawExe = String(command[0] || "").trim();
    const exe = rawExe.toLowerCase();
    const isPythonLike = exe === "python" || exe === "python3" || exe === "python3.11" || exe === "py" || exe.endsWith("\\python.exe") || exe.endsWith("/python");
    if (!isPythonLike) {
      return primary;
    }
    const args = command.slice(1);
    const seen = new Set<string>();
    const variants: string[][] = [];

    const looksLikePath = isAbsolute(rawExe) || rawExe.includes("\\") || rawExe.includes("/");
    const candidates = looksLikePath
      ? (existsSync(rawExe) ? [rawExe] : [rawExe])
      : this.pythonCandidates(cwd, rawExe);

    for (const py of candidates) {
      const key = py.trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      variants.push([py, ...args]);
    }
    return variants.length > 0 ? variants : primary;
  }

  private pythonCandidates(cwd: string, original: string): string[] {
    const list: string[] = [];
    const venvUnix = resolve(cwd, ".venv/bin/python");
    const venvMac = resolve(cwd, ".venv/bin/python3");
    const venvWin = resolve(cwd, ".venv/Scripts/python.exe");

    if (existsSync(venvUnix)) {
      list.push(venvUnix);
    }
    if (existsSync(venvMac)) {
      list.push(venvMac);
    }
    if (existsSync(venvWin)) {
      list.push(venvWin);
    }

    const primary = String(original || "python").trim();
    if (primary) {
      list.push(primary);
    }

    if (process.platform === "win32") {
      list.push("python");
      list.push("py");
      list.push("python3");
    } else {
      list.push("python3");
      list.push("python");
      list.push("/usr/bin/python3");
    }
    return list;
  }

  private emitLiveCommandMessage(command: string, chunk: string, stream: "stdout" | "stderr"): void {
    const lines = String(chunk || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!lines.length) {
      return;
    }
    const tail = lines[lines.length - 1].slice(0, 240);
    const now = Date.now();
    const message = `[Live ${stream}] ${command}: ${tail}`;
    if (message === this.lastLiveMessageText && now - this.lastLiveMessageAt < 8000) {
      return;
    }
    if (now - this.lastLiveMessageAt < 1500) {
      return;
    }
    this.lastLiveMessageAt = now;
    this.lastLiveMessageText = message;
    this.writeActionTerminalLine(`[ARP ${stream}] ${command}: ${tail}`);
  }

  private writeActionTerminalLine(line: string): void {
    const text = String(line || "").trim();
    if (!text) {
      return;
    }
    const terminal = this.ensureActionTerminal();
    terminal.show(true);
    if (process.platform === "win32") {
      const safe = text.replace(/`/g, "``").replace(/"/g, '`"');
      terminal.sendText(`Write-Host "${safe}"`, true);
      return;
    }
    const safe = text.replace(/'/g, `'\"'\"'`);
    terminal.sendText(`printf '%s\\n' '${safe}'`, true);
  }

  private maybeNotifyBackendLatency(latencyMs: number): void {
    if (!Number.isFinite(latencyMs)) {
      return;
    }
    if (latencyMs < 3500) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBackendLatencyNoticeAt < 60000) {
      return;
    }
    this.lastBackendLatencyNoticeAt = now;
    this.pushMessage("system", "status", `Backend response is slow (${latencyMs} ms) but still reachable.`);
    this.notify();
  }

  private normalizeCommandForAction(action: ConfirmationAction, command: string[], cwd: string): string[] {
    if (!Array.isArray(command) || command.length === 0) {
      return command;
    }
    const normalized = [...command];
    if (action.action === "prepare_venv") {
      const venvIndex = normalized.findIndex((token) => String(token).trim().toLowerCase() === "venv");
      if (venvIndex >= 0 && venvIndex + 1 < normalized.length) {
        normalized[venvIndex + 1] = resolve(cwd, ".venv");
      }
      return normalized;
    }

    if (action.action === "install_package") {
      const exe = String(normalized[0] || "").trim();
      const expectedVenvPython = resolve(cwd, ".venv", "Scripts", "python.exe");
      if (process.platform === "win32") {
        const lowerExe = exe.replace(/\//g, "\\").toLowerCase();
        const lowerCwd = String(cwd).replace(/\//g, "\\").toLowerCase();
        if (lowerExe.startsWith(lowerCwd) && lowerExe.includes(".venv\\scripts\\python.exe")) {
          normalized[0] = expectedVenvPython;
        }
      }
      return normalized;
    }

    return normalized;
  }

  private async runCommandWithAutoRepair(
    action: ConfirmationAction,
    command: string[],
    cwd: string,
    timeoutSeconds: number
  ): Promise<CommandRunResult> {
    const first = (await this.runCommand(command, cwd, timeoutSeconds)) as CommandRunResult;
    if (action.action !== "install_package" || Number(first.returncode) === 0) {
      return first;
    }

    const stderr = String(first.stderr || "");
    const stdout = String(first.stdout || "");
    const combined = `${stderr}\n${stdout}`.toLowerCase();

    if (combined.includes("no module named pip")) {
      this.pushMessage("system", "status", "pip is missing in the target interpreter. Attempting ensurepip repair and retry...");
      this.notify();
      const pythonExe = String(command[0] || "").trim();
      if (pythonExe) {
        const ensure = (await this.runCommand([pythonExe, "-m", "ensurepip", "--upgrade"], cwd, timeoutSeconds || 120)) as CommandRunResult;
        if (Number(ensure.returncode) === 0) {
          const retried = (await this.runCommand(command, cwd, timeoutSeconds)) as CommandRunResult;
          if (Number(retried.returncode) === 0) {
            return retried;
          }
          return {
            ...retried,
            stderr: `${stderr}\n[Auto-repair] ensurepip succeeded but install retry failed.\n${String(retried.stderr || "")}`.slice(-12000)
          };
        }
        return {
          ...first,
          stderr: `${stderr}\n[Auto-repair] ensurepip failed: ${String(ensure.stderr || "")}`.slice(-12000)
        };
      }
      return first;
    }

    const networkIssue =
      combined.includes("read timed out") ||
      combined.includes("temporar") ||
      combined.includes("connection") ||
      combined.includes("ssl");
    if (networkIssue) {
      this.pushMessage("system", "status", "Transient network issue while installing package. Retrying once...");
      this.notify();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const retried = (await this.runCommand(command, cwd, timeoutSeconds)) as CommandRunResult;
      if (Number(retried.returncode) === 0) {
        return retried;
      }
      return {
        ...retried,
        stderr: `${stderr}\n[Auto-retry] network retry also failed.\n${String(retried.stderr || "")}`.slice(-12000)
      };
    }

    if (combined.includes("no matching distribution found for")) {
      const repaired = await this.tryNoMatchVersionFallback(command, action, cwd, timeoutSeconds, first);
      if (repaired) {
        return repaired;
      }
    }

    return first;
  }

  private async tryNoMatchVersionFallback(
    command: string[],
    action: ConfirmationAction,
    cwd: string,
    timeoutSeconds: number,
    first: CommandRunResult
  ): Promise<CommandRunResult | null> {
    const packageName = String(action.package || "").trim();
    if (!packageName) {
      return null;
    }
    const fromVersionsMatch = String(first.stderr || "").match(/from versions:\s*([^\r\n]+)/i);
    let fallbackSpec = packageName;
    if (fromVersionsMatch) {
      const versions = String(fromVersionsMatch[1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.toLowerCase() !== "none");
      if (versions.length > 0) {
        fallbackSpec = `${packageName}==${versions[versions.length - 1]}`;
      }
    }
    const installIdx = command.findIndex((token) => String(token).trim().toLowerCase() === "install");
    if (installIdx < 0 || installIdx + 1 >= command.length) {
      return null;
    }
    const adjusted = [...command];
    adjusted[installIdx + 1] = fallbackSpec;
    this.pushMessage(
      "system",
      "status",
      `Requested version for ${packageName} is unavailable. Retrying with ${fallbackSpec}...`
    );
    this.notify();
    const retried = (await this.runCommand(adjusted, cwd, timeoutSeconds)) as CommandRunResult;
    if (Number(retried.returncode) === 0) {
      return retried;
    }
    return {
      ...retried,
      stderr: `${String(first.stderr || "")}\n[Auto-repair] version fallback (${fallbackSpec}) failed.\n${String(retried.stderr || "")}`.slice(-12000)
    };
  }

  private async verifyInstallAction(
    action: ConfirmationAction,
    cwd: string,
    pythonOverride?: string
  ): Promise<{ ok: boolean; message: string; resolvedSpec?: string }> {
    const packageName = String(action.package || "").trim();
    if (!packageName) {
      return { ok: true, message: "Package install command completed." };
    }
    const expectedVersion = String(action.version || "").trim();
    const pythonCommand = String(pythonOverride || "").trim() || this.resolveActionPythonCommand(action, cwd);
    const probe = await this.runProbe(pythonCommand, ["-m", "pip", "show", packageName], cwd, 30, 12000);
    if (probe.returncode !== 0) {
      return {
        ok: false,
        message: `Install verification failed for ${packageName}. pip show did not find it.`
      };
    }

    const versionMatch = String(probe.stdout || "").match(/^\s*Version:\s*(.+)\s*$/im);
    const installedVersion = versionMatch ? String(versionMatch[1] || "").trim() : "";
    if (expectedVersion && installedVersion && installedVersion !== expectedVersion) {
      return {
        ok: true,
        message: `Package installed with fallback version: ${packageName}==${installedVersion} (requested ${expectedVersion}).`,
        resolvedSpec: `${packageName}==${installedVersion}`
      };
    }
    const versionText = installedVersion || expectedVersion || "unknown";
    const resolvedSpec = installedVersion ? `${packageName}==${installedVersion}` : "";
    return { ok: true, message: `Package verified: ${packageName}==${versionText}`, resolvedSpec };
  }

  private async saveReportToDownloads(content: string, experimentId: string, reportPath: string): Promise<string | null> {
    const text = String(content || "").trim();
    if (!text) {
      return null;
    }
    try {
      const fallbackName = `${experimentId}_final_report.md`;
      let fileName = basename(String(reportPath || "").trim()) || fallbackName;
      if (!fileName.toLowerCase().endsWith(".md")) {
        fileName = `${fileName}.md`;
      }
      const downloadsDir = resolve(os.homedir(), "Downloads");
      await mkdir(downloadsDir, { recursive: true });
      const destination = resolve(downloadsDir, fileName);
      await writeFile(destination, text, "utf-8");
      return destination;
    } catch {
      return null;
    }
  }

  private resolveActionPythonCommand(action: ConfirmationAction, cwd: string): string {
    const commands = this.normalizeCommands(action.commands, action.command);
    for (const cmd of commands) {
      const token = String((cmd && cmd[0]) || "").trim();
      if (!token) {
        continue;
      }
      const lower = token.toLowerCase();
      if (
        lower === "python" ||
        lower === "python3" ||
        lower === "py" ||
        lower.endsWith("\\python.exe") ||
        lower.endsWith("/python")
      ) {
        return token;
      }
    }
    const candidates = this.pythonCandidates(cwd, "python");
    return candidates.length > 0 ? candidates[0] : "python";
  }

  private isShellCommandText(value: string): boolean {
    const text = String(value || "").trim();
    if (!text) {
      return false;
    }
    return (
      text.includes(" ") ||
      text.includes("&&") ||
      text.includes("||") ||
      text.includes("|") ||
      text.includes(";")
    );
  }

  private previewActionInTerminal(action: ConfirmationAction, cwd: string): void {
    const terminal = this.ensureActionTerminal();
    terminal.show(true);
    terminal.sendText(`echo "[ARP] Accepted action: ${String(action.action || "unknown")}"`, true);
    terminal.sendText(`echo "[ARP] Working directory: ${cwd}"`, true);
    const commands = this.normalizeCommands(action.commands, action.command);
    if (commands.length === 0) {
      const fileOps = Array.isArray(action.file_operations) ? action.file_operations.length : 0;
      terminal.sendText(`echo "[ARP] File-only action with ${fileOps} file operation(s)."`, true);
      return;
    }
    terminal.sendText("echo \"[ARP] Commands selected for execution by extension:\"", true);
    for (let idx = 0; idx < commands.length; idx += 1) {
      const rendered = commands[idx].join(" ").trim();
      if (!rendered) {
        continue;
      }
      const safeRendered = rendered.replace(/"/g, '\\"');
      terminal.sendText(`echo "[ARP]  ${idx + 1}. ${safeRendered}"`, true);
    }
  }

  private ensureActionTerminal(): vscode.Terminal {
    if (this.actionTerminal) {
      return this.actionTerminal;
    }
    this.actionTerminal = vscode.window.createTerminal("ARP Env Manager");
    return this.actionTerminal!;
  }

  private isWithin(path: string, cwd: string): boolean {
    const normalizedPath = resolve(path);
    const normalizedCwd = resolve(cwd);
    const rel = relative(normalizedCwd, normalizedPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private commandSummary(commandResults: Array<Record<string, unknown>>): string[] {
    return commandResults.map((row) => String(row.command || "")).filter(Boolean);
  }

  private reportToText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (content && typeof content === "object" && typeof (content as { markdown?: unknown }).markdown === "string") {
      return String((content as { markdown?: unknown }).markdown);
    }
    return "";
  }

  private isErrorLog(entry: ExperimentLogEntry): boolean {
    const level = String(entry.level || "").toLowerCase();
    if (level === "error") {
      return true;
    }
    const message = String(entry.message || "").toLowerCase();
    return message.includes("failed") || message.includes("error");
  }

  private formatLog(entry: ExperimentLogEntry): string {
    const phase = String(entry.phase || "unknown");
    const level = String(entry.level || "info").toUpperCase();
    const message = String(entry.message || "").trim();
    if (!message) {
      return "";
    }
    const details = entry.details && typeof entry.details === "object" ? this.pretty(entry.details) : "";
    const shortDetails = details ? ` | details: ${details.slice(0, 300)}` : "";
    return `[${phase}/${level}] ${message}${shortDetails}`;
  }

  private pretty(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value ?? "");
    }
  }

  private async persistSessionState(): Promise<void> {
    if (!this.context) {
      return;
    }
    const experimentId = String(this.state.experimentId || "").trim();
    if (!experimentId) {
      await this.context.globalState.update(this.persistKey, null);
      return;
    }
    const payload: PersistedArpSession = {
      experimentId,
      researchType: this.state.researchType === "quantum" ? "quantum" : "ai"
    };
    await this.context.globalState.update(this.persistKey, payload);
  }

  private async clearPersistedSession(): Promise<void> {
    if (!this.context) {
      return;
    }
    await this.context.globalState.update(this.persistKey, null);
  }

  private updateInputPlaceholder(): void {
    if (this.confirmationInFlight) {
      this.state.inputPlaceholder = "Executing local action... please wait";
      return;
    }
    if (this.state.pendingQuestion) {
      this.state.inputPlaceholder = "Type custom answer, then click 'Deny / Send Custom Answer'";
      return;
    }
    if (this.state.pendingAction) {
      this.state.inputPlaceholder = "Optional deny reason for current approval step";
      return;
    }
    if (this.state.experimentId && !this.isTerminal(this.state.status)) {
      this.state.inputPlaceholder = "Workflow is running...";
      return;
    }
    this.state.inputPlaceholder = "Describe what you want to research...";
  }

  private pushMessage(role: ChatMessage["role"], kind: ChatMessage["kind"], content: string, meta?: Record<string, unknown>): void {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last && last.role === role && last.kind === kind && last.content === content) {
      return;
    }
    this.messageCounter += 1;
    this.state.messages.push({
      id: `m_${Date.now()}_${this.messageCounter}`,
      role,
      kind,
      content,
      meta,
      createdAt: Date.now()
    });
  }

  private normalizeStatus(status: string): ExperimentLifecycleStatus {
    if (status === "pending" || status === "waiting_user" || status === "running" || status === "success" || status === "failed" || status === "aborted") {
      return status;
    }
    return "idle";
  }

  private isTerminal(status: ExperimentLifecycleStatus): boolean {
    return status === "success" || status === "failed" || status === "aborted";
  }

  private notify(): void {
    const snapshot = this.getState();
    void this.persistSessionState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
