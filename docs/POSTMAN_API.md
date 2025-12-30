# API Endpoints - Postman Testing Guide

Base URL: `http://localhost:3000`

## GET Endpoints

### 1. Analyze Token
**Endpoint:** `GET /api/analyze/:token`

**Description:** Full token analysis with all pools, liquidity, and pricing

**Parameters:**
- Path: `:token` (BSC address) - Token to analyze
- Query: `refresh` (optional) - "true" or "false" (default: "false")

**Example Requests:**
```
GET http://localhost:3000/api/analyze/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
GET http://localhost:3000/api/analyze/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?refresh=true
```

---

### 2. Get Best Pool
**Endpoint:** `GET /api/best-pool/:token`

**Description:** Get the best pool for a token based on specified criteria

**Parameters:**
- Path: `:token` (BSC address) - Token address
- Query: `criteria` (optional) - Pool selection criteria
  - Options: `liquidity`, `price`, `fee`, `v2`, `v3`, `balanced`, `recommended`
  - Default: `recommended`
- Query: `basePair` (optional) - Filter by specific pair token address
- Query: `priceDirection` (optional) - "buy" or "sell" (default: "sell")
  - Only applies when `criteria=price`

**Example Requests:**
```
GET http://localhost:3000/api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
GET http://localhost:3000/api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=liquidity
GET http://localhost:3000/api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=price&priceDirection=buy
GET http://localhost:3000/api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?basePair=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
```

---

### 3. Get All Pools
**Endpoint:** `GET /api/pools/:token`

**Description:** Get all pools for a token with optional filtering

**Parameters:**
- Path: `:token` (BSC address) - Token address
- Query: `type` (optional) - Filter by pool type: "V2" or "V3"
- Query: `minLiquidity` (optional) - Minimum liquidity in USD (number)
- Query: `limit` (optional) - Maximum number of results (default: 20)

**Example Requests:**
```
GET http://localhost:3000/api/pools/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
GET http://localhost:3000/api/pools/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?type=V3
GET http://localhost:3000/api/pools/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?minLiquidity=10000
```

---

### 4. Find Pair Pools
**Endpoint:** `GET /api/pair/:tokenA/:tokenB`

**Description:** Find direct pools between two tokens

**Parameters:**
- Path: `:tokenA` (BSC address) - First token
- Path: `:tokenB` (BSC address) - Second token

**Example Requests:**
```
GET http://localhost:3000/api/pair/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
```

---

### 5. Health Check
**Endpoint:** `GET /api/health`

**Description:** Service health check with provider and cache status

**Example Request:**
```
GET http://localhost:3000/api/health
```

---

### 6. Get Token Prices
**Endpoint:** `GET /api/prices`

**Description:** Get known token prices from price oracle

**Example Request:**
```
GET http://localhost:3000/api/prices
```

---

### 7. Cache Statistics
**Endpoint:** `GET /api/cache/stats`

**Description:** Get cache statistics and cached items count

**Example Request:**
```
GET http://localhost:3000/api/cache/stats
```

---

### 8. API Documentation
**Endpoint:** `GET /api/docs`

**Description:** Get API documentation (JSON format)

**Example Request:**
```
GET http://localhost:3000/api/docs
```

---

## POST Endpoints

### 1. Get Swap Quote
**Endpoint:** `POST /api/quote`

**Description:** Get swap quote between two tokens with price impact and slippage

**Headers:**
```
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "tokenIn": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "tokenOut": "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  "amountIn": "1",
  "slippage": 0.5
}
```

**Parameters:**
- `tokenIn` (required) - Input token address
- `tokenOut` (required) - Output token address
- `amountIn` (required) - Amount to swap (in token units, not wei)
- `slippage` (optional) - Slippage tolerance percentage (default: 0.5)

---

### 2. Update Token Price
**Endpoint:** `POST /api/prices`

**Description:** Update a token price in the price oracle (for testing)

**Body (JSON):**
```json
{
  "token": "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  "price": 2.50
}
```

---

### 3. Clear Cache
**Endpoint:** `POST /api/cache/clear`

**Description:** Clear cache (all, pools, or prices)

**Body (JSON):**
```json
{
  "type": "all"
}
```

---

## Common BSC Network Tokens (for testing)

| Token | Address |
|-------|---------|
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |
| BUSD | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` |
| CAKE | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` |
| DAI | `0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3` |

---

## Criteria Explanation

### Pool Selection Criteria (`criteria` parameter)

- **liquidity**: Selects pool with highest USD liquidity (best for large swaps)
- **price**: Selects best execution price
  - With `priceDirection=buy`: Lowest price (best for buying token)
  - With `priceDirection=sell`: Highest price (best for selling token)
- **fee**: Selects pool with lowest fee tier
- **v2**: Best PancakeSwap V2 pool by liquidity
- **v3**: Best PancakeSwap V3 pool by liquidity
- **balanced**: Weighted scoring (liquidity 40pts + fee 30pts + version 10pts + price stability 20pts)
- **recommended**: Smart AI-driven selection (default)

---

## Response Format

All successful responses follow this structure:
```json
{
  "success": true,
  "data": { ... }
}
```

All error responses follow this structure:
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## Rate Limiting

Default configuration:
- Window: 60 seconds
- Max requests: 100 per window

---

## Tips for Postman Testing

1. **Environment Variables**: Create a Postman environment with:
   - `baseUrl` = `http://localhost:3000`
   - `testToken` = `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` (CAKE)
   - `wbnb` = `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`

2. **Collections**: Group endpoints by category:
   - Analysis (analyze, best-pool, pools)
   - Trading (quote, pair)
   - Utility (health, cache, prices)

3. **Tests**: Add test scripts to verify responses:
   ```javascript
   pm.test("Status code is 200", function () {
       pm.response.to.have.status(200);
   });

   pm.test("Response has success field", function () {
       var jsonData = pm.response.json();
       pm.expect(jsonData.success).to.eql(true);
   });
   ```
