// src/config/abis.js
// BscRadar - ABI definitions for PancakeSwap V2/V3 on BSC

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// PancakeSwap V2 (Uniswap V2 compatible)
const PANCAKESWAP_V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function allPairs(uint256) view returns (address)',
  'function allPairsLength() view returns (uint256)',
];

const PANCAKESWAP_V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function kLast() view returns (uint256)',
  'function price0CumulativeLast() view returns (uint256)',
  'function price1CumulativeLast() view returns (uint256)',
];

// PancakeSwap V3 (Uniswap V3 compatible)
const PANCAKESWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
];

const PANCAKESWAP_V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function maxLiquidityPerTick() view returns (uint128)',
];

const PANCAKESWAP_V3_QUOTER_V2_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];

module.exports = {
  ERC20_ABI,
  PANCAKESWAP_V2_FACTORY_ABI,
  PANCAKESWAP_V2_PAIR_ABI,
  PANCAKESWAP_V3_FACTORY_ABI,
  PANCAKESWAP_V3_POOL_ABI,
  PANCAKESWAP_V3_QUOTER_V2_ABI,
  MULTICALL3_ABI,
  // Aliases for backward compatibility
  UNISWAP_V2_FACTORY_ABI: PANCAKESWAP_V2_FACTORY_ABI,
  UNISWAP_V2_PAIR_ABI: PANCAKESWAP_V2_PAIR_ABI,
  UNISWAP_V3_FACTORY_ABI: PANCAKESWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI: PANCAKESWAP_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI: PANCAKESWAP_V3_QUOTER_V2_ABI,
};
