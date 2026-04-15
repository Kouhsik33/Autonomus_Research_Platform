// src/services/authService.ts
import * as vscode from 'vscode';

interface AuthResponse {
    token: string;
    user?: {
        id: string;
        name: string;
        email: string;
    };
}

export class AuthService {
    private static instance: AuthService;
    private context: vscode.ExtensionContext;
    private _isAuthenticated: boolean = false;
    private _token: string | undefined;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadStoredToken();
    }

    static getInstance(context: vscode.ExtensionContext): AuthService {
        if (!AuthService.instance) {
            AuthService.instance = new AuthService(context);
        }
        return AuthService.instance;
    }

    private loadStoredToken(): void {
        this._token = this.context.globalState.get<string>('authToken');
        this._isAuthenticated = !!this._token;
    }

    async login(): Promise<boolean> {
        const options: vscode.QuickPickItem[] = [
            {
                label: "$(github) GitHub",
                description: "Login with GitHub",
                detail: "Use your GitHub account"
            },
            {
                label: "$(key) API Key",
                description: "Enter API key",
                detail: "Use your Quantum AI API key"
            }
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Choose login method",
            title: "Login to Quantum AI"
        });

        if (!selected) return false;

        if (selected.label.includes("GitHub")) {
            return this.loginWithGitHub();
        } else {
            return this.loginWithApiKey();
        }
    }

    private async loginWithGitHub(): Promise<boolean> {
        try {
            const session = await vscode.authentication.getSession('github', ['user:email'], {
                createIfNone: true
            });

            if (session) {
                const response = await fetch('http://127.0.0.1:8000/auth/github', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ token: session.accessToken })
                });

                if (response.ok) {
                    const data = await response.json() as AuthResponse;
                    await this.setToken(data.token);
                    vscode.window.showInformationMessage('Successfully logged in with GitHub');
                    return true;
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage('Failed to login with GitHub');
        }
        return false;
    }

    private async loginWithApiKey(): Promise<boolean> {
        const apiKey = await vscode.window.showInputBox({
            prompt: "Enter your Quantum AI API key",
            password: true,
            validateInput: (input: string) => {
                if (!input || input.length < 10) {
                    return "Please enter a valid API key";
                }
                return null;
            }
        });

        if (apiKey) {
            try {
                const response = await fetch('http://127.0.0.1:8000/auth/validate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ apiKey })
                });

                if (response.ok) {
                    const data = await response.json() as AuthResponse;
                    await this.setToken(data.token);
                    vscode.window.showInformationMessage('Successfully logged in with API key');
                    return true;
                } else {
                    vscode.window.showErrorMessage('Invalid API key');
                }
            } catch (error) {
                vscode.window.showErrorMessage('Failed to validate API key');
            }
        }
        return false;
    }

    private async setToken(token: string): Promise<void> {
        this._token = token;
        this._isAuthenticated = true;
        await this.context.globalState.update('authToken', token);
        
        // Notify other services
        await vscode.commands.executeCommand('quantum-ai.updateAuth');
    }

    async logout(): Promise<void> {
        this._token = undefined;
        this._isAuthenticated = false;
        await this.context.globalState.update('authToken', undefined);
        
        await vscode.commands.executeCommand('quantum-ai.updateAuth');
        vscode.window.showInformationMessage('Logged out successfully');
    }

    async isAuthenticated(): Promise<boolean> {
        if (!this._isAuthenticated) {
            this.loadStoredToken();
        }
        return this._isAuthenticated;
    }

    isAuthenticatedSync(): boolean {
        return this._isAuthenticated;
    }

    getToken(): string | undefined {
        return this._token;
    }
}