import { SuggestionResult } from './quantumHubProvider';

// Abstract AI provider interface
export interface AIProvider {
    explain(code: string, language?: string, errorMessage?: string): Promise<string>;
    fix(code: string, language?: string, errorMessage?: string): Promise<string>;
    complete(context: string, language?: string): Promise<string>;
    suggest(code: string, language?: string): Promise<SuggestionResult>;
    clearCache?(): void;
    checkHealth?(): Promise<{ healthy: boolean; message: string; version?: string }>;
}
