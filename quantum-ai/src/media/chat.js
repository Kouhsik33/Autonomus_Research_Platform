(function() {
    const vscode = acquireVsCodeApi();
    
    let currentMode = 'quantum';
    let messages = [];

    // Mode switching
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.mode;
            vscode.postMessage({
                command: 'switchMode',
                mode: currentMode
            });
        });
    });

    // Send message
    document.getElementById('send-button').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    function sendMessage() {
        const input = document.getElementById('message-input');
        const text = input.value.trim();
        if (!text) return;

        addMessage('user', text);
        input.value = '';

        vscode.postMessage({
            command: 'sendMessage',
            text: text
        });

        showLoading();
    }

    function addMessage(role, content) {
        const messagesDiv = document.getElementById('messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        // Simple markdown-like rendering
        if (content.includes('```')) {
            const parts = content.split('```');
            parts.forEach((part, index) => {
                if (index % 2 === 1) {
                    // Code block
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = part.replace(/^python\n/, '');
                    pre.appendChild(code);
                    contentDiv.appendChild(pre);
                } else if (part.trim()) {
                    // Text
                    const p = document.createElement('p');
                    p.innerHTML = part.replace(/\n/g, '<br>');
                    contentDiv.appendChild(p);
                }
            });
        } else {
            contentDiv.innerHTML = content.replace(/\n/g, '<br>');
        }
        
        messageDiv.appendChild(contentDiv);
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        messageDiv.appendChild(timeDiv);
        
        messagesDiv.appendChild(messageDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function showLoading() {
        const messagesDiv = document.getElementById('messages');
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message assistant loading';
        loadingDiv.id = 'loading-message';
        loadingDiv.innerHTML = '<div class="message-content">🤔 Thinking...</div>';
        messagesDiv.appendChild(loadingDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function hideLoading() {
        const loading = document.getElementById('loading-message');
        if (loading) loading.remove();
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.command) {
            case 'addMessage':
                hideLoading();
                addMessage(message.message.role, message.message.content);
                break;
            case 'error':
                hideLoading();
                addMessage('assistant', `❌ Error: ${message.message}`);
                break;
            case 'modeSwitched':
                addMessage('system', `Switched to ${message.mode === 'quantum' ? 'QuantumBot' : 'Autonomous Researcher'} mode`);
                break;
            case 'arpUpdate':
                // Handle ARP status updates
                const statusDiv = document.getElementById('arp-status') || document.createElement('div');
                statusDiv.id = 'arp-status';
                statusDiv.className = 'arp-status';
                statusDiv.innerHTML = `Status: ${message.status.state}<br>Progress: ${message.status.progress || 0}%`;
                break;
        }
    });
})();