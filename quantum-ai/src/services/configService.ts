import * as vscode from 'vscode';

export interface ExtensionConfig {
    maxLinesForContext: number;
    completionEnabled: boolean;
    debounceDelay: number;
    temperature: number;
    model: string;
    maxTokens: number;
    cacheCompletions: boolean;
    explanationDetailLevel: 'beginner' | 'intermediate' | 'advanced';
    telemetryEnabled: boolean;
    autoFixOnError: boolean;
    framework: 'auto' | 'qiskit' | 'pennylane' | 'cirq' | 'torchquantum';
    arpDefaultAllowResearch: boolean;
}

export class ConfigService {
    private static instance: ConfigService;
    private config: vscode.WorkspaceConfiguration;

    private constructor() {
        this.config = vscode.workspace.getConfiguration('quantum-ai');
    }

    static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    get<T>(key: string, defaultValue?: T): T {
        return this.config.get<T>(key, defaultValue as T);
    }

    async update(key: string, value: any, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
        await this.config.update(key, value, target);
        this.config = vscode.workspace.getConfiguration('quantum-ai');
    }

    getAll(): ExtensionConfig {
        return {
            maxLinesForContext: this.get('maxLinesForContext', 20),
            completionEnabled: this.get('completionEnabled', true),
            debounceDelay: this.get('debounceDelay', 300),
            temperature: this.get('temperature', 0.2),
            model: this.get('model', 'Qwen/Qwen2.5-Coder-7B-Instruct'),
            maxTokens: this.get('maxTokens', 500),
            cacheCompletions: this.get('cacheCompletions', true),
            explanationDetailLevel: this.get('explanationDetailLevel', 'intermediate'),
            telemetryEnabled: this.get('telemetryEnabled', true),
            autoFixOnError: this.get('autoFixOnError', false),
            framework: this.get('framework', 'auto'),
            arpDefaultAllowResearch: this.get('arp.defaultAllowResearch', false)
        };
    }

    onDidChange(listener: (e: vscode.ConfigurationChangeEvent) => any): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if (e.affectsConfiguration('quantum-ai')) {
                this.config = vscode.workspace.getConfiguration('quantum-ai');
                listener(e);
            }
        });
    }
}
