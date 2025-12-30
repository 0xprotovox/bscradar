// src/app.js - DATABASE-FREE VERSION WITH SECURITY

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const apiRoutes = require('./routes/apiRoutes');
const { getLogger } = require('./utils/Logger');
const { API_CONFIG } = require('./config/constants');
const { SECURITY_CONFIG } = require('./config/security');
const {
  apiKeyAuth,
  apiKeyAuthSoft,
  createCorsMiddleware,
  corsErrorHandler,
  priceValidationMiddleware,
  tokenRateLimitMiddleware
} = require('./middlewares');

class Application {
  constructor() {
    this.app = express();
    this.logger = getLogger();
    this.server = null;
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Compression - reduces response size by ~70%
    this.app.use(compression({
      level: 6, // Balance between speed and compression ratio
      threshold: 1024, // Only compress responses > 1KB
      filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
      }
    }));

    // Security middleware
    this.app.use(helmet());

    // CORS configuration - Restricted origins (P0 Critical #2)
    this.app.use(createCorsMiddleware());
    this.app.use(corsErrorHandler);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // IP-based Rate limiting (global)
    const limiter = rateLimit({
      windowMs: API_CONFIG.RATE_LIMIT_WINDOW || 60000,
      max: API_CONFIG.RATE_LIMIT_MAX_REQUESTS || 100,
      message: { success: false, error: 'Too many requests from this IP, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/api', limiter);

    // API Key Authentication (P0 Critical #1)
    // Use 'soft' mode during migration, 'strict' mode for production
    const authMiddleware = SECURITY_CONFIG.AUTH_MODE === 'strict' ? apiKeyAuth : apiKeyAuthSoft;
    this.app.use('/api', authMiddleware);

    // Token-based Rate Limiting (P0 Critical #4)
    this.app.use('/api', tokenRateLimitMiddleware);

    // Price Validation (P0 Critical #3)
    if (SECURITY_CONFIG.PRICE_VALIDATION?.ENABLED !== false) {
      this.app.use('/api', priceValidationMiddleware);
    }

    // Request logging with client info
    this.app.use((req, res, next) => {
      const clientInfo = req.apiClient ? ` [${req.apiClient.name}]` : '';
      this.logger.info(`${req.method} ${req.path}${clientInfo}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/', (req, res) => {
      res.json({ 
        status: 'healthy', 
        service: 'Pool Analyzer API',
        version: '2.0.0',
        mode: 'stateless',
        timestamp: new Date().toISOString() 
      });
    });

    // API routes
    this.app.use('/api', apiRoutes);
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found',
        path: req.path 
      });
    });

    // Global error handler
    this.app.use((err, req, res, next) => {
      this.logger.error('Server error:', err);
      
      res.status(err.status || 500).json({ 
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred processing your request'
      });
    });
  }

  start() {
    const PORT = API_CONFIG.PORT || 3000;
    this.server = this.app.listen(PORT, () => {
      this.logger.info(`🚀 Pool Analyzer API running on port ${PORT}`);
      this.logger.info(`📊 Stateless API Mode - No Database`);
      this.logger.info(`🔗 http://localhost:${PORT}`);
      this.logger.info(`📖 API Docs: http://localhost:${PORT}/api/docs`);
    });
    
    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        this.logger.info('Server stopped');
      });
    }
  }
}

module.exports = Application;