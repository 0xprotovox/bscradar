// src/middlewares/corsConfig.js - CORS Configuration

const cors = require('cors');
const { SECURITY_CONFIG } = require('../config/security');
const { getLogger } = require('../utils/Logger');

const logger = getLogger();

/**
 * Create CORS middleware with restricted origins
 */
const createCorsMiddleware = () => {
  const allowedOrigins = SECURITY_CONFIG.ALLOWED_ORIGINS;

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }

      // Check for wildcard subdomain patterns (e.g., *.bscradar.io)
      // Also allow local network IPs (192.168.x.x, 10.x.x.x, etc.)
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed.startsWith('*.')) {
          const domain = allowed.slice(2);
          return origin.endsWith(domain) || origin.endsWith('.' + domain);
        }
        return false;
      });

      // Allow any local network origin for development
      const isLocalNetwork = /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(origin);
      if (isLocalNetwork) {
        return callback(null, true);
      }

      if (isAllowed) {
        return callback(null, true);
      }

      logger.warn(`CORS blocked: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: true,
    maxAge: 86400 // Cache preflight for 24 hours
  });
};

/**
 * CORS error handler
 */
const corsErrorHandler = (err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'CORS error',
      message: 'Origin not allowed'
    });
  }
  next(err);
};

module.exports = {
  createCorsMiddleware,
  corsErrorHandler
};
