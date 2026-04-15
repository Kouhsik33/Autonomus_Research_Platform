import * as vscode from 'vscode';
import { ConfigService } from './configService';

interface TelemetryEvent {
    name: string;
    properties?: Record<string, any>;
    measurements?: Record<string, number>;
}

export class TelemetryService {
    private static instance: TelemetryService;
    private config: ConfigService;
    private context: vscode.ExtensionContext;
    private queue: TelemetryEvent[] = [];
    private flushInterval: NodeJS.Timeout | undefined;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.config = ConfigService.getInstance();
        
        if (this.isEnabled()) {
            this.startFlushInterval();
        }
    }

    static getInstance(context: vscode.ExtensionContext): TelemetryService {
        if (!TelemetryService.instance) {
            TelemetryService.instance = new TelemetryService(context);
        }
        return TelemetryService.instance;
    }

    private isEnabled(): boolean {
        return this.config.get<boolean>('telemetryEnabled', true);
    }

    private startFlushInterval(): void {
        this.flushInterval = setInterval(() => {
            this.flush();
        }, 60000); // Flush every minute
    }

    trackEvent(name: string, properties?: Record<string, any>, measurements?: Record<string, number>): void {
        if (!this.isEnabled()) return;

        const event: TelemetryEvent = {
            name,
            properties: {
                ...properties,
                extensionVersion: this.context.extension.packageJSON.version,
                vscodeVersion: vscode.version,
                platform: process.platform
            },
            measurements
        };

        this.queue.push(event);

        // Flush immediately if queue is getting large
        if (this.queue.length >= 10) {
            this.flush();
        }
    }

    trackError(error: string, properties?: Record<string, any>): void {
        this.trackEvent('error', {
            error,
            ...properties
        });
    }

    private async flush(): Promise<void> {
        if (this.queue.length === 0) return;

        const events = [...this.queue];
        this.queue = [];

        try {
            // Send to your backend telemetry endpoint
            await fetch('http:/api/telemetry', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ events })
            });
        } catch (error) {
            // Fail silently - don't let telemetry affect user experience
            console.error('Failed to send telemetry:', error);
            // Re-queue events for next flush
            this.queue.unshift(...events);
        }
    }

    dispose(): void {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        this.flush(); // Final flush
    }
}