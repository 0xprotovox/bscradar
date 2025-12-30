// src/middlewares/index.js - Export all middlewares

const { apiKeyAuth, apiKeyAuthSoft } = require('./auth');
const { createCorsMiddleware, corsErrorHandler } = require('./corsConfig');
const { priceValidationMiddleware, priceValidator } = require('./priceValidation');
const { tokenRateLimitMiddleware, tokenRateLimiter } = require('./tokenRateLimit');

module.exports = {
  // Authentication
  apiKeyAuth,
  apiKeyAuthSoft,

  // CORS
  createCorsMiddleware,
  corsErrorHandler,

  // Price Validation
  priceValidationMiddleware,
  priceValidator,

  // Token Rate Limiting
  tokenRateLimitMiddleware,
  tokenRateLimiter
};
