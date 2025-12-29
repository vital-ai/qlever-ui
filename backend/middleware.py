"""
JWT Authentication Middleware for Keycloak integration
"""
import jwt
import requests
from django.http import JsonResponse
from django.conf import settings
from django.utils.deprecation import MiddlewareMixin
import logging

logger = logging.getLogger(__name__)


class JWTAuthenticationMiddleware(MiddlewareMixin):
    """
    Middleware to verify JWT tokens from Keycloak for API endpoints
    """
    
    def __init__(self, get_response):
        self.get_response = get_response
        self.jwks_cache = None
        super().__init__(get_response)
    
    def process_request(self, request):
        # Only apply JWT verification to API endpoints
        if not request.path.startswith('/api/'):
            return None
            
        # Skip CSRF token for API endpoints with JWT
        if hasattr(request, '_dont_enforce_csrf_checks'):
            request._dont_enforce_csrf_checks = True
            
        # Get JWT token from Authorization header
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        if not auth_header.startswith('Bearer '):
            return JsonResponse({'error': 'Missing or invalid Authorization header'}, status=401)
            
        token = auth_header.split(' ')[1]
        
        try:
            # Verify JWT token
            decoded_token = self.verify_jwt_token(token)
            request.jwt_user = decoded_token
            return None
            
        except jwt.InvalidTokenError as e:
            logger.warning(f"Invalid JWT token: {e}")
            return JsonResponse({'error': 'Invalid JWT token'}, status=401)
        except Exception as e:
            logger.error(f"JWT verification error: {e}")
            return JsonResponse({'error': 'Authentication error'}, status=500)
    
    def verify_jwt_token(self, token):
        """
        Verify JWT token using Keycloak's JWKS endpoint
        """
        if not self.jwks_cache:
            self.jwks_cache = self.get_jwks()
            
        # Decode token header to get key ID
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get('kid')
        
        # Find the correct key
        key = None
        for jwk in self.jwks_cache.get('keys', []):
            if jwk.get('kid') == kid:
                key = jwt.algorithms.RSAAlgorithm.from_jwk(jwk)
                break
                
        if not key:
            raise jwt.InvalidKeyError('Unable to find a signing key that matches')
            
        # Verify and decode the token
        decoded_token = jwt.decode(
            token,
            key,
            algorithms=['RS256'],
            issuer=settings.KEYCLOAK_ISSUER,
            audience=settings.KEYCLOAK_AUDIENCE,
            options={"verify_exp": True}
        )
        
        return decoded_token
    
    def get_jwks(self):
        """
        Fetch JWKS from Keycloak
        """
        try:
            response = requests.get(settings.KEYCLOAK_JWKS_URL, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to fetch JWKS: {e}")
            raise jwt.InvalidKeyError('Unable to fetch JWKS')
