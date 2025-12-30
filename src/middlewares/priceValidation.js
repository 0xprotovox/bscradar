// src/middlewares/priceValidation.js - Price Sanity Validation

const { getLogger } = require('../utils/Logger');
const { SECURITY_CONFIG } = require('../config/security');

const logger = getLogger();

/**
 * Price sanity validation for pool analysis results
 * Filters out outliers and validates prices against known patterns
 */
class PriceValidator {
  constructor() {
    this.priceHistory = new Map(); // token -> recent prices
    this.maxHistorySize = 100;
  }

  /**
   * Validate price from pool analysis
   * @param {string} tokenAddress - Token being analyzed
   * @param {number} price - Price to validate
   * @param {Array} allPoolPrices - All prices from different pools
   * @returns {object} Validation result
   */
  validatePrice(tokenAddress, price, allPoolPrices = []) {
    const validation = {
      isValid: true,
      confidence: 1.0,
      warnings: [],
      adjustedPrice: price
    };

    // Check 1: Price is positive and finite
    if (!price || !isFinite(price) || price <= 0) {
      validation.isValid = false;
      validation.confidence = 0;
      validation.warnings.push('Invalid price value');
      return validation;
    }

    // Check 2: Outlier detection using median absolute deviation
    if (allPoolPrices.length >= 2) {
      const outlierResult = this.detectOutlier(price, allPoolPrices);
      if (outlierResult.isOutlier) {
        validation.warnings.push(`Price may be outlier: ${outlierResult.deviation.toFixed(2)}x from median`);
        validation.confidence *= 0.5;
        validation.adjustedPrice = outlierResult.medianPrice;
      }
    }

    // Check 3: Compare with historical prices for sudden spikes
    const historicalCheck = this.checkHistoricalDeviation(tokenAddress, price);
    if (historicalCheck.hasAnomaly) {
      validation.warnings.push(historicalCheck.message);
      validation.confidence *= 0.7;
    }

    // Check 4: Extreme price check (likely manipulation or error)
    if (price > SECURITY_CONFIG.PRICE_VALIDATION.MAX_PRICE_USD) {
      validation.warnings.push(`Extremely high price: $${price.toLocaleString()}`);
      validation.confidence *= 0.3;
    }
    if (price < SECURITY_CONFIG.PRICE_VALIDATION.MIN_PRICE_USD) {
      validation.warnings.push(`Extremely low price: $${price.toExponential(2)}`);
      validation.confidence *= 0.8; // Low prices are more common for new tokens
    }

    // Store price in history
    this.addToHistory(tokenAddress, price);

    // Set validity based on confidence
    validation.isValid = validation.confidence >= SECURITY_CONFIG.PRICE_VALIDATION.MIN_CONFIDENCE;

    return validation;
  }

  /**
   * Detect if price is an outlier using MAD (Median Absolute Deviation)
   */
  detectOutlier(price, allPrices) {
    const sorted = [...allPrices].sort((a, b) => a - b);
    const medianPrice = this.getMedian(sorted);

    // Calculate MAD
    const deviations = sorted.map(p => Math.abs(p - medianPrice));
    const mad = this.getMedian(deviations.sort((a, b) => a - b));

    // Modified Z-score
    const modifiedZScore = mad === 0 ? 0 : 0.6745 * (price - medianPrice) / mad;
    const deviation = medianPrice > 0 ? Math.abs(price - medianPrice) / medianPrice : 0;

    return {
      isOutlier: Math.abs(modifiedZScore) > 3.5 || deviation > 0.5, // 50% deviation threshold
      deviation: deviation,
      medianPrice: medianPrice,
      modifiedZScore: modifiedZScore
    };
  }

  /**
   * Check for sudden price spikes compared to history
   */
  checkHistoricalDeviation(tokenAddress, currentPrice) {
    const history = this.priceHistory.get(tokenAddress.toLowerCase());
    if (!history || history.length < 3) {
      return { hasAnomaly: false };
    }

    const recentPrices = history.slice(-10);
    const avgPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const deviation = Math.abs(currentPrice - avgPrice) / avgPrice;

    // Flag if price changed more than 100% from recent average
    if (deviation > 1.0) {
      return {
        hasAnomaly: true,
        message: `Price changed ${(deviation * 100).toFixed(0)}% from recent average`
      };
    }

    return { hasAnomaly: false };
  }

  /**
   * Add price to history
   */
  addToHistory(tokenAddress, price) {
    const key = tokenAddress.toLowerCase();
    if (!this.priceHistory.has(key)) {
      this.priceHistory.set(key, []);
    }

    const history = this.priceHistory.get(key);
    history.push(price);

    // Keep only recent prices
    if (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * Get median of sorted array
   */
  getMedian(sorted) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Clear history (for testing or memory management)
   */
  clearHistory() {
    this.priceHistory.clear();
  }
}

// Singleton instance
const priceValidator = new PriceValidator();

/**
 * Express middleware for validating prices in response
 */
const priceValidationMiddleware = (req, res, next) => {
  // Store original json method
  const originalJson = res.json.bind(res);

  res.json = (data) => {
    try {
      // Only validate analyze responses with valid data
      if (req.path.includes('/analyze') && data?.success && data?.data?.bestPools?.recommended) {
        const recommended = data.data.bestPools.recommended;

        // Collect all prices for outlier detection - handle various pool structures
        const allPrices = [];
        if (data.data.pools) {
          // Handle both array and object pool structures
          const poolsData = data.data.pools;
          if (Array.isArray(poolsData)) {
            poolsData.forEach(pool => {
              if (pool?.priceUSD > 0) allPrices.push(pool.priceUSD);
            });
          } else if (typeof poolsData === 'object') {
            Object.values(poolsData).forEach(poolGroup => {
              if (Array.isArray(poolGroup)) {
                poolGroup.forEach(pool => {
                  if (pool?.priceUSD > 0) allPrices.push(pool.priceUSD);
                });
              } else if (poolGroup?.priceUSD > 0) {
                allPrices.push(poolGroup.priceUSD);
              }
            });
          }
        }

        // Validate recommended price if available
        if (recommended?.priceUSD) {
          const tokenAddr = req.params?.token || req.body?.tokenAddress || req.query?.token || 'unknown';
          const validation = priceValidator.validatePrice(
            tokenAddr,
            recommended.priceUSD,
            allPrices
          );

          // Add validation info to response
          data.data.priceValidation = {
            confidence: validation.confidence,
            warnings: validation.warnings,
            isValidated: validation.isValid
          };

          // Log warnings
          if (validation.warnings.length > 0) {
            logger.warn(`Price validation warnings for ${req.path}:`, validation.warnings);
          }
        }
      }
    } catch (err) {
      // Don't fail the request if validation has an error, just log it
      logger.error('Price validation middleware error:', err.message);
    }

    return originalJson(data);
  };

  next();
};

module.exports = {
  PriceValidator,
  priceValidator,
  priceValidationMiddleware
};
