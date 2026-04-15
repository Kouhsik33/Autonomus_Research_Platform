# Quantum AI

Quantum AI is a VS Code extension for AI-assisted coding with quantum-focused workflows (explain, fix, suggest, transpile, inline completion, and chat/ARP panel support).

## Prerequisites

- VS Code `1.85.0` or newer
- Node.js `18+` and npm (for local development)
- Running backend API (default: `http://localhost:8000/api`)
- Optional ARP backend (default: `http://127.0.0.1:8001/api/v1`)

## Install

### Option 1: Install from VSIX

1. Open VS Code.
2. Go to Extensions view.
3. Click `...` (top-right) -> `Install from VSIX...`.
4. Select the `.vsix` file.
5. Reload VS Code when prompted.

### Option 2: Run from source (extension development)

1. Clone this repository.
2. Install dependencies:

```bash
npm install
```

3. Build the extension:

```bash
npm run compile
```

4. Press `F5` in VS Code to launch an Extension Development Host.

## Setup

### 1) Configure backend URL

In VS Code settings, set:

- `quantum-ai.backendUrl` (default: `http://localhost:8000/api`)
- `quantum-ai.arp.baseUrl` (default: `http://127.0.0.1:8001/api/v1`) if using ARP features

You can also run `Quantum AI: Configure Settings` from Command Palette.

### 2) (Optional) Set Hugging Face token

Some provider paths rely on `HF_TOKEN` environment variable.

Windows (PowerShell):

```powershell
setx HF_TOKEN "your_token_here"
```

Then fully restart VS Code.

## Usage Guide

### Core commands (Command Palette)

- `Quantum AI: Explain Code`
- `Quantum AI: Fix Code`
- `Quantum AI: Suggest Improvements`
- `Quantum AI: Transpile Code`
- `Quantum AI: Open Chat`
- `Quantum AI: Open ARP Chat Panel`
- `Quantum AI: Configure Settings`
- `Quantum AI: Clear Cache`

### Keyboard shortcuts

- Explain selected code: `Ctrl+K Ctrl+E` (`Cmd+K Cmd+E` on macOS)
- Fix selected code: `Ctrl+K Ctrl+F` (`Cmd+K Cmd+F` on macOS)
- Transpile selected Python code: `Ctrl+K Ctrl+T` (`Cmd+K Cmd+T` on macOS)

### Typical workflow

1. Select code in the editor.
2. Run one of Explain/Fix/Suggest/Transpile commands.
3. Review AI output and apply changes.
4. For inline completions, keep `quantum-ai.completionEnabled` set to `true`.

## Development Scripts

- `npm run compile` -> build extension bundle
- `npm run watch` -> build in watch mode
- `npm run package` -> production bundle build
- `npm run lint` -> lint TypeScript files
- `npm run test` -> run extension tests

## Troubleshooting

- Backend unreachable: verify `quantum-ai.backendUrl` and backend service health.
- ARP panel issues: verify `quantum-ai.arp.baseUrl` and ARP backend availability.
- No AI responses: check Output panel (`Quantum AI`) and confirm token/backend configuration.
