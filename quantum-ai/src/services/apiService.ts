// src/services/apiService.ts
import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { 
    CodeGenerationRequest, 
    CodeGenerationResponse,
    ErrorFixRequest,
    ErrorFixResponse,
    ExplanationRequest,
    ExplanationResponse,
    TranspilationRequest,
    TranspilationResponse,
    CompletionRequest,
    CompletionResponse 
} from '../types/api';

export class QuantumHubApiService {
    private client: AxiosInstance;

    constructor() {
        // Get backend URL from config or use default
        const config = vscode.workspace.getConfiguration('quantum-ai');
        // const backendUrl = config.get<string>('backendUrl', 'http://localhost:8000/api');
        const backendUrl = config.get('backendUrl', 'http://localhost:8000/api') as string;
        
        this.client = axios.create({
            baseURL: backendUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            }
        });

        // Response interceptor for error handling
        this.client.interceptors.response.use(
            response => response,
            this.handleError
        );
    }

    private static extractApiErrorDetail(data: unknown): string | null {
        if (!data || typeof data !== 'object') {
            return null;
        }

        const payload = data as Record<string, unknown>;
        const detail = payload.detail;

        if (typeof detail === 'string' && detail.trim()) {
            return detail.trim();
        }

        if (Array.isArray(detail)) {
            const parts = detail
                .map((item) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') {
                        const obj = item as Record<string, unknown>;
                        if (typeof obj.msg === 'string') return obj.msg;
                        if (typeof obj.message === 'string') return obj.message;
                    }
                    return '';
                })
                .filter(Boolean);
            if (parts.length > 0) {
                return parts.join('; ');
            }
        }

        if (detail && typeof detail === 'object') {
            const detailObj = detail as Record<string, unknown>;
            if (typeof detailObj.message === 'string' && detailObj.message.trim()) {
                return detailObj.message.trim();
            }
        }

        if (typeof payload.message === 'string' && payload.message.trim()) {
            return payload.message.trim();
        }

        return null;
    }

    private handleError(error: AxiosError): Promise<never> {
        const status = error.response?.status;
        const apiDetail = QuantumHubApiService.extractApiErrorDetail(error.response?.data);
        const normalizedDetail = (apiDetail || '').toLowerCase();
        const friendly400Message = `Request rejected: ${apiDetail || 'Invalid request.'}`;

        if (error.code === 'ECONNABORTED') {
            vscode.window.showErrorMessage('Request timeout. Please try again.');
        } else if (!error.response) {
            vscode.window.showErrorMessage('Network error. Please check your connection.');
        } else if (status === 400) {
            vscode.window.showErrorMessage(friendly400Message, { modal: true });
        } else if (status && status >= 500) {
            vscode.window.showErrorMessage('Server error. Please try again later.');
        }

        const message = apiDetail || error.message || (status ? `HTTP ${status}` : 'Request failed');
        return Promise.reject(new Error(message));
    }

    async generateCode(request: CodeGenerationRequest): Promise<CodeGenerationResponse> {
        const response = await this.client.post('/code/generate', request);
        return response.data;
    }

    async fixCode(request: ErrorFixRequest): Promise<ErrorFixResponse> {
        const response = await this.client.post('/fix/code', request);
        return response.data;
    }

    async explainCode(request: ExplanationRequest): Promise<ExplanationResponse> {
        const response = await this.client.post('/explain/code', request);
        return response.data;
    }

    async transpileCode(request: TranspilationRequest): Promise<TranspilationResponse> {
        const response = await this.client.post('/transpile/convert', request);
        return response.data;
    }

    async getCompletions(request: CompletionRequest): Promise<CompletionResponse> {
        const response = await this.client.post('/complete/suggest', request);
        return response.data;
    }

    async checkHealth(): Promise<{ version: string; status: string; healthy: boolean }> {
        try {
            const response = await this.client.get('/health');
            return {
                ...response.data,
                healthy: true
            };
        } catch (error) {
            return {
                version: 'unknown',
                status: 'unreachable',
                healthy: false
            };
        }
    }

    async getSupportedConversions(): Promise<any> {
        const response = await this.client.get('/transpile/supported-conversions');
        return response.data;
    }
}
