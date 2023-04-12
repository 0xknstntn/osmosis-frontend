import { Dec, DecUtils, Int } from "@keplr-wallet/unit";

import { BigDec } from "../../big-dec";
import {
  exponentAtPriceOneMax,
  exponentAtPriceOneMin,
  maxSpotPrice,
  minSpotPrice,
} from "./const";
import { approxSqrt } from "./math";
const nine = new Dec(9);

// Ref: https://github.com/osmosis-labs/osmosis/blob/main/x/concentrated-liquidity/README.md#tick-spacing-example-tick-to-price
// chain: https://github.com/osmosis-labs/osmosis/blob/e7b5c4a6f88004fe8a6976fd7e4cb5e90339d629/x/concentrated-liquidity/internal/math/tick.go#L39
/** TickToSqrtPrice returns the sqrtPrice given the following two arguments:
    - tickIndex: the tick index to calculate the price for
    - exponentAtPriceOne: the value of the exponent (and therefore the precision) at which the starting price of 1 is set

    If tickIndex is zero, the function returns new Dec(1).
 */
export function tickToSqrtPrice(
  tickIndex: Int,
  exponentAtPriceOne: number
): Dec {
  if (tickIndex.isZero()) {
    return new Dec(1);
  }

  if (
    new Int(exponentAtPriceOne).gt(exponentAtPriceOneMax) ||
    new Int(exponentAtPriceOne).lt(exponentAtPriceOneMin)
  ) {
    throw new Error(
      `exponentAtPriceOne is out of range: ${exponentAtPriceOne.toString()}`
    );
  }

  const geometricExponentIncrementDistanceInTicks = nine.mul(
    DecUtils.getTenExponentN(-exponentAtPriceOne)
  );

  const { minTick, maxTick } =
    computeMinMaxTicksFromExponentAtPriceOne(exponentAtPriceOne);
  if (tickIndex.lt(minTick) || tickIndex.gt(maxTick)) {
    throw new Error(
      `tickIndex is out of range: ${tickIndex.toString()}, min: ${minTick.toString()}, max: ${maxTick.toString()}`
    );
  }

  const geometricExponentDelta = new Dec(tickIndex)
    .quoTruncate(new Dec(geometricExponentIncrementDistanceInTicks.truncate()))
    .truncate();

  let exponentAtCurTick = new Int(exponentAtPriceOne).add(
    geometricExponentDelta
  );
  if (tickIndex.lt(new Int(0))) {
    exponentAtCurTick = exponentAtCurTick.sub(new Int(1));
  }

  const currentAdditiveIncrementInTicks = DecUtils.getTenExponentN(
    Number(exponentAtCurTick.toString())
  );

  const numAdditiveTicks = tickIndex.sub(
    geometricExponentDelta.mul(
      geometricExponentIncrementDistanceInTicks.truncate()
    )
  );

  const price = new BigDec(
    DecUtils.getTenExponentN(Number(geometricExponentDelta.toString()))
  )
    .add(
      new BigDec(numAdditiveTicks).mul(
        new BigDec(currentAdditiveIncrementInTicks)
      )
    )
    .toDec();

  if (price.gt(maxSpotPrice) || price.lt(minSpotPrice)) {
    throw new Error(
      `price is out of range: ${price.toString()}, min: ${minSpotPrice.toString()}, max: ${maxSpotPrice.toString()}`
    );
  }

  return approxSqrt(price);
}

/** PriceToTick takes a price and returns the corresponding tick index */
export function priceToTick(price: Dec, exponentAtPriceOne: number): Int {
  if (price.equals(new Dec(1))) {
    return new Int(0);
  }
  if (price.isNegative()) throw new Error("Price is negative");
  if (price.gt(maxSpotPrice) || price.lt(minSpotPrice))
    throw new Error("Price not within bounds");
  if (
    new Int(exponentAtPriceOne).gt(exponentAtPriceOneMax) ||
    new Int(exponentAtPriceOne).lt(exponentAtPriceOneMin)
  )
    throw new Error("Exponent at price one not within bounds");

  const { currentPrice, ticksPassed, currentAdditiveIncrementInTicks } =
    calculatePriceAndTicksPassed(price, exponentAtPriceOne);

  const ticksToBeFilledByExponentAtCurrentTick = new BigDec(
    price.sub(currentPrice)
  ).quo(currentAdditiveIncrementInTicks);

  const tickIndex = ticksPassed.add(
    ticksToBeFilledByExponentAtCurrentTick.toDec().truncate()
  );

  const { minTick, maxTick } =
    computeMinMaxTicksFromExponentAtPriceOne(exponentAtPriceOne);
  if (tickIndex.lt(minTick) || tickIndex.gt(maxTick))
    throw new Error("Tick index not within bounds");

  return tickIndex;
}

export function computeMinMaxTicksFromExponentAtPriceOne(
  exponentAtPriceOne: number
): {
  minTick: Int;
  maxTick: Int;
} {
  const geometricExponentIncrementDistanceInTicks = new Dec(9).mul(
    new Dec(10).pow(new Int(exponentAtPriceOne).neg())
  );
  return {
    minTick: new Dec(18)
      .mul(geometricExponentIncrementDistanceInTicks)
      .neg()
      .round(),
    maxTick: new Dec(38)
      .mul(geometricExponentIncrementDistanceInTicks)
      .truncate(),
  };
}

/** The function uses the geometricExponentIncrementDistanceInTicks formula to determine the number of ticks passed and the current additive increment in ticks.
    If the price is greater than 1, the function increments the exponentAtCurrentTick until the currentPrice is greater than the input price.
    If the price is less than 1, the function decrements the exponentAtCurrentTick until the currentPrice is less than the input price.
 */
export function calculatePriceAndTicksPassed(
  price: Dec,
  exponentAtPriceOne: number
): {
  currentPrice: Dec;
  ticksPassed: Int;
  currentAdditiveIncrementInTicks: BigDec;
} {
  const geometricExponentIncrementDistanceInTicks = nine.mul(
    DecUtils.getTenExponentN(-exponentAtPriceOne)
  );

  let currentPrice = new Dec(1);
  let ticksPassed = new Int(0);
  let exponentAtCurTick = new Int(exponentAtPriceOne);

  let currentAdditiveIncrementInTicks = powTenBigDec(
    new Int(exponentAtPriceOne)
  );

  if (price.gt(new Dec(1))) {
    while (currentPrice.lt(price)) {
      currentAdditiveIncrementInTicks = powTenBigDec(exponentAtCurTick);
      const maxPriceForCurrentAdditiveIncrementInTicks = new BigDec(
        geometricExponentIncrementDistanceInTicks
      ).mul(currentAdditiveIncrementInTicks);
      currentPrice = currentPrice.add(
        maxPriceForCurrentAdditiveIncrementInTicks.toDec()
      );
      exponentAtCurTick = exponentAtCurTick.add(new Int(1));
      ticksPassed = ticksPassed.add(
        geometricExponentIncrementDistanceInTicks.truncate()
      );
    }
  } else {
    exponentAtCurTick = new Int(exponentAtPriceOne).sub(new Int(1));
    while (currentPrice.gt(price)) {
      currentAdditiveIncrementInTicks = powTenBigDec(exponentAtCurTick);
      const maxPriceForCurrentAdditiveIncrementInTicks = new BigDec(
        geometricExponentIncrementDistanceInTicks
      ).mul(currentAdditiveIncrementInTicks);
      currentPrice = currentPrice.sub(
        maxPriceForCurrentAdditiveIncrementInTicks.toDec()
      );
      exponentAtCurTick = exponentAtCurTick.sub(new Int(1));
      ticksPassed = ticksPassed.sub(
        geometricExponentIncrementDistanceInTicks.truncate()
      );
    }
  }
  return { currentPrice, ticksPassed, currentAdditiveIncrementInTicks };
}

/** Provides a method of estimating the initial first tick index bound for querying ticks efficiently (not requesting too many ticks).
 *  Is positive or negative depending on which token is being swapped in.
 */
export function estimateInitialTickBounds({
  tokenIn,
  token0Denom,
  currentSqrtPrice,
  currentTickLiquidity,
  exponentAtPriceOne,
}: {
  tokenIn: {
    denom: string;
    amount: Int;
  };
  token0Denom: string;
  currentSqrtPrice: Dec;
  currentTickLiquidity: Dec;
  exponentAtPriceOne: number;
}): { boundTickIndex: Int } {
  const isZeroForOne = tokenIn.denom === token0Denom;

  // get target sqrt price from amount in and tick liquidity
  let sqrtPriceTarget: Dec;
  if (isZeroForOne) {
    const estimate = currentSqrtPrice.sub(
      currentTickLiquidity.quo(new Dec(tokenIn.amount))
    );
    sqrtPriceTarget = estimate.gt(minSpotPrice) ? estimate : minSpotPrice;
  } else {
    const estimate = currentSqrtPrice.add(
      new Dec(tokenIn.amount).quo(currentTickLiquidity)
    );
    sqrtPriceTarget = estimate.lt(maxSpotPrice) ? estimate : maxSpotPrice;
  }

  const price = sqrtPriceTarget.pow(new Int(2));

  return {
    boundTickIndex: priceToTick(price, exponentAtPriceOne),
  };
}

// TODO: consider moving
function powTenBigDec(exponent: Int): BigDec {
  if (exponent.gte(new Int(0))) {
    return new BigDec(10).pow(exponent);
  }
  return new BigDec(1).quo(new BigDec(10).pow(exponent.abs()));
}
