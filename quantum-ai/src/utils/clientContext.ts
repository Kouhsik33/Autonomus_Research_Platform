import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { ClientContext } from '../types/api';

const execAsync = promisify(exec);

// Extended interface to include all the new fields
export interface ExtendedClientContext extends ClientContext {
    vscode_version?: string;
    python?: PythonContext;
    installed_packages?: Record<string, string>;
    environment?: EnvironmentContext;
    workspace?: WorkspaceContext;
    system?: SystemContext;
    [key: string]: any; // Allow dynamic properties
}

export interface PythonContext {
    version?: string;
    path?: string;
    virtual_env?: string | null;
    conda_env?: string | null;
    pip_version?: string;
}

export interface EnvironmentContext {
    node_version?: string;
    npm_version?: string;
    is_dev?: boolean;
    extension_path?: string;
}

export interface WorkspaceContext {
    has_python_files?: boolean;
    has_requirements_txt?: boolean;
    has_environment_yml?: boolean;
    has_pyproject_toml?: boolean;
    workspace_folders?: string[];
    active_file?: string;
}

export interface SystemContext {
    os: string;
    arch: string;
    memory_gb?: number;
    cpu_cores?: number;
    hostname?: string;
}

/**
 * Enhanced client context with dynamic environment detection
 * This is the main function to use - it's async and gathers all available info
 */
export async function getEnhancedClientContext(context: vscode.ExtensionContext): Promise<ExtendedClientContext> {
    const extension = vscode.extensions.getExtension('quantumHub.quantum-ai');
    const version = extension?.packageJSON?.version || 'unknown';
    
    // Start with base context
    const clientContext: ExtendedClientContext = {
        client_type: 'vscode_extension',
        version,
        platform: process.platform,
        vscode_version: vscode.version,
        system: {
            os: process.platform,
            arch: process.arch,
        },
        environment: {
            node_version: process.version,
            is_dev: process.env.NODE_ENV === 'development',
            extension_path: context.extensionPath,
        }
    };

    // Add active file info
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        clientContext.active_file = {
            language: activeEditor.document.languageId,
            path: activeEditor.document.uri.fsPath,
            framework: getFrameworkFromDocument(activeEditor.document)
        };
    }

    // Get Python information (non-blocking - don't await)
    getPythonInfo().then(pythonInfo => {
        if (pythonInfo) {
            clientContext.python = pythonInfo;
        }
    }).catch(() => {
        // Silently fail - don't block extension activation
    });

    // Get installed Python packages (non-blocking)
    getInstalledPackages().then(packages => {
        if (packages && Object.keys(packages).length > 0) {
            clientContext.installed_packages = packages;
        }
    }).catch(() => {
        // Silently fail
    });

    // Get workspace context (synchronous)
    const workspaceContext = getWorkspaceContext();
    if (workspaceContext) {
        clientContext.workspace = workspaceContext;
    }

    // Get system info
    try {
        const os = require('os');
        if (clientContext.system) {
            clientContext.system.memory_gb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
            clientContext.system.cpu_cores = os.cpus().length;
            clientContext.system.hostname = os.hostname();
        }
    } catch {
        // Ignore system info errors
    }

    return clientContext;
}

/**
 * Synchronous version for backward compatibility
 * Returns only immediately available data
 */
export function getClientContext(context: vscode.ExtensionContext): ClientContext {
    const extension = vscode.extensions.getExtension('quantumHub.quantum-ai');
    const version = extension?.packageJSON?.version || 'unknown';

    return {
        client_type: 'vscode_extension',
        version,
        platform: process.platform
    };
}

/**
 * Get comprehensive client context with all available data
 * This is a hybrid approach - returns sync data immediately and attaches async data when ready
 */
export function getClientContextWithAsync(
    context: vscode.ExtensionContext, 
    callback?: (fullContext: ExtendedClientContext) => void
): ExtendedClientContext {
    const extension = vscode.extensions.getExtension('quantumHub.quantum-ai');
    const version = extension?.packageJSON?.version || 'unknown';
    
    // Create context with sync data
    const clientContext: ExtendedClientContext = {
        client_type: 'vscode_extension',
        version,
        platform: process.platform,
        vscode_version: vscode.version,
        system: {
            os: process.platform,
            arch: process.arch,
        },
        environment: {
            node_version: process.version,
            is_dev: process.env.NODE_ENV === 'development',
            extension_path: context.extensionPath,
        }
    };

    // Add active file info
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        clientContext.active_file = {
            language: activeEditor.document.languageId,
            path: activeEditor.document.uri.fsPath,
            framework: getFrameworkFromDocument(activeEditor.document)
        };
    }

    // Add workspace context
    const workspaceContext = getWorkspaceContext();
    if (workspaceContext) {
        clientContext.workspace = workspaceContext;
    }

    // Get system info
    try {
        const os = require('os');
        if (clientContext.system) {
            clientContext.system.memory_gb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
            clientContext.system.cpu_cores = os.cpus().length;
            clientContext.system.hostname = os.hostname();
        }
    } catch {
        // Ignore system info errors
    }

    // Gather async data in background
    Promise.all([
        getPythonInfo(),
        getInstalledPackages()
    ]).then(([pythonInfo, packages]) => {
        if (pythonInfo) {
            clientContext.python = pythonInfo;
        }
        if (packages) {
            clientContext.installed_packages = packages;
        }
        
        // Call callback if provided with the complete context
        if (callback) {
            callback(clientContext);
        }
    }).catch(() => {
        // Still call callback even if async fails
        if (callback) {
            callback(clientContext);
        }
    });

    return clientContext;
}

async function getPythonInfo(): Promise<PythonContext | undefined> {
    try {
        // Try to get Python from workspace settings first
        const pythonConfig = vscode.workspace.getConfiguration('python') as vscode.WorkspaceConfiguration;
        const pythonPath = pythonConfig.get('defaultInterpreterPath') as string || 
                          pythonConfig.get('interpreterPath') as string ||
                          'python';

        // Get Python version
        const { stdout: versionOutput } = await execAsync(`"${pythonPath}" --version`).catch(() => 
            execAsync('python --version')
        );
        
        const versionMatch = versionOutput.match(/Python (\d+\.\d+\.\d+)/);
        const pythonVersion = versionMatch ? versionMatch[1] : undefined;

        // Get virtual environment info
        const venvPath = process.env.VIRTUAL_ENV;
        const condaPrefix = process.env.CONDA_PREFIX;

        // Get pip version
        let pipVersion: string | undefined;
        try {
            const { stdout: pipOutput } = await execAsync(`"${pythonPath}" -m pip --version`).catch(() => 
                execAsync('pip --version')
            );
            const pipMatch = pipOutput.match(/pip (\d+\.\d+\.\d+)/);
            pipVersion = pipMatch ? pipMatch[1] : undefined;
        } catch {
            // pip not available
        }

        return {
            version: pythonVersion,
            path: pythonPath,
            virtual_env: venvPath || null,
            conda_env: condaPrefix || null,
            pip_version: pipVersion
        };

    } catch (error) {
        // Python not available
        return undefined;
    }
}

async function getInstalledPackages(): Promise<Record<string, string> | undefined> {
    const quantumPackages = ['qiskit', 'pennylane', 'cirq', 'torchquantum', 'torch', 'tensorflow', 'pytorch'];
    const packages: Record<string, string> = {};

    try {
        // Try to get python path
        const pythonConfig = vscode.workspace.getConfiguration('python');
        const pythonPath = pythonConfig.get('defaultInterpreterPath') as string || 'python';

        // Check each quantum package
        for (const pkg of quantumPackages) {
            try {
                const { stdout } = await execAsync(`"${pythonPath}" -c "import ${pkg}; print(${pkg}.__version__)"`).catch(() => 
                    execAsync(`python -c "import ${pkg}; print(${pkg}.__version__)"`)
                );
                
                if (stdout && stdout.trim()) {
                    packages[pkg] = stdout.trim();
                }
            } catch {
                // Package not installed - skip silently
                continue;
            }
        }

        // Try to get all packages from pip list (optional)
        try {
            const { stdout } = await execAsync(`"${pythonPath}" -m pip list --format=json`).catch(() => 
                execAsync('pip list --format=json')
            );
            
            if (stdout) {
                const pipPackages = JSON.parse(stdout);
                pipPackages.forEach((pkg: any) => {
                    // Only add if not already added and it's a quantum-related package
                    if (!packages[pkg.name] && isQuantumRelated(pkg.name)) {
                        packages[pkg.name] = pkg.version;
                    }
                });
            }
        } catch {
            // pip list failed - skip
        }

        return Object.keys(packages).length > 0 ? packages : undefined;

    } catch (error) {
        return undefined;
    }
}

function isQuantumRelated(packageName: string): boolean {
    const quantumKeywords = ['quantum', 'qiskit', 'pennylane', 'cirq', 'qubit', 'qasm', 'braket', 'qsharp', 'quil'];
    const lowerName = packageName.toLowerCase();
    return quantumKeywords.some(keyword => lowerName.includes(keyword));
}

function getWorkspaceContext(): WorkspaceContext | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return undefined;
    }

    const context: WorkspaceContext = {
        workspace_folders: workspaceFolders.map((f: vscode.WorkspaceFolder) => f.uri.fsPath),
        has_python_files: false,
        has_requirements_txt: false,
        has_environment_yml: false,
        has_pyproject_toml: false
    };

    // Add active file if any
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        context.active_file = activeEditor.document.uri.fsPath;
    }

    // Check for Python files and config files
    const fs = require('fs');
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;

        try {
            const files = fs.readdirSync(folderPath);
            context.has_python_files = context.has_python_files || files.some((f: string) => f.endsWith('.py'));
            context.has_requirements_txt = context.has_requirements_txt || files.includes('requirements.txt');
            context.has_environment_yml = context.has_environment_yml || files.includes('environment.yml');
            context.has_pyproject_toml = context.has_pyproject_toml || files.includes('pyproject.toml');
        } catch {
            // Ignore errors for individual folders
        }
    }

    return context;
}

/**
 * Detect quantum framework from document content
 * (kept exactly as in original)
 */
export function getFrameworkFromDocument(document: vscode.TextDocument): string {
    const text = document.getText();
    
    // Detect quantum framework from imports
    if (text.includes('from qiskit') || text.includes('import qiskit')) {
        return 'qiskit';
    } else if (text.includes('import pennylane') || text.includes('from pennylane')) {
        return 'pennylane';
    } else if (text.includes('import cirq') || text.includes('from cirq')) {
        return 'cirq';
    } else if (text.includes('import torchquantum') || text.includes('from torchquantum')) {
        return 'torchquantum';
    }
    
    // Default based on language or config
    const config = vscode.workspace.getConfiguration('quantum-ai');
    const defaultFramework = config.get('framework', 'qiskit') as string;
    
    return defaultFramework === 'auto' ? 'qiskit' : defaultFramework;
}