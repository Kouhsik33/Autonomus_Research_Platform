import * as vscode from 'vscode';

export interface AIProvider {
    ask(prompt: string): Promise<string>;
    explain(code: string, language?: string): Promise<string>;
    fix(code: string, language?: string): Promise<string>;
    complete(context: string, language?: string): Promise<string>;
    suggest(code: string, language?: string): Promise<string>;
}

interface CacheEntry {
    response: string;
    timestamp: number;
}

interface HuggingFaceResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
}

export class GraniteProvider implements AIProvider {
    private apiKey: string | undefined;
    private baseEndpoint = "https://router.huggingface.co/v1/chat/completions";
    private cache = new Map<string, CacheEntry>();
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_RETRIES = 2;
    private pendingRequests = new Map<string, Promise<string>>();

    constructor(private context: vscode.ExtensionContext) {
        this.apiKey = process.env.HF_TOKEN;
        if (!this.apiKey) {
            vscode.window.showWarningMessage(
                "HF_TOKEN environment variable not set. AI features will not work. " +
                "Please set it and restart VS Code."
            );
        }
    }

    private getConfig() {
        const config = vscode.workspace.getConfiguration('quantum-ai');
        return {
            model: config.get('model', 'Qwen/Qwen2.5-Coder-7B-Instruct') as string,
            maxTokens: config.get('maxTokens', 500) as number,
            temperature: config.get('temperature', 0.2) as number,
            cacheEnabled: config.get('cacheCompletions', true) as boolean,
        };
    }

    private getCacheKey(prompt: string, type: string): string {
        const config = this.getConfig();
        return `${type}:${config.model}:${prompt}`;
    }

    private getCached(key: string): string | null {
        if (!this.getConfig().cacheEnabled) return null;
        
        const entry = this.cache.get(key);
        if (entry && Date.now() - entry.timestamp < this.CACHE_TTL) {
            return entry.response;
        }
        this.cache.delete(key);
        return null;
    }

    private setCached(key: string, response: string): void {
        if (!this.getConfig().cacheEnabled) return;
        
        // Limit cache size
        if (this.cache.size > 100) {
            const oldestKey = Array.from(this.cache.entries())
                .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]?.[0];
            if (oldestKey) this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, {
            response,
            timestamp: Date.now()
        });
    }

    private async makeRequest(prompt: string, systemPrompt: string): Promise<string> {
        if (!this.apiKey) {
            throw new Error("HF_TOKEN environment variable not set");
        }

        const config = this.getConfig();
        const cacheKey = this.getCacheKey(prompt + systemPrompt, 'request');
        
        // Check cache
        const cached = this.getCached(cacheKey);
        if (cached) return cached;

        // Check for pending identical request
        const pendingKey = `${prompt}:${systemPrompt}`;
        const pending = this.pendingRequests.get(pendingKey);
        if (pending) return pending;

        const makeRequestWithRetry = async (retryCount = 0): Promise<string> => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

                const response = await fetch(this.baseEndpoint, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: config.model,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: prompt }
                        ],
                        temperature: config.temperature,
                        max_tokens: config.maxTokens,
                        top_p: 0.95,
                        frequency_penalty: 0,
                        presence_penalty: 0
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 429 && retryCount < this.MAX_RETRIES) {
                        // Rate limited - wait and retry
                        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                        return makeRequestWithRetry(retryCount + 1);
                    }
                    throw new Error(`API error (${response.status}): ${errorText}`);
                }

                const data = await response.json() as HuggingFaceResponse;
                const result = data.choices?.[0]?.message?.content?.trim();
                
                if (!result) {
                    throw new Error("Empty response from API");
                }

                // Cache successful response
                this.setCached(cacheKey, result);
                return result;

            } catch (error: any) {
                if (error.name === 'AbortError') {
                    throw new Error("Request timeout");
                }
                throw error;
            }
        };

        const requestPromise = makeRequestWithRetry();
        this.pendingRequests.set(pendingKey, requestPromise);
        
        try {
            return await requestPromise;
        } finally {
            this.pendingRequests.delete(pendingKey);
        }
    }

    async ask(prompt: string): Promise<string> {
        return this.makeRequest(
            prompt,
            "You are a helpful coding assistant. Provide clear, concise answers."
        );
    }

    async explain(code: string, language: string = 'code'): Promise<string> {
        const prompt = `Explain this ${language} code in simple terms. Be concise but thorough:\n\n${code}`;
        return this.makeRequest(
            prompt,
            "You are an expert programmer explaining code to a colleague. Focus on the key concepts and logic."
        );
    }

    async fix(code: string, language: string = 'code'): Promise<string> {
        const prompt = `Fix any issues in this ${language} code. Return only the corrected code, no explanations:\n\n${code}`;
        const response = await this.makeRequest(
            prompt,
            "You are an expert debugger. Provide only the fixed code, no explanations or markdown."
        );
        return this.cleanCodeBlock(response);
    }

    

    async complete(context: string, language: string = 'code'): Promise<string> {
    // More specific prompt to avoid duplication
    const prompt = `Complete the following ${language} code. Return ONLY the new code that should be inserted, NOT the existing code:

        ${context}

        Continuation:`;
        
        const response = await this.makeRequest(
            prompt,
            `You are an expert ${language} programmer. Provide natural code completions. Return only the new code to insert, no explanations, no markdown.`
        );

        return this.cleanCodeBlock(response);
    }

    async suggest(code: string, language: string = 'code'): Promise<string> {
        const prompt = `Suggest improvements for this ${language} code. Focus on best practices, performance, and readability:\n\n${code}`;
        return this.makeRequest(
            prompt,
            "You are a senior code reviewer. Provide constructive suggestions for improvement."
        );
    }

    private cleanCodeBlock(text: string): string {
        // Remove markdown code fences
        const codeBlockMatch = text.match(/```(?:\w*)\n([\s\S]*?)```/);
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim();
        }

        // Remove inline code
        const inlineCodeMatch = text.match(/`([^`]+)`/);
        if (inlineCodeMatch && text.trim().startsWith('`') && text.trim().endsWith('`')) {
            return inlineCodeMatch[1].trim();
        }

        // Remove explanatory prefixes
        return text
            .replace(/^(Here'?s?|This is|The|Below is|Fixed|Corrected).*?:\s*/i, '')
            .replace(/^```\w*\s*/, '')
            .replace(/```$/, '')
            .trim();
    }

    clearCache(): void {
        this.cache.clear();
    }
}