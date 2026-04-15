import * as vscode from 'vscode';
import { TelemetryService } from './telemetryService';

export enum ErrorSeverity {
    INFO = 'info',
    WARNING = 'warning',
    ERROR = 'error'
}

export interface ErrorContext {
    operation: string;
    severity: ErrorSeverity;
    userMessage?: string;
    reportable?: boolean;
}

export class ErrorHandler {
    private static instance: ErrorHandler;
    private telemetry: TelemetryService;
    private outputChannel: vscode.OutputChannel;

    private constructor(context: vscode.ExtensionContext) {
        this.telemetry = TelemetryService.getInstance(context);
        this.outputChannel = vscode.window.createOutputChannel('Quantum AI Errors');
    }

    static getInstance(context: vscode.ExtensionContext): ErrorHandler {
        if (!ErrorHandler.instance) {
            ErrorHandler.instance = new ErrorHandler(context);
        }
        return ErrorHandler.instance;
    }

    handleError(error: unknown, context: ErrorContext): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        // Log to output channel
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${context.operation}: ${errorMessage}`);
        if (stack) {
            this.outputChannel.appendLine(stack);
        }

        // Send to telemetry if reportable
        if (context.reportable !== false) {
            this.telemetry.trackError(errorMessage, {
                operation: context.operation,
                stack
            });
        }

        // Show user message
        this.showUserMessage(context.severity, context.userMessage || errorMessage);
    }

    private showUserMessage(severity: ErrorSeverity, message: string): void {
        switch (severity) {
            case ErrorSeverity.INFO:
                vscode.window.showInformationMessage(message);
                break;
            case ErrorSeverity.WARNING:
                vscode.window.showWarningMessage(message);
                break;
            case ErrorSeverity.ERROR:
                vscode.window.showErrorMessage(message);
                break;
        }
    }

    async handleApiError(error: any, operation: string): Promise<never> {
        if (error.response) {
            // Server responded with error
            const status = error.response.status;
            
            if (status === 401) {
                throw new Error('Authentication failed. Please log in again.');
            } else if (status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            } else if (status >= 500) {
                throw new Error('Server error. Please try again later.');
            } else {
                throw new Error(`API error: ${status}`);
            }
        } else if (error.request) {
            // No response received
            throw new Error('Network error. Please check your connection.');
        } else {
            // Request setup error
            throw error;
        }
    }
}