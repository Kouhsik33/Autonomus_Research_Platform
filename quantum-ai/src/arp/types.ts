export type ExperimentLifecycleStatus = "idle" | "pending" | "waiting_user" | "running" | "success" | "failed" | "aborted";

export type ClarificationQuestion = {
  id: string;
  text: string;
  type: string;
  topic?: string;
  options?: string[];
  default?: unknown;
  required?: boolean;
};

export type PendingQuestionPayload = {
  mode?: string;
  current_question?: ClarificationQuestion;
  questions?: ClarificationQuestion[];
  asked_question_ids?: string[];
  answered_count?: number;
  total_questions_planned?: number;
};

export type FileOperation = {
  path: string;
  content?: string;
  mode?: "write" | "mkdir" | string;
};

export type ConfirmationAction = {
  action_id: string;
  action: string;
  phase?: string;
  cwd?: string;
  command?: string[] | string;
  commands?: string[] | string[][];
  file_operations?: FileOperation[];
  timeout_seconds?: number;
  reason?: string;
  package?: string;
  version?: string;
  fallback_if_denied?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "status" | "question" | "confirmation" | "summary" | "error";
  content: string;
  meta?: Record<string, unknown>;
  createdAt: number;
};

export type ChatSessionState = {
  experimentId: string | null;
  status: ExperimentLifecycleStatus;
  phase: string | null;
  researchType: "ai" | "quantum";
  executionMode: string | null;
  executionTarget: string | null;
  progressPct: number;
  confirmationInFlight: boolean;
  pendingQuestion: ClarificationQuestion | null;
  pendingAction: ConfirmationAction | null;
  lastSuggestedAnswer: string;
  inputPlaceholder: string;
  messages: ChatMessage[];
  polling: {
    enabled: boolean;
    intervalMs: number;
  };
};

export type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
};

export type StartExperimentData = {
  experiment_id: string;
  status: string;
  phase: string;
  research_type?: "ai" | "quantum";
  execution_mode?: string;
  execution_target?: string;
  default_allow_research?: boolean;
  pending_questions?: PendingQuestionPayload | ClarificationQuestion | null;
};

export type AnswerData = {
  experiment_id: string;
  status: string;
  phase: string;
  research_type?: "ai" | "quantum";
  pending_questions?: PendingQuestionPayload | ClarificationQuestion | null;
};

export type ConfirmData = {
  status: string;
  phase: string;
  pending_action?: ConfirmationAction | null;
};

export type StatusData = {
  experiment_id: string;
  status: string;
  phase: string;
  progress_pct?: number;
  research_type?: "ai" | "quantum";
  waiting_for_user?: boolean;
  pending_questions?: PendingQuestionPayload | ClarificationQuestion | null;
  pending_action?: ConfirmationAction | null;
  execution_mode?: string;
  execution_target?: string;
  default_allow_research?: boolean;
};

export type ExperimentDetailsData = {
  experiment_id: string;
  status: string;
  phase: string;
  research_type?: "ai" | "quantum";
  default_allow_research?: boolean;
  pending_questions?: PendingQuestionPayload | ClarificationQuestion | null;
};

export type ResultsData = Record<string, unknown>;

export type ReportData = {
  content?: string | { markdown?: string };
  report_path?: string;
  word_count?: number;
  sections?: string[];
};

export type ExperimentLogEntry = {
  id?: string;
  phase?: string;
  level?: string;
  message?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
};

export type LogsData = {
  experiment_id?: string;
  logs?: ExperimentLogEntry[];
  execution_logs?: Array<Record<string, unknown>>;
};

export type RetryData = {
  experiment_id: string;
  status: string;
  restarted_from?: string;
  retry_count?: number;
  message?: string;
};
