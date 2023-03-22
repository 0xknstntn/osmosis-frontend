import { Coin, Dec, Int } from "@keplr-wallet/unit";

import { maxSpotPrice, minSpotPrice, smallestDec } from "./const";
import { TickOverflowError } from "./errors";
import { makeSwapStrategy } from "./swap-strategy";
import { sqrtPriceToTick, tickToSqrtPrice } from "./tick";
import { addLiquidity, approxSqrt } from "./utils";

export const ConcentratedLiquidityMath = {
  calcOutGivenIn,
  // calcInGivenOut,
  // calcSpotPrice,
};

interface SwapState {
  amountRemaining: Dec;
  amountCalculated: Dec;
  sqrtPrice: Dec;
  tick: Int;
  liquidity: Dec;
  feeGrowthGlobal: Dec;
}

function calcOutGivenIn(
  tokenIn: Coin,
  tokenDenom0: string,
  poolLiquidity: Dec,
  tickDepths: Int[],
  curTickIndex: number,
  curTick: Int,
  curSqrtPrice: Dec,
  precisionFactorAtPriceOne: number,
  swapFee: Dec,
  priceLimit = new Dec(0)
): Int {
  const tokenInAmountSpecified = new Dec(tokenIn.amount);

  const isZeroForOne = tokenIn.denom === tokenDenom0;
  if (isZeroForOne && priceLimit.equals(new Dec(0))) {
    priceLimit = minSpotPrice;
  } else if (!isZeroForOne && priceLimit.equals(new Dec(0))) {
    priceLimit = maxSpotPrice;
  }

  const sqrtPriceLimit = approxSqrt(priceLimit);

  const swapStrategy = makeSwapStrategy(isZeroForOne, sqrtPriceLimit, swapFee);

  const swapState: SwapState = {
    amountRemaining: tokenInAmountSpecified, // tokenIn
    amountCalculated: new Dec(0), // tokenOut
    sqrtPrice: curSqrtPrice,
    tick: swapStrategy.initTickValue(curTick),
    liquidity: poolLiquidity,
    feeGrowthGlobal: new Dec(0),
  };

  let sqrtPriceStart: Dec;
  let i = curTickIndex;
  while (
    swapState.amountRemaining.gt(smallestDec) &&
    !swapState.sqrtPrice.equals(sqrtPriceLimit)
  ) {
    sqrtPriceStart = swapState.sqrtPrice;

    const nextTick: Int | undefined = tickDepths?.[i]; // TODO: use iterator instead of array
    if (!nextTick) {
      throw new TickOverflowError("Not enough ticks to calculate swap");
    }

    const nextTickSqrtPrice = tickToSqrtPrice(
      nextTick,
      precisionFactorAtPriceOne
    );

    const sqrtPriceTarget = swapStrategy.getSqrtTargetPrice(nextTickSqrtPrice);

    const {
      sqrtPriceNext,
      amountInConsumed: amountOneIn,
      amountOutComputed: amountZeroOut,
      feeChargeTotal,
    } = swapStrategy.computeSwapStepOutGivenIn(
      swapState.sqrtPrice,
      sqrtPriceTarget,
      swapState.liquidity,
      swapState.amountRemaining
    );

    swapState.sqrtPrice = sqrtPriceNext;
    swapState.amountRemaining = swapState.amountRemaining.sub(
      amountOneIn.add(feeChargeTotal)
    );
    swapState.amountCalculated = swapState.amountCalculated.add(amountZeroOut);

    if (nextTickSqrtPrice.equals(sqrtPriceNext)) {
      const liquidityNet = swapStrategy.setLiquidityDeltaSign(
        new Dec(nextTick)
      );

      swapState.liquidity = addLiquidity(swapState.liquidity, liquidityNet);
    } else if (!sqrtPriceStart.equals(sqrtPriceNext)) {
      swapState.tick = sqrtPriceToTick(
        sqrtPriceNext,
        precisionFactorAtPriceOne
      );
    }

    i++;
  } // end while

  return swapState.amountCalculated.truncate();
}
