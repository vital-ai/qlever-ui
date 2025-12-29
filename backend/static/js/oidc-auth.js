/**
 * Frontend OIDC Authentication for Keycloak
 */

// Keycloak configuration - these will be set by Django template
const KEYCLOAK_CONFIG = {
    url: 'http://host.docker.internal:8085',
    realm: 'cardiffportal',
    clientId: 'qlever-ui',
    redirectUri: 'http://host.docker.internal:8178/auth/callback',
    postLogoutRedirectUri: 'http://host.docker.internal:8178/'
};

/**
 * Generate code challenge for PKCE
 * Falls back to plain text if crypto.subtle is not available (non-secure context)
 */
async function generateCodeChallenge(codeVerifier) {
    // Check if crypto.subtle is available (secure context required)
    if (crypto && crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(codeVerifier);
            const digest = await crypto.subtle.digest('SHA-256', data);
            const base64String = btoa(String.fromCharCode(...new Uint8Array(digest)));
            return base64String.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        } catch (error) {
            console.warn('SHA256 hashing failed, falling back to plain text PKCE');
        }
    }
    
    // Fallback to plain text (still secure for public clients)
    return codeVerifier;
}

/**
 * Generate Keycloak login URL with PKCE
 */
async function getKeycloakLoginUrl() {
    const state = generateRandomString(32);
    const nonce = generateRandomString(32);
    const codeVerifier = generateRandomString(128);
    
    // Store state, nonce, and code verifier for verification
    localStorage.setItem('oidc_state', state);
    localStorage.setItem('oidc_nonce', nonce);
    localStorage.setItem('oidc_code_verifier', codeVerifier);
    
    // Generate code challenge (SHA256 hash of code verifier)
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: KEYCLOAK_CONFIG.clientId,
        redirect_uri: KEYCLOAK_CONFIG.redirectUri,
        scope: 'openid profile email',
        state: state,
        nonce: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: crypto && crypto.subtle ? 'S256' : 'plain'
    });
    
    return `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth?${params}`;
}

/**
 * Generate Keycloak logout URL
 */
function getKeycloakLogoutUrl() {
    const params = new URLSearchParams({
        post_logout_redirect_uri: KEYCLOAK_CONFIG.postLogoutRedirectUri
    });
    
    return `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/logout?${params}`;
}

/**
 * Handle OIDC callback after Keycloak redirect
 */
async function handleOIDCCallback() {
    // Prevent multiple executions
    if (window.oidcCallbackProcessing) {
        return;
    }
    window.oidcCallbackProcessing = true;
    
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');
    
    if (error) {
        console.error('OIDC Error:', error);
        alert('Authentication failed: ' + error);
        return;
    }
    
    // Verify state parameter
    const storedState = localStorage.getItem('oidc_state');
    if (state !== storedState) {
        console.error('Invalid state parameter');
        alert('Authentication failed: Invalid state');
        return;
    }
    
    if (code) {
        try {
            await exchangeCodeForTokens(code);
            // Clear the processing flag before redirect
            window.oidcCallbackProcessing = false;
            // Redirect to main page
            window.location.href = '/';
        } catch (error) {
            console.error('Token exchange failed:', error);
            alert('Authentication failed: ' + error.message);
            window.oidcCallbackProcessing = false;
        }
    }
}

/**
 * Exchange authorization code for tokens with PKCE
 */
async function exchangeCodeForTokens(code) {
    const tokenEndpoint = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;
    const codeVerifier = localStorage.getItem('oidc_code_verifier');
    
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: KEYCLOAK_CONFIG.clientId,
        code: code,
        redirect_uri: KEYCLOAK_CONFIG.redirectUri,
        code_verifier: codeVerifier
    });
    
    console.log('Token exchange request:', {
        endpoint: tokenEndpoint,
        params: Object.fromEntries(params)
    });
    
    const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error('Token exchange failed:', response.status, errorText);
        throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }
    
    const tokens = await response.json();
    
    // Store tokens
    localStorage.setItem('access_token', tokens.access_token);
    localStorage.setItem('id_token', tokens.id_token);
    if (tokens.refresh_token) {
        localStorage.setItem('refresh_token', tokens.refresh_token);
    }
    
    // Clean up OIDC state
    localStorage.removeItem('oidc_state');
    localStorage.removeItem('oidc_nonce');
    localStorage.removeItem('oidc_code_verifier');
}

/**
 * Check if user is authenticated
 */
function isAuthenticated() {
    const accessToken = localStorage.getItem('access_token');
    if (!accessToken) return false;
    
    try {
        // Basic JWT expiration check
        const payload = JSON.parse(atob(accessToken.split('.')[1]));
        const now = Math.floor(Date.now() / 1000);
        return payload.exp > now;
    } catch (error) {
        return false;
    }
}

/**
 * Get current user info from ID token
 */
function getCurrentUser() {
    const idToken = localStorage.getItem('id_token');
    if (!idToken) return null;
    
    try {
        const payload = JSON.parse(atob(idToken.split('.')[1]));
        return {
            username: payload.preferred_username || payload.sub,
            email: payload.email,
            name: payload.name
        };
    } catch (error) {
        return null;
    }
}

/**
 * Logout user
 */
function logout() {
    // Clear tokens
    localStorage.removeItem('access_token');
    localStorage.removeItem('id_token');
    localStorage.removeItem('refresh_token');
    
    // Redirect to Keycloak logout
    window.location.href = getKeycloakLogoutUrl();
}

/**
 * Generate random string for state/nonce
 */
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Update authentication UI
 */
function updateAuthUI() {
    const authStatus = document.getElementById('auth-status');
    const logoutBtn = document.getElementById('logout-btn');
    const usernameSpan = document.getElementById('username');
    
    if (isAuthenticated()) {
        const user = getCurrentUser();
        if (user && authStatus && logoutBtn && usernameSpan) {
            usernameSpan.textContent = user.username || user.email || 'User';
            authStatus.style.display = 'block';
            logoutBtn.style.display = 'block';
        }
    } else {
        if (authStatus && logoutBtn) {
            authStatus.style.display = 'none';
            logoutBtn.style.display = 'none';
        }
    }
}

/**
 * Initialize authentication on page load
 */
async function initAuth() {
    // Check if this is a callback URL
    if (window.location.pathname === '/auth/callback') {
        handleOIDCCallback();
        return;
    }
    
    // Check if user needs to authenticate
    if (!isAuthenticated()) {
        // Redirect to login
        const loginUrl = await getKeycloakLoginUrl();
        window.location.href = loginUrl;
    } else {
        // Update UI to show authenticated state
        updateAuthUI();
    }
}

// Initialize authentication when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initAuth();
});
