import * as vscode from 'vscode';

interface CacheEntry<T> {
    value: T;
    timestamp: number;
    ttl: number;
}

export class CacheService {
    private static instance: CacheService;
    private cache = new Map<string, CacheEntry<any>>();
    private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_SIZE = 100;

    private constructor(private context: vscode.ExtensionContext) {
        // Load cache from global state
        const saved = this.context.globalState.get<Record<string, CacheEntry<any>>>('cache');
        if (saved) {
            this.cache = new Map(Object.entries(saved));
        }
    }

    static getInstance(context: vscode.ExtensionContext): CacheService {
        if (!CacheService.instance) {
            CacheService.instance = new CacheService(context);
        }
        return CacheService.instance;
    }

    async get<T>(key: string): Promise<T | null> {
        const entry = this.cache.get(key);
        
        if (!entry) {
            return null;
        }

        // Check if expired
        if (Date.now() - entry.timestamp > entry.ttl) {
            this.cache.delete(key);
            await this.persist();
            return null;
        }

        return entry.value as T;
    }

    async set<T>(key: string, value: T, ttl: number = this.DEFAULT_TTL): Promise<void> {
        // Enforce size limit
        if (this.cache.size >= this.MAX_SIZE) {
            const oldestKey = Array.from(this.cache.entries())
                .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]?.[0];
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, {
            value,
            timestamp: Date.now(),
            ttl
        });

        await this.persist();
    }

    async delete(key: string): Promise<void> {
        this.cache.delete(key);
        await this.persist();
    }

    async clear(): Promise<void> {
        this.cache.clear();
        await this.persist();
    }

    private async persist(): Promise<void> {
        await this.context.globalState.update('cache', Object.fromEntries(this.cache));
    }

    getSize(): number {
        return this.cache.size;
    }
}