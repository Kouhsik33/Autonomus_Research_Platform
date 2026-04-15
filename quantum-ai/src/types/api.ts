// API response types based on your backend endpoints
export interface ClientContext {
    client_type: 'vscode_extension' | 'website';
    version: string;
    platform?: string;
}

export interface CodeGenerationRequest {
    prompt: string;
    framework: string;
    num_qubits?: number;
    include_explanation?: boolean;
    include_visualization?: boolean;
    client_context?: ClientContext;
}

export interface CodeGenerationResponse {
    code: string;
    framework: string;
    explanation?: string;
    visualization?: string;
    confidence_score: number;
    validation_passed: boolean;
    validation_errors: string[];
    metadata: Record<string, any>;
}

export interface ErrorFixRequest {
    code: string;
    framework: string;
    error_message?: string;
    include_explanation?: boolean;
    client_context?: ClientContext;
}

export interface ErrorFixResponse {
    fixed_code: string;
    issues_identified: string[];
    explanation?: string;
    metadata: Record<string, any>;
}

export interface ExplanationRequest {
    code: string;
    framework: string;
    detail_level: 'beginner' | 'intermediate' | 'advanced';
    include_math?: boolean;
    include_visualization?: boolean;
    client_context?: ClientContext;
}

export interface ExplanationResponse {
    overview: string;
    gate_breakdown: string;
    quantum_concepts: string;
    mathematics?: string;
    applications: string;
    visualization?: string;
    runtime_recommendations?: Record<string, any>;
}


export interface RuntimePreferences {
    preferred_runtime?: string;
    compatibility_level?: string;
}

export interface TranspilationRequest {
    source_code: string;
    source_framework: string;
    target_framework: string;
    preserve_comments?: boolean;
    optimize?: boolean;
    client_context?: ClientContext;
    runtime_preferences?: RuntimePreferences;  // Make sure this field exists
}

export interface TranspilationResponse {
    transpiled_code: string;
    source_framework: string;
    target_framework: string;
    success: boolean;
    validation_passed: boolean;
    differences: string[];
    warnings: string[];
    metadata: Record<string, any>;
}

export interface CompletionRequest {
    code_prefix: string;
    framework: string;
    cursor_line: number;
    cursor_column: number;
    max_suggestions?: number;
    client_context?: ClientContext;
}

export interface CompletionSuggestion {
    code: string;
    description: string;
    priority: number;
    confidence: number;
}

export interface CompletionResponse {
    suggestions: CompletionSuggestion[];
    context_detected: Record<string, any>;
    latency_ms: number;
    metadata: Record<string, any>;
}