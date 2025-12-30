// src/middlewares/auth.js - API Key Authentication Middleware

const { getLogger } = require('../utils/Logger');
const { SECURITY_CONFIG } = require('../config/security');

const logger = getLogger();

/**
 * API Key Authentication Middleware
 * Validates API key from X-API-Key header or Authorization Bearer token
 */
const apiKeyAuth = (req, res, next) => {
  // Skip auth for health check and docs endpoints
  const publicPaths = ['/', '/api/docs', '/api/health'];
  if (publicPaths.includes(req.path)) {
    return next();
  }

  // Get API key from header
  const apiKey = req.headers['x-api-key'] || extractBearerToken(req.headers.authorization);

  if (!apiKey) {
    logger.warn(`Auth failed: No API key provided - ${req.ip} - ${req.path}`);
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'Please provide API key via X-API-Key header or Authorization: Bearer <key>'
    });
  }

  // Validate API key
  if (!isValidApiKey(apiKey)) {
    logger.warn(`Auth failed: Invalid API key - ${req.ip} - ${req.path}`);
    return res.status(403).json({
      success: false,
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  // Attach client info to request for logging/rate limiting
  req.apiClient = getClientInfo(apiKey);
  logger.debug(`Auth success: ${req.apiClient.name} - ${req.path}`);

  next();
};

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

/**
 * Validate API key against configured keys
 */
function isValidApiKey(apiKey) {
  const validKeys = SECURITY_CONFIG.API_KEYS;
  return validKeys.some(keyConfig => keyConfig.key === apiKey && keyConfig.enabled);
}

/**
 * Get client information from API key
 */
function getClientInfo(apiKey) {
  const keyConfig = SECURITY_CONFIG.API_KEYS.find(k => k.key === apiKey);
  return {
    name: keyConfig?.name || 'unknown',
    tier: keyConfig?.tier || 'standard',
    rateLimit: keyConfig?.rateLimit || SECURITY_CONFIG.DEFAULT_RATE_LIMIT
  };
}

/**
 * Optional: API Key auth that only warns but doesn't block (for migration period)
 */
const apiKeyAuthSoft = (req, res, next) => {
  const publicPaths = ['/', '/api/docs', '/api/health'];
  if (publicPaths.includes(req.path)) {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || extractBearerToken(req.headers.authorization);

  if (!apiKey) {
    // Debug level - don't spam logs in development (soft mode allows unauthenticated requests)
    logger.debug(`Auth: No API key - ${req.ip} - ${req.path} (soft mode)`);
    req.apiClient = { name: 'unauthenticated', tier: 'free', rateLimit: SECURITY_CONFIG.FREE_RATE_LIMIT };
  } else if (!isValidApiKey(apiKey)) {
    logger.debug(`Auth: Invalid API key - ${req.ip} - ${req.path} (soft mode)`);
    req.apiClient = { name: 'invalid-key', tier: 'free', rateLimit: SECURITY_CONFIG.FREE_RATE_LIMIT };
  } else {
    req.apiClient = getClientInfo(apiKey);
  }

  next();
};

module.exports = {
  apiKeyAuth,
  apiKeyAuthSoft
};
