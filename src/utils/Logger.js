// src/utils/Logger.js

const winston = require('winston');
const path = require('path');
const fs = require('fs');

class Logger {
  constructor() {
    // Create logs directory if it doesn't exist
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }

    // Configure winston logger
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'pool-analyzer' },
      transports: [
        // Console transport
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        }),
        // File transport for all logs
        new winston.transports.File({
          filename: path.join(logsDir, 'app.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
        // File transport for errors only
        new winston.transports.File({
          filename: path.join(logsDir, 'error.log'),
          level: 'error',
          maxsize: 5242880,
          maxFiles: 5,
        }),
      ],
    });
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  error(message, error = null, meta = {}) {
    if (error instanceof Error) {
      this.logger.error(message, { ...meta, error: error.message, stack: error.stack });
    } else {
      this.logger.error(message, meta);
    }
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  http(message, meta = {}) {
    this.logger.http(message, meta);
  }
}

// Singleton instance
let loggerInstance = null;

module.exports = {
  getLogger: () => {
    if (!loggerInstance) {
      loggerInstance = new Logger();
    }
    return loggerInstance;
  },
};