# Keycloak Integration Plan for QLever UI - COMPLETED ✅

## Overview

This document outlines the integration of Keycloak authentication into the QLever UI webapp, including JWT token handling for SPARQL service requests and the map functionality.

## Current Architecture Analysis

### Backend (Django)
- **Framework**: Django with REST framework
- **Authentication**: Currently uses Django's built-in auth (`django.contrib.auth`)
- **Models**: `Backend` model stores QLever service configurations
- **Views**: Main views in `backend/views.py` handle SPARQL proxy functionality
- **SPARQL Requests**: Made via `fetchQleverBackend()` function in JavaScript

### Frontend (JavaScript)
- **SPARQL Requests**: Handled by `fetchQleverBackend()` in `helper.js`
- **Map Functionality**: Map button appears when geo data detected, opens external map service
- **Current Headers**: Only sends `Accept: application/qlever-results+json` and custom headers

### Key Files Identified
- `backend/views.py` - Main Django views
- `backend/models.py` - Backend configuration model (includes `mapViewBaseURL`)
- `backend/static/js/helper.js` - SPARQL request handling
- `backend/static/js/qleverUI.js` - Main UI logic including map button
- `backend/templates/index.html` - Main UI template

## Integration Requirements

### 1. Web Application Authentication
- Secure the QLever UI webapp with Keycloak OIDC
- Protect admin interface and sensitive operations
- Maintain session management across requests

### 2. SPARQL Service JWT Headers
- Include JWT tokens in all SPARQL requests to QLever backend
- Handle token refresh automatically
- Maintain backward compatibility for non-authenticated scenarios

### 3. Map Button JWT Integration
- Pass JWT tokens when opening map URLs
- Handle cross-origin token passing securely

## Implementation Plan

### Phase 1: Keycloak OIDC Integration for Web App

#### 1.1 Dependencies
```python
# Add to requirements.txt
mozilla-django-oidc==3.0.0
requests==2.31.0
```

#### 1.2 Django Settings Configuration
```python
# qlever/settings.py additions
INSTALLED_APPS = [
    # ... existing apps
    'mozilla_django_oidc',
]

MIDDLEWARE = [
    # ... existing middleware
    'mozilla_django_oidc.middleware.OIDCAuthenticationMiddleware',
]

# OIDC Configuration
OIDC_RP_CLIENT_ID = env.str('KEYCLOAK_CLIENT_ID')
OIDC_RP_CLIENT_SECRET = env.str('KEYCLOAK_CLIENT_SECRET')
OIDC_OP_AUTHORIZATION_ENDPOINT = env.str('KEYCLOAK_AUTH_URL')
OIDC_OP_TOKEN_ENDPOINT = env.str('KEYCLOAK_TOKEN_URL')
OIDC_OP_USER_ENDPOINT = env.str('KEYCLOAK_USERINFO_URL')
OIDC_OP_JWKS_ENDPOINT = env.str('KEYCLOAK_JWKS_URL')

# Authentication backends
AUTHENTICATION_BACKENDS = [
    'mozilla_django_oidc.auth.OIDCAuthenticationBackend',
    'django.contrib.auth.backends.ModelBackend',
]

# Login/logout URLs
LOGIN_URL = '/oidc/authenticate/'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = '/'

# Store OIDC tokens in session for API calls
OIDC_STORE_ACCESS_TOKEN = True
OIDC_STORE_ID_TOKEN = True
```

#### 1.3 URL Configuration
```python
# qlever/urls.py
from django.urls import path, include

urlpatterns = [
    # ... existing patterns
    path('oidc/', include('mozilla_django_oidc.urls')),
]

# backend/urls.py
urlpatterns = [
    # ... existing patterns
    re_path(r'^map\?(.*)$', views.map_proxy, name='map_proxy'),
    path('api/get-access-token/', views.get_access_token, name='get_access_token'),
]
```

#### 1.4 Backend Model Extensions
```python
# backend/models.py additions
class Backend(models.Model):
    # ... existing fields
    
    requiresAuthentication = models.BooleanField(
        default=False,
        help_text="Check if this backend requires JWT authentication",
        verbose_name="Requires Authentication"
    )
    
    jwtAudience = models.CharField(
        max_length=500,
        default="",
        blank=True,
        help_text="JWT audience claim for this backend",
        verbose_name="JWT Audience"
    )
```

### Phase 2: Simple Django Authentication Integration

#### 2.1 Authentication Helper Functions
```python
# backend/auth_utils.py (new file)
def get_oidc_access_token(request):
    """Get OIDC access token from session"""
    if request.user.is_authenticated:
        return request.session.get('oidc_access_token')
    return None

def requires_authentication(view_func):
    """Decorator to require authentication for views"""
    from django.contrib.auth.decorators import login_required
    return login_required(view_func)
```

#### 2.2 View Modifications for Authentication
```python
# backend/views.py modifications
import urllib.parse
import requests
from django.contrib.auth.decorators import login_required
from django.http import HttpResponse, HttpResponseForbidden, HttpResponseBadRequest, HttpResponseServerError, JsonResponse
from django.shortcuts import render, redirect
from django.views.decorators.csrf import csrf_exempt
from .auth_utils import get_oidc_access_token

def index(request, backend=None, short=None):
    # ... existing logic
    
    # Check if backend requires authentication
    backend_requires_auth = activeBackend and activeBackend.requiresAuthentication
    
    # If authentication required but user not logged in, redirect to login
    if backend_requires_auth and not request.user.is_authenticated:
        return redirect('/oidc/authenticate/')
    
    return render(
        request,
        "index.html",
        {
            # ... existing context
            "user_authenticated": request.user.is_authenticated,
            "backend_requires_auth": backend_requires_auth,
        },
    )

def get_access_token(request):
    """Provide access token to frontend for SPARQL requests"""
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not authenticated'}, status=401)
    
    token = get_oidc_access_token(request)
    if token:
        return JsonResponse({'access_token': token})
    else:
        return JsonResponse({'error': 'No token available'}, status=401)

@login_required
def map_proxy(request):
    """Server-side proxy that fetches map content with JWT authentication"""
    # Get the full map URL from the request parameter
    map_url = request.GET.get('url') or request.path_info.replace('/map?', '', 1)
    
    if not map_url:
        return HttpResponseBadRequest("Map URL parameter required")
    
    # Decode URL if it was encoded
    if map_url.startswith('http'):
        map_url = urllib.parse.unquote(map_url)
    
    # Get OIDC access token from session
    access_token = get_oidc_access_token(request)
    if not access_token:
        return HttpResponseForbidden("No valid access token available")
    
    # Make authenticated request to map service
    headers = {
        'Authorization': f'Bearer {access_token}',
        'User-Agent': request.META.get('HTTP_USER_AGENT', 'QLever-UI-Proxy/1.0'),
    }
    
    try:
        response = requests.get(map_url, headers=headers, timeout=30, stream=True)
        
        # Return the map service response
        django_response = HttpResponse(
            response.content,
            status=response.status_code,
            content_type=response.headers.get('content-type', 'text/html')
        )
        
        # Copy important headers
        for header_name in ['Content-Type', 'Cache-Control', 'Expires']:
            if header_name in response.headers:
                django_response[header_name] = response.headers[header_name]
        
        return django_response
        
    except requests.RequestException as e:
        return HttpResponseServerError(f"Error proxying map service: {str(e)}")
```

### Phase 3: Simple Frontend Integration

#### 3.1 Template Authentication UI
```html
<!-- backend/templates/index.html additions -->
<!-- Add to navbar area around line 36-48 -->
<div class="pull-right">
    {% if user.is_authenticated %}
        <span class="navbar-text">
            <i class="glyphicon glyphicon-user"></i> {{ user.username }}
        </span>
        <a href="{% url 'oidc_logout' %}" class="btn btn-default navbar-btn">
            <i class="glyphicon glyphicon-log-out"></i> Logout
        </a>
    {% else %}
        <a href="{% url 'oidc_authentication_init' %}" class="btn btn-primary navbar-btn">
            <i class="glyphicon glyphicon-log-in"></i> Login
        </a>
    {% endif %}
</div>
```

#### 3.2 SPARQL Request Authentication (Corrected)
```javascript
// backend/static/js/helper.js modifications
async function fetchQleverBackend(params, additionalHeaders = {}) {
    let response;
    
    // Get JWT token from Django session for SPARQL service authentication
    let headers = {
        Accept: "application/qlever-results+json",
        'X-CSRFToken': getCookie('csrftoken'),
        ...additionalHeaders
    };
    
    // Get JWT token for authenticated backends
    try {
        const tokenResponse = await fetch('/api/get-access-token/', {
            credentials: 'same-origin'
        });
        
        if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            headers['Authorization'] = `Bearer ${tokenData.access_token}`;
        } else if (tokenResponse.status === 401) {
            // User not authenticated, redirect to login
            window.location.href = '/oidc/authenticate/';
            throw new Error('Authentication required - redirecting to login');
        }
    } catch (error) {
        console.log('No token available, proceeding without auth');
    }
    
    try {
        response = await fetch(BASEURL, {
            method: "POST",
            body: new URLSearchParams(params),
            headers: headers,
            credentials: 'same-origin',
        });
        
        // Handle 401/403 - user needs to authenticate
        if (response.status === 401 || response.status === 403) {
            // Redirect to login
            window.location.href = '/oidc/authenticate/';
            throw new Error('Authentication required - redirecting to login');
        }
    } catch (error) {
        throw new Error(`Cannot reach ${BASEURL}. The most common cause is that the QLever server is down. Please try again later and contact us if the error persists`);
    }
    
    // ... rest of existing error handling
}

// Helper function to get CSRF token
function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}
```

### Phase 4: Map Button JWT Integration

#### 4.1 Browser Limitation: No Headers in New Tab URLs

**Problem**: Browsers cannot include custom headers when opening new tabs via URL navigation (`window.open()`, `<a href>`, etc.). This is a fundamental security limitation.

**Available Solutions**:

##### Option A: Django Server-Side Proxy (Recommended)
Django acts as a proxy server, fetching the map content with JWT authentication and serving it directly to the user.

```python
# backend/views.py - Add new view
import requests
import urllib.parse
from django.http import HttpResponse, HttpResponseForbidden, HttpResponseBadRequest, HttpResponseServerError

@csrf_exempt
def map_proxy(request):
    """Server-side proxy that fetches map content with JWT authentication"""
    if not request.user.is_authenticated:
        return HttpResponseForbidden("Authentication required")
    
    # Get the full map URL from the request parameter
    # URL format: /map?http://localhost:9090/?query=...&backend=...
    map_url = request.GET.get('url') or request.path_info.replace('/map?', '', 1)
    
    if not map_url:
        return HttpResponseBadRequest("Map URL parameter required")
    
    # Decode URL if it was encoded
    if map_url.startswith('http'):
        map_url = urllib.parse.unquote(map_url)
    
    # Get JWT token
    jwt_token = JWTTokenManager.get_user_jwt_token(request)
    if not jwt_token:
        return HttpResponseForbidden("No valid JWT token available")
    
    # Prepare headers for the request to map service
    headers = {
        'Authorization': f'Bearer {jwt_token}',
        'User-Agent': request.META.get('HTTP_USER_AGENT', 'QLever-UI-Proxy/1.0'),
        'Accept': request.META.get('HTTP_ACCEPT', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
        'Accept-Language': request.META.get('HTTP_ACCEPT_LANGUAGE', 'en-US,en;q=0.5'),
        'Accept-Encoding': 'gzip, deflate',
    }
    
    try:
        # Make authenticated request to map service
        response = requests.get(
            map_url, 
            headers=headers, 
            timeout=30,
            stream=True,  # Stream large responses
            allow_redirects=True
        )
        
        # Create Django response with map service content
        django_response = HttpResponse(
            response.content,
            status=response.status_code,
            content_type=response.headers.get('content-type', 'text/html')
        )
        
        # Copy important headers from map service response
        headers_to_copy = [
            'Content-Type', 'Content-Length', 'Cache-Control', 
            'Expires', 'Last-Modified', 'ETag', 'Vary'
        ]
        
        for header_name in headers_to_copy:
            if header_name in response.headers:
                django_response[header_name] = response.headers[header_name]
        
        # Handle cookies if map service sets them
        if 'Set-Cookie' in response.headers:
            django_response['Set-Cookie'] = response.headers['Set-Cookie']
        
        return django_response
        
    except requests.exceptions.Timeout:
        return HttpResponseServerError("Map service request timed out")
    except requests.exceptions.ConnectionError:
        return HttpResponseServerError("Could not connect to map service")
    except requests.exceptions.RequestException as e:
        return HttpResponseServerError(f"Error connecting to map service: {str(e)}")
```

**Enhanced version with streaming for large responses:**

```python
@csrf_exempt
def map_proxy_streaming(request):
    """Streaming proxy for large map responses"""
    if not request.user.is_authenticated:
        return HttpResponseForbidden("Authentication required")
    
    map_url = request.GET.get('url') or request.path_info.replace('/map?', '', 1)
    if not map_url:
        return HttpResponseBadRequest("Map URL parameter required")
    
    if map_url.startswith('http'):
        map_url = urllib.parse.unquote(map_url)
    
    jwt_token = JWTTokenManager.get_user_jwt_token(request)
    if not jwt_token:
        return HttpResponseForbidden("No valid JWT token available")
    
    headers = {
        'Authorization': f'Bearer {jwt_token}',
        'User-Agent': request.META.get('HTTP_USER_AGENT', 'QLever-UI-Proxy/1.0'),
    }
    
    try:
        # Stream the response
        response = requests.get(map_url, headers=headers, stream=True, timeout=30)
        
        # Create streaming response
        def generate():
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        
        django_response = HttpResponse(
            generate(),
            status=response.status_code,
            content_type=response.headers.get('content-type', 'text/html')
        )
        
        # Copy headers
        for header_name in ['Content-Type', 'Cache-Control', 'Expires']:
            if header_name in response.headers:
                django_response[header_name] = response.headers[header_name]
        
        return django_response
        
    except requests.RequestException as e:
        return HttpResponseServerError(f"Error proxying map service: {str(e)}")
```

##### Option B: Temporary Access Token Exchange
Generate a short-lived temporary token specifically for map access, reducing JWT exposure in URLs.

```python
# backend/models.py - Add model for temporary tokens
class MapToken(models.Model):
    token = models.CharField(max_length=64, unique=True)
    jwt_token = models.TextField()
    backend = models.ForeignKey(Backend, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used = models.BooleanField(default=False)
    
    class Meta:
        indexes = [
            models.Index(fields=['token', 'expires_at']),
        ]

# backend/views.py - Generate temporary token
@csrf_exempt
def generate_map_token(request):
    """Generate temporary token for map access"""
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Authentication required'}, status=401)
    
    backend_slug = request.POST.get('backend')
    backend = Backend.objects.filter(slug=backend_slug).first()
    
    if not backend:
        return JsonResponse({'error': 'Invalid backend'}, status=400)
    
    jwt_token = JWTTokenManager.get_user_jwt_token(request)
    if not jwt_token:
        return JsonResponse({'error': 'No JWT token available'}, status=400)
    
    # Generate temporary token (5 minute expiry)
    temp_token = secrets.token_urlsafe(32)
    expires_at = timezone.now() + timedelta(minutes=5)
    
    MapToken.objects.create(
        token=temp_token,
        jwt_token=jwt_token,
        backend=backend,
        expires_at=expires_at
    )
    
    return JsonResponse({'temp_token': temp_token})

@csrf_exempt
def map_proxy_with_temp_token(request):
    """Proxy map requests using temporary token"""
    backend_slug = request.GET.get('backend')
    query = request.GET.get('query')
    temp_token = request.GET.get('temp_token')
    
    if not temp_token:
        return HttpResponseBadRequest("Temporary token required")
    
    # Validate and consume temporary token
    map_token = MapToken.objects.filter(
        token=temp_token,
        expires_at__gt=timezone.now(),
        used=False
    ).first()
    
    if not map_token:
        return HttpResponseForbidden("Invalid or expired temporary token")
    
    # Mark token as used
    map_token.used = True
    map_token.save()
    
    # Build map URL with JWT token
    map_params = {
        'query': query,
        'backend': map_token.backend.baseUrl,
        'access_token': map_token.jwt_token
    }
    
    map_url = f"{map_token.backend.mapViewBaseURL}/?{urllib.parse.urlencode(map_params)}"
    return redirect(map_url)
```

##### Option C: PostMessage Communication (Advanced)
Open map in iframe or popup and use postMessage API to securely pass tokens.

```javascript
// backend/static/js/map-auth.js (new file)
class SecureMapOpener {
    static async openAuthenticatedMap(query, backend) {
        if (!window.authManager || !window.authManager.token) {
            throw new Error('Authentication required');
        }
        
        // Open map in popup
        const mapWindow = window.open('about:blank', 'mapView', 'width=1200,height=800');
        
        // Wait for map window to load, then send token via postMessage
        const mapUrl = `${MAP_VIEW_BASE_URL}/?query=${encodeURIComponent(query)}&backend=${encodeURIComponent(backend)}`;
        mapWindow.location.href = mapUrl;
        
        // Listen for ready message from map window
        window.addEventListener('message', (event) => {
            if (event.source === mapWindow && event.data.type === 'MAP_READY') {
                // Send JWT token securely
                mapWindow.postMessage({
                    type: 'AUTH_TOKEN',
                    token: window.authManager.token
                }, MAP_VIEW_BASE_URL);
            }
        });
    }
}
```

#### 4.2 Frontend Map Button Modifications

**Current Implementation** (around line 715-719 in `qleverUI.js`):
```javascript
// Current map button creates direct links to map service
if (result.res.length > 0 && /wktLiteral/.test(result.res[0][columns.length - 1])) {
    let mapViewUrlVanilla = 'http://qlever.cs.uni-freiburg.de/mapui/index.html?';
    let params = new URLSearchParams({query: normalizeQuery(query), backend: BASEURL});
    mapViewButtonVanilla = `<a class="btn btn-default" href="${mapViewUrlVanilla}${params}" target="_blank"><i class="glyphicon glyphicon-map-marker"></i> Map view</a>`;
    mapViewButtonPetri = `<a class="btn btn-default" href="${MAP_VIEW_BASE_URL}/?${params}" target="_blank"><i class="glyphicon glyphicon-map-marker"></i> Map view</a>`;
}
```

**Updated Implementation** with JWT authentication:
```javascript
// backend/static/js/qleverUI.js modifications
// Replace existing map button logic around line 715-719

if (result.res.length > 0 && /wktLiteral/.test(result.res[0][columns.length - 1])) {
    let mapViewButtonVanilla = '';
    let mapViewButtonPetri = '';
    
    // Check if backend requires authentication via Django template variable
    if ({{ backend_requires_auth|yesno:"true,false" }}) {
        // Authenticated: Route through Django proxy that adds JWT headers
        // Instead of: http://localhost:9090/?query=...&backend=...
        // Use: http://localhost:8177/map?query=...&backend=...
        
        const originalMapUrl = `${MAP_VIEW_BASE_URL}/?${new URLSearchParams({
            query: normalizeQuery(query), 
            backend: BASEURL
        })}`;
        
        // Encode the full map URL as a parameter to our Django proxy
        const proxyUrl = `/map?${encodeURIComponent(originalMapUrl)}`;
        
        mapViewButtonPetri = `<a class="btn btn-default" href="${proxyUrl}" target="_blank"><i class="glyphicon glyphicon-map-marker"></i> Map view</a>`;
    } else {
        // Non-authenticated fallback - direct links as before
        let mapViewUrlVanilla = 'http://qlever.cs.uni-freiburg.de/mapui/index.html?';
        let params = new URLSearchParams({query: normalizeQuery(query), backend: BASEURL});
        mapViewButtonVanilla = `<a class="btn btn-default" href="${mapViewUrlVanilla}${params}" target="_blank"><i class="glyphicon glyphicon-map-marker"></i> Map view</a>`;
        mapViewButtonPetri = `<a class="btn btn-default" href="${MAP_VIEW_BASE_URL}/?${params}" target="_blank"><i class="glyphicon glyphicon-map-marker"></i> Map view</a>`;
    }
}

// Option B: Helper function for temporary token approach
async function openMapWithTempToken(query, backend) {
    try {
        const response = await fetch('/api/generate-map-token/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: new URLSearchParams({
                backend: backend
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            const mapUrl = `/map-proxy-temp/?${new URLSearchParams({
                query: query,
                backend: backend,
                temp_token: data.temp_token
            })}`;
            window.open(mapUrl, '_blank', 'width=1200,height=800');

### Phase 4: Production Deployment
1. Configure production Keycloak
2. Set up proper SSL certificates
3. Configure environment variables
4. Deploy and test end-to-end

## Testing Strategy

### Unit Tests
- JWT token validation
- Authentication middleware
- Map token generation and validation

### Integration Tests
- OIDC authentication flow
- SPARQL requests with JWT headers
- Map button functionality with authentication

### Security Tests
- Token expiration handling
- Unauthorized access attempts
- Cross-origin security validation

## Backward Compatibility

The implementation maintains backward compatibility by:
- Making authentication optional per backend
- Preserving existing non-authenticated workflows
- Graceful degradation when tokens are unavailable
- Maintaining existing API contracts

## Future Enhancements

### 1. Role-Based Access Control
- Implement fine-grained permissions
- Backend-specific access controls
- Query-level authorization

### 2. Token Caching
- Implement client-side token caching
- Automatic background token refresh
- Offline capability considerations

### 3. Audit Logging
- Log authentication events
- Track SPARQL query access
- Monitor token usage patterns

## IMPLEMENTATION COMPLETED ✅

### Final Architecture Implemented

**Frontend OIDC Authentication** - Complete JavaScript-based OIDC client
- File: `backend/static/js/oidc-auth.js`
- PKCE security with SHA256/plain fallback
- JWT token storage in localStorage
- Automatic login redirect and callback handling

**Backend JWT Verification** - Django middleware for API protection
- File: `backend/middleware.py`
- RS256 signature verification using Keycloak JWKS
- Applied to all `/api/*` endpoints
- Proper 401/500 error responses

**Integration Points**
- SPARQL requests: JWT tokens in Authorization headers
- Map proxy: JWT tokens passed via URL parameters
- Authentication UI: Minimal navbar updates
- Callback handling: Dedicated `/auth/callback` endpoint

### Key Files Created/Modified

**New Files:**
- `backend/static/js/oidc-auth.js` - Frontend OIDC implementation
- `backend/templates/auth_callback.html` - OIDC callback page
- `backend/middleware.py` - JWT verification middleware
- `.env.example` - Configuration template
- `environment.yml` - Conda environment with PyJWT

**Modified Files:**
- `backend/static/js/helper.js` - JWT handling for SPARQL
- `backend/static/js/qleverUI.js` - JWT handling for maps
- `backend/templates/partials/head.html` - Include OIDC script
- `backend/views.py` - Auth callback and map proxy
- `backend/urls.py` - Auth routes
- `pyproject.toml` - PyJWT dependency

### Configuration

**Keycloak Client:**
- Client ID: `qlever-ui`
- Client Type: `public`
- Valid Redirect URIs: `http://host.docker.internal:8178/auth/callback`
- PKCE: Both S256 and plain methods supported

**Environment Variables:**
```env
KEYCLOAK_JWKS_URL=http://host.docker.internal:8085/realms/cardiffportal/protocol/openid-connect/certs
KEYCLOAK_ISSUER=http://host.docker.internal:8085/realms/cardiffportal
KEYCLOAK_AUDIENCE=qlever-ui
```

### Testing Results ✅

- [x] Authentication flow working end-to-end
- [x] JWT tokens properly stored and transmitted
- [x] SPARQL requests include authentication
- [x] Map proxy handles JWT tokens correctly
- [x] Error handling for invalid/missing tokens
- [x] PKCE security implementation with fallbacks
- [x] Docker networking compatibility

### Security Features

- **PKCE Implementation**: SHA256 code challenge with plain fallback
- **JWT Verification**: RS256 signature validation
- **Token Storage**: Secure localStorage management
- **Error Handling**: Proper 401 responses trigger re-authentication
- **Network Security**: Docker-compatible hostname resolution

## Conclusion

The Keycloak integration has been **SUCCESSFULLY COMPLETED** using a frontend-driven OIDC approach. The implementation provides secure authentication with JWT token verification while maintaining a clean architecture without Django session dependencies. All SPARQL and map functionality works correctly with authentication.