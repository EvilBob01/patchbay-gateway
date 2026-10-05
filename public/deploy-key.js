// --- Deploy SSH Key to a New Host ---

async function loadGatewayPublicKey() {
    const keyDisplay = document.getElementById('gateway-public-key');
    if (!keyDisplay) return;
    try {
        const response = await fetch('/admin/deploy-key/public-key');
        if (!response.ok) throw new Error(`Failed to load public key (${response.status})`);
        const data = await response.json();
        keyDisplay.value = data.publicKey;
    } catch (error) {
        keyDisplay.value = `Error loading public key: ${error.message}`;
    }
}

function initializeDeployKeySection() {
    const form = document.getElementById('deploy-key-form');
    const statusEl = document.getElementById('deploy-key-status');
    if (form && !form.dataset.listenerAttached) {
        form.dataset.listenerAttached = 'true';
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const host = document.getElementById('deploy-host').value.trim();
            const port = document.getElementById('deploy-port').value.trim() || '22';
            const username = document.getElementById('deploy-username').value.trim();
            const passwordInput = document.getElementById('deploy-password');
            const password = passwordInput.value;

            statusEl.style.color = 'orange';
            statusEl.textContent = `Connecting to ${username}@${host}:${port}...`;

            try {
                const response = await fetch('/admin/deploy-key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host, port, username, password })
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    statusEl.style.color = 'green';
                    statusEl.textContent = result.message;
                    passwordInput.value = ''; // never keep the password around client-side longer than needed
                } else {
                    statusEl.style.color = 'red';
                    statusEl.textContent = result.error || 'Failed to deploy key.';
                }
            } catch (error) {
                statusEl.style.color = 'red';
                statusEl.textContent = `Network error: ${error.message}`;
            }
        });
    }
}

window.loadGatewayPublicKey = loadGatewayPublicKey;
window.initializeDeployKeySection = initializeDeployKeySection;
