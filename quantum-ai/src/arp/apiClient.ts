import type {
  AnswerData,
  ApiEnvelope,
  ConfirmData,
  ExperimentDetailsData,
  LogsData,
  ReportData,
  ResultsData,
  RetryData,
  StartExperimentData,
  StatusData
} from "./types";

export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code = "API_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

type HttpMethod = "GET" | "POST" | "DELETE";

export class ArpApiClient {
  private readonly getBaseUrl: () => string;
  private readonly output: { appendLine: (message: string) => void };

  constructor(getBaseUrl: () => string, output: { appendLine: (message: string) => void }) {
    this.getBaseUrl = getBaseUrl;
    this.output = output;
  }

  public baseUrl(): string {
    return this.getBaseUrl();
  }

  private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<ApiEnvelope<T>> {
    const url = `${this.getBaseUrl()}${path}`;
    this.output.appendLine(`[${method}] ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "Network error", 0, "NETWORK_ERROR");
    }

    const text = await response.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(`Backend returned non-JSON response (${response.status})`, response.status, "NON_JSON_RESPONSE");
    }

    if (!response.ok) {
      const detail = parsed?.detail || {};
      const message = detail.message || parsed?.error?.message || parsed?.message || `HTTP ${response.status}`;
      const code = detail.code || parsed?.error?.code || "HTTP_ERROR";
      throw new ApiError(message, response.status, code);
    }

    if (parsed.success === false) {
      throw new ApiError(parsed?.error?.message || "Request failed", response.status, parsed?.error?.code || "API_ERROR");
    }

    return parsed as ApiEnvelope<T>;
  }

  async startExperiment(prompt: string, researchType: "ai" | "quantum", configOverrides: Record<string, unknown>): Promise<StartExperimentData> {
    const res = await this.request<StartExperimentData>("POST", "/research/start", {
      prompt,
      research_type: researchType,
      priority: "normal",
      tags: [],
      user_id: "vscode-user",
      test_mode: false,
      config_overrides: configOverrides
    });
    return res.data;
  }

  async answerQuestion(experimentId: string, questionId: string, value: unknown): Promise<AnswerData> {
    const res = await this.request<AnswerData>("POST", `/research/${experimentId}/answer`, {
      answers: { [questionId]: value }
    });
    return res.data;
  }

  async submitConfirmation(
    experimentId: string,
    actionId: string,
    decision: "confirm" | "deny",
    reason = "",
    alternativePreference = "",
    executionResult?: Record<string, unknown>
  ): Promise<ConfirmData> {
    const res = await this.request<ConfirmData>("POST", `/research/${experimentId}/confirm`, {
      action_id: actionId,
      decision,
      reason,
      alternative_preference: alternativePreference,
      execution_result: executionResult
    });
    return res.data;
  }

  async getStatus(experimentId: string): Promise<StatusData> {
    const res = await this.request<StatusData>("GET", `/research/${experimentId}/status`);
    return res.data;
  }

  async getExperiment(experimentId: string): Promise<ExperimentDetailsData> {
    const res = await this.request<ExperimentDetailsData>("GET", `/research/${experimentId}`);
    return res.data;
  }

  async getResults(experimentId: string): Promise<ResultsData> {
    const res = await this.request<ResultsData>("GET", `/research/${experimentId}/results`);
    return res.data;
  }

  async getReport(experimentId: string): Promise<ReportData> {
    const res = await this.request<ReportData>("GET", `/research/${experimentId}/report?format=markdown`);
    return res.data;
  }

  async getLogs(experimentId: string, limit = 100): Promise<LogsData> {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const res = await this.request<LogsData>("GET", `/research/${experimentId}/logs?limit=${safeLimit}&offset=0`);
    return res.data;
  }

  async retryExperiment(
    experimentId: string,
    fromPhase?: string,
    resetRetries = false,
    overrideConfig: Record<string, unknown> = {}
  ): Promise<RetryData> {
    const res = await this.request<RetryData>("POST", `/research/${experimentId}/retry`, {
      from_phase: fromPhase || null,
      reset_retries: Boolean(resetRetries),
      override_config: overrideConfig
    });
    return res.data;
  }
}
