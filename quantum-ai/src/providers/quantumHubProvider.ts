// src/providers/quantumHubProvider.ts
import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';
import { QuantumHubApiService } from '../services/apiService';
import { TelemetryService } from '../services/telemetryService';
import { CacheService } from '../services/cacheService';
import { getClientContext, getEnhancedClientContext, getClientContextWithAsync } from '../utils/clientContext';
import { ExplanationResponse, ErrorFixResponse, CompletionResponse, CodeGenerationResponse } from '../types/api';

export interface SuggestionResult {
    code: string;
    explanation: string;
}

export class QuantumHubProvider implements AIProvider {
    private api: QuantumHubApiService;
    private telemetry: TelemetryService;
    private cache: CacheService;

    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel
    ) {
        this.api = new QuantumHubApiService();
        this.telemetry = TelemetryService.getInstance(context);
        this.cache = CacheService.getInstance(context);
    }

    async explain(code: string, language: string = 'python', errorMessage?: string): Promise<string> {
        const startTime = Date.now();
        
        try {
            // Use enhanced context
            const clientContext = await getEnhancedClientContext(this.context);
            
            const request = {
                code,
                framework: this.detectFramework(code, language),
                detail_level: this.getDetailLevel(),
                include_math: true,
                include_visualization: false,
                client_context: clientContext  // Now includes all environment info
            };

            const response = await this.api.explainCode(request);
            
            this.telemetry.trackEvent('explain', {
                duration: Date.now() - startTime,
                language,
                framework: request.framework,
                python_version: clientContext.python?.version,
                has_qiskit: !!clientContext.installed_packages?.qiskit,
                success: true
            });

            return this.formatExplanationResponse(response);
            
        } catch (error) {
            this.telemetry.trackEvent('explain', {
                duration: Date.now() - startTime,
                language,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    async fix(code: string, language: string = 'python', errorMessage?: string): Promise<string> {
        const startTime = Date.now();
        
        try {
            // Use enhanced context
            const clientContext = await getEnhancedClientContext(this.context);
            
            const request = {
                code,
                framework: this.detectFramework(code, language),
                error_message: errorMessage,
                include_explanation: true,
                client_context: clientContext  // Enhanced context
            };

            const response = await this.api.fixCode(request);
            
            this.telemetry.trackEvent('fix', {
                duration: Date.now() - startTime,
                language,
                framework: request.framework,
                issuesCount: response.issues_identified.length,
                python_version: clientContext.python?.version,
                success: true
            });

            return response.fixed_code;
            
        } catch (error) {
            this.telemetry.trackEvent('fix', {
                duration: Date.now() - startTime,
                language,
                success: false
            });
            throw error;
        }
    }

    async complete(context: string, language: string = 'python'): Promise<string> {
        const cacheKey = `complete:${language}:${context}`;
        const cached = await this.cache.get<string>(cacheKey);
        if (cached) return cached;

        try {
            const editor = vscode.window.activeTextEditor;
            const position = editor?.selection.active;

            // Use enhanced context with callback for non-blocking
            const clientContext = getClientContextWithAsync(this.context, async (fullContext) => {
                // If we get async data after completion, we could pre-warm cache
                this.outputChannel.appendLine(`Async context loaded: ${Object.keys(fullContext.installed_packages || {}).length} packages detected`);
            });

            const request = {
                code_prefix: context,
                framework: this.detectFramework(context, language),
                cursor_line: position?.line ?? 0,
                cursor_column: position?.character ?? 0,
                max_suggestions: 1,
                client_context: clientContext  // Has sync data immediately
            };

            const response = await this.api.getCompletions(request);
            
            const completion = response.suggestions[0]?.code || '';
            
            if (completion) {
                await this.cache.set(cacheKey, completion, 300000);
            }
            
            return completion;
            
        } catch (error) {
            this.outputChannel.appendLine(`Completion error: ${error instanceof Error ? error.message : String(error)}`);
            return '';
        }
    }

    async suggest(code: string, language: string = 'python'): Promise<SuggestionResult> {
        const startTime = Date.now();
        const framework = this.detectFramework(code, language);
        const isQuantumPythonInput = language === 'python' && this.isQuantumLikeCode(code);
        
        try {
            this.outputChannel.appendLine(
                `Generating suggestions for ${isQuantumPythonInput ? framework : language} code...`
            );
            
            // Use enhanced context
            const clientContext = await getEnhancedClientContext(this.context);
            
            // Build prompt based on detected domain.
            const enhancedPrompt = isQuantumPythonInput
                ? this.buildSuggestionPrompt(code, framework, clientContext)
                : this.buildGeneralSuggestionPrompt(code, language);
            
            const request = {
                prompt: enhancedPrompt,
                framework: isQuantumPythonInput ? framework : this.mapLanguageToFrameworkHint(language),
                include_explanation: true,
                include_visualization: false,
                num_qubits: isQuantumPythonInput ? this.extractQubitCount(code) : undefined,
                client_context: {
                    ...clientContext,
                    features: {
                        suggest: true,
                        source: isQuantumPythonInput ? 'improvement_suggestion_quantum' : 'improvement_suggestion_general'
                    }
                }
            };

            const response: CodeGenerationResponse = await this.api.generateCode(request);
            
            this.telemetry.trackEvent('suggest', {
                duration: Date.now() - startTime,
                language,
                framework: isQuantumPythonInput ? framework : language,
                validation_passed: response.validation_passed,
                confidence_score: response.confidence_score,
                tokens_used: response.metadata.tokens_used,
                python_version: clientContext.python?.version,
                installed_packages: Object.keys(clientContext.installed_packages || {}).join(','),
                success: true
            });

            if (response.validation_passed) {
                const cacheKey = `suggest:${language}:${Buffer.from(code).slice(0, 100)}`;
                await this.cache.set(cacheKey, response, 3600000);
            }

            return {
                code: response.code,
                explanation: response.explanation || (
                    isQuantumPythonInput
                        ? this.generateDefaultExplanation(framework, response.metadata, clientContext)
                        : 'Applied general code quality improvements for readability, maintainability, and correctness.'
                )
            };

        } catch (error) {
            this.outputChannel.appendLine(`Suggestion error: ${error instanceof Error ? error.message : String(error)}`);
            
            this.telemetry.trackEvent('suggest', {
                duration: Date.now() - startTime,
                language,
                framework: isQuantumPythonInput ? framework : language,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });

            try {
                this.outputChannel.appendLine('Falling back to fix endpoint for suggestions...');
                const fallbackInstruction = isQuantumPythonInput
                    ? 'Please improve this quantum code with best practices and optimizations.'
                    : `Please improve this ${language} code with best practices and optimizations.`;
                const fixedCode = await this.fix(code, language, fallbackInstruction);
                return {
                    code: fixedCode,
                    explanation: '⚠️ Used fallback improvement method. Some optimizations may be limited.'
                };
            } catch (fallbackError) {
                throw new Error(`Failed to generate suggestions: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * Build a specialized prompt for code improvement suggestions with version awareness
     */
    private buildSuggestionPrompt(code: string, framework: string, clientContext: any): string {
        const frameworkVersion = clientContext.installed_packages?.[framework] || 'latest';
        const pythonVersion = clientContext.python?.version || '3.x';
        
        const frameworkSpecificHints: Record<string, string> = {
            'qiskit': `Use Qiskit ${frameworkVersion} features:
- ${frameworkVersion >= '1.0' ? 'Use QuantumCircuit directly (qiskit 1.0+)' : 'Use QuantumCircuit from qiskit'}
- ${frameworkVersion >= '1.0' ? 'Use AerSimulator instead of Aer.get_backend()' : 'Use Aer.get_backend() for simulation'}
- Follow IBM Quantum best practices for circuit optimization
- Use modern transpilation options compatible with Qiskit ${frameworkVersion}`,
            
            'pennylane': `Use PennyLane ${frameworkVersion} best practices:
- Use qml.device for device configuration
- Implement quantum functions with proper decorators
- Use templates compatible with PennyLane ${frameworkVersion}
- Follow Xanadu's optimization guidelines`,
            
            'cirq': `Use Cirq ${frameworkVersion} optimization techniques:
- Use cirq.Circuit with proper moment structure
- Implement efficient parameter resolution
- Use Google's recommended patterns for Cirq ${frameworkVersion}
- Leverage cirq.transformers for optimization`,
            
            'torchquantum': `Use TorchQuantum ${frameworkVersion} best practices:
- Integrate properly with PyTorch
- Use batched simulation when beneficial
- Follow MIT's optimization guidelines
- Implement efficient gradient computation`
        };

        return `Please improve and optimize this ${framework} ${frameworkVersion} quantum code for Python ${pythonVersion}:

## Original Code:
\`\`\`python
${code}
\`\`\`

## User Environment:
- Python Version: ${pythonVersion}
- ${framework} Version: ${frameworkVersion}
- Other Packages: ${Object.keys(clientContext.installed_packages || {}).filter(p => p !== framework).join(', ') || 'None detected'}

## Improvement Guidelines:
1. **Version Compatibility**
   - Ensure code works with ${framework} ${frameworkVersion}
   - Use APIs compatible with Python ${pythonVersion}
   - Avoid deprecated methods for this version

2. **Code Quality**
   - Use latest stable APIs for ${framework} ${frameworkVersion}
   - Add proper error handling and input validation
   - Improve variable names and code structure
   - Add meaningful comments for complex sections

3. **Performance Optimization**
   ${frameworkSpecificHints[framework] || 'Optimize for performance and readability'}
   - Reduce circuit depth where possible
   - Use efficient gate decompositions
   - Minimize qubit reset operations

4. **Best Practices**
   - Follow PEP 8 style guidelines
   - Add type hints where beneficial
   - Include docstrings for functions
   - Handle edge cases appropriately

## Output Format:
Provide the improved code first, followed by a detailed explanation.

Improved Code:
\`\`\`python
[Your improved code here]
\`\`\`

Explanation:
[Detailed explanation of improvements]`;
    }

    private buildGeneralSuggestionPrompt(code: string, language: string): string {
        return `Please improve and optimize this ${language} code.

## Original Code:
\`\`\`${language}
${code}
\`\`\`

## Improvement Goals:
1. Preserve existing behavior.
2. Improve readability, maintainability, and naming.
3. Remove obvious anti-patterns and simplify complex logic where safe.
4. Add concise comments only when they clarify non-obvious logic.
5. Keep framework/library usage idiomatic for ${language}.

## Output Format:
Improved Code:
\`\`\`${language}
[Improved code here]
\`\`\`

Explanation:
[Short explanation of key improvements]`;
    }

    private mapLanguageToFrameworkHint(language: string): string {
        const lower = (language || '').toLowerCase();
        if (lower === 'python') {
            return 'qiskit';
        }
        return 'generic';
    }

    private isQuantumLikeCode(code: string): boolean {
        const text = (code || '').toLowerCase();
        if (!text.trim()) {
            return false;
        }
        const quantumSignals = [
            'qiskit',
            'quantumcircuit',
            'pennylane',
            'qml.',
            'cirq',
            'torchquantum',
            'qubit',
            'hadamard',
            'cnot',
            'rx(',
            'ry(',
            'rz(',
            'measure('
        ];
        return quantumSignals.some(signal => text.includes(signal));
    }

    /**
     * Extract qubit count from code if specified
     */
    private extractQubitCount(code: string): number | undefined {
        const patterns = [
            /QuantumCircuit\s*\(\s*(\d+)\s*\)/,
            /wires\s*=\s*(\d+)/,
            /cirq\.GridQubit\.rect\s*\(\s*\d+\s*,\s*\d+\s*\)/,
            /n_wires\s*=\s*(\d+)/,
            /num_qubits\s*=\s*(\d+)/
        ];

        for (const pattern of patterns) {
            const match = code.match(pattern);
            if (match) {
                const count = parseInt(match[1], 10);
                if (!isNaN(count) && count > 0 && count <= 100) {
                    return count;
                }
            }
        }
        return undefined;
    }

    /**
     * Generate a default explanation with version context
     */
    private generateDefaultExplanation(framework: string, metadata: any, clientContext?: any): string {
        const frameworkVersion = clientContext?.installed_packages?.[framework] || 'unknown';
        
        return `## Improvements Applied

### Code Optimizations
- Modernized code to use latest ${framework} APIs${frameworkVersion !== 'unknown' ? ` (v${frameworkVersion})` : ''}
- Applied best practices for quantum circuit design
- Optimized gate operations for better performance

### Quality Improvements
- Added proper error handling and validation
- Improved code structure and readability
- Included comprehensive comments

### Performance Metrics
- Confidence Score: ${metadata.confidence_score || 'N/A'}
- Validation: ${metadata.validation_passed ? '✅ Passed' : '⚠️ Check warnings'}
- Tokens Used: ${metadata.tokens_used || 'N/A'}

### Framework Information
- Framework: ${framework}
- Target Version: ${frameworkVersion}
- LLM Provider: ${metadata.llm_provider || 'N/A'}
- Model: ${metadata.llm_model || 'N/A'}

### Environment Compatibility
- Python: ${clientContext?.python?.version || 'Compatible'}
- Workspace: ${clientContext?.workspace?.has_requirements_txt ? 'Has requirements.txt' : 'No requirements.txt'}

*Note: Improvements are tailored for your specific environment (${framework} ${frameworkVersion}).*`;
    }

    async checkHealth(): Promise<{ healthy: boolean; message: string; version?: string }> {
        try {
            const response = await this.api.checkHealth();
            return {
                healthy: true,
                message: 'Connected',
                version: response.version
            };
        } catch (error) {
            return {
                healthy: false,
                message: error instanceof Error ? error.message : 'Connection failed'
            };
        }
    }

    clearCache(): void {
        this.cache.clear();
    }

    private detectFramework(code: string, language: string): string {
        if (language !== 'python') return 'pennylane';
        
        if (code.includes('import pennylane') || code.includes('from pennylane')) {
            return 'pennylane';
        } else if (code.includes('from qiskit') || code.includes('import qiskit')) {
            return 'qiskit';
        } else if (code.includes('import cirq') || code.includes('from cirq')) {
            return 'cirq';
        } else if (code.includes('import torchquantum') || code.includes('from torchquantum')) {
            return 'torchquantum';
        }
        
        const config = vscode.workspace.getConfiguration('quantum-ai');
        const defaultFramework = config.get('framework', 'pennylane') as string;
        return defaultFramework === 'auto' ? 'pennylane' : defaultFramework;
    }

    private getDetailLevel(): 'beginner' | 'intermediate' | 'advanced' {
        const config = vscode.workspace.getConfiguration('quantum-ai');
        return config.get('explanationDetailLevel', 'intermediate');
    }

    private formatExplanationResponse(response: ExplanationResponse): string {
        let formatted = '';
        
        if (response.overview) {
            formatted += `# Overview\n${response.overview}\n\n`;
        }
        
        if (response.gate_breakdown) {
            formatted += `## Gate Breakdown\n${response.gate_breakdown}\n\n`;
        }
        
        if (response.quantum_concepts) {
            formatted += `## Quantum Concepts\n${response.quantum_concepts}\n\n`;
        }
        
        if (response.mathematics) {
            formatted += `## Mathematical Formulation\n${response.mathematics}\n\n`;
        }
        
        if (response.applications) {
            formatted += `## Applications\n${response.applications}\n`;
        }
        
        return formatted;
    }
}
