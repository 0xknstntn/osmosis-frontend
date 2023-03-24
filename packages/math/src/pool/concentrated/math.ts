import { Dec, Int } from "@keplr-wallet/unit";

import { smallestDec } from "./const";

export function calcAmount0Delta(
  liquidity: Dec,
  sqrtPriceA: Dec,
  sqrtPriceB: Dec,
  roundUp: boolean
): Dec {
  if (sqrtPriceA.gt(sqrtPriceB)) {
    [sqrtPriceA, sqrtPriceB] = [sqrtPriceB, sqrtPriceA];
  }
  const diff = sqrtPriceB.sub(sqrtPriceA);
  const denom = sqrtPriceA.mul(sqrtPriceB);

  if (roundUp) {
    return liquidity.mul(diff).quo(denom).roundUpDec();
  }
  return liquidity.mul(diff).quo(denom);
}

export function calcAmount1Delta(
  liquidity: Dec,
  sqrtPriceA: Dec,
  sqrtPriceB: Dec,
  roundUp: boolean
): Dec {
  if (sqrtPriceA.gt(sqrtPriceB)) {
    [sqrtPriceA, sqrtPriceB] = [sqrtPriceB, sqrtPriceA];
  }
  const diff = sqrtPriceB.sub(sqrtPriceA);

  if (roundUp) {
    return liquidity.mul(diff).roundUpDec();
  }
  return liquidity.mul(diff);
}

export function getNextSqrtPriceFromAmount0InRoundingUp(
  sqrtPriceCurrent: Dec,
  liquidity: Dec,
  amountRemaining: Dec
): Dec {
  if (amountRemaining.equals(new Dec(0))) {
    return sqrtPriceCurrent;
  }

  const product = amountRemaining.mul(sqrtPriceCurrent);
  const denom = liquidity.add(product);
  return liquidity.mul(sqrtPriceCurrent).quoRoundUp(denom);
}

export function getNextSqrtPriceFromAmount1InRoundingDown(
  sqrtPriceCurrent: Dec,
  liquidity: Dec,
  amountRemaining: Dec
): Dec {
  return sqrtPriceCurrent.add(amountRemaining.quoTruncate(liquidity));
}

export function getNextSqrtPriceFromAmount0OutRoundingUp(
  sqrtPriceCurrent: Dec,
  liquidity: Dec,
  amountRemaining: Dec
) {
  if (amountRemaining.equals(new Dec(0))) {
    return sqrtPriceCurrent;
  }

  const product = amountRemaining.mul(sqrtPriceCurrent);
  const denom = liquidity.sub(product);
  return liquidity.mul(sqrtPriceCurrent).quoRoundUp(denom);
}

export function getNextSqrtPriceFromAmount1OutRoundingDown(
  sqrtPriceCurrent: Dec,
  liquidity: Dec,
  amountRemaining: Dec
) {
  return sqrtPriceCurrent.sub(amountRemaining.quoRoundUp(liquidity));
}

export function getFeeChargePerSwapStepOutGivenIn(
  hasReachedTarget: boolean,
  amountIn: Dec,
  amountSpecifiedRemaining: Dec,
  swapFee: Dec
): Dec {
  let feeChargeTotal = new Dec(0);

  if (swapFee.isNegative()) {
    throw new Error("Swap fee should be non-negative");
  }

  if (swapFee.isZero()) {
    return feeChargeTotal;
  }

  if (hasReachedTarget) {
    feeChargeTotal = amountIn.mul(swapFee).quo(new Dec(1).sub(swapFee));
  } else {
    feeChargeTotal = amountSpecifiedRemaining.sub(amountIn);
  }

  if (feeChargeTotal.isNegative()) {
    throw new Error("Fee charge should be non-negative");
  }

  return feeChargeTotal;
}

export function approxSqrt(dec: Dec, maxIters = 300): Dec {
  return approxRoot(dec, 2, maxIters);
}

/** Approximate root using Newton's method.
 *
 * This function approximates the square root of a given decimal.
 * It uses Newton's method to approximate the square root.
 * It does this by iterating through the formula:
 * x_{n+1} = x_n - (x_n^2 - a) / (2 * x_n)
 * where x_0 is the initial approximation, a is the number whose
 * square root we want to find, and x_n is the current approximation.
 * The number of iterations is controlled by maxIters.
 *
 * TODO: move to decimal object see: https://github.com/chainapsis/keplr-wallet/pull/674
 */
export function approxRoot(dec: Dec, root: number, maxIters = 300): Dec {
  if (dec.isNegative()) {
    return approxRoot(dec.neg(), root).neg();
  }

  if (root === 1 || dec.isZero() || dec.equals(new Dec(1))) {
    return dec;
  }

  if (root === 0) {
    return new Dec(1);
  }

  let [guess, delta] = [new Dec(1), new Dec(1)];
  for (let i = 0; delta.abs().gt(smallestDec) && i < maxIters; i++) {
    let prev = guess.pow(new Int(root - 1));
    if (prev.isZero()) {
      prev = smallestDec;
    }
    delta = dec.quo(prev);
    delta = delta.sub(guess);
    delta = delta.quoTruncate(new Dec(root));

    guess = guess.add(delta);
  }

  return guess;
}

export function addLiquidity(a: Dec, b: Dec): Dec {
  if (b.lt(new Dec(0))) {
    return a.sub(b.abs());
  }
  return a.add(b);
}
