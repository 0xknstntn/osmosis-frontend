import { Int } from "@keplr-wallet/unit";
import { estimateInitialTickBound } from "@osmosis-labs/math";
import {
  ConcentratedLiquidityPool,
  NextTickDepthsResponse,
  TickDataProvider,
} from "@osmosis-labs/pools";

import { ObservableQueryLiquiditiesNetInDirection } from "./liquidity-net-in-direction";

/** Hosts ObservableQueryLiquiditiesNetInDirection query store to manually make API calls and incrementally fetch and return ticks util no ticks are available.
 *
 *  **not observable**
 */
export class ConcentratedLiquidityPoolTickDataProvider
  implements TickDataProvider
{
  protected _oneForZeroBoundIndex: Int | undefined;
  protected _zeroForOneBoundIndex: Int | undefined;

  protected _triesPerDenomOutGivenIn = new Map<string, number>();
  protected _triesPerDenomInGivenOut = new Map<string, number>();

  constructor(
    protected readonly queryLiquiditiesNetInDirection: ObservableQueryLiquiditiesNetInDirection,
    protected readonly nextTicksRampMultiplier = new Int(2),
    protected readonly maxNumRequeriesPerDenom = 6
  ) {}

  async getNextTickDepthsTokenOutGivenIn(
    pool: ConcentratedLiquidityPool,
    tokenIn: {
      denom: string;
      amount: Int;
    }
  ): Promise<NextTickDepthsResponse> {
    const zeroForOne = pool.token0 === tokenIn.denom;

    // get the initial tick bound based on the input token
    const { boundTickIndex } = estimateInitialTickBound({
      specifiedToken: tokenIn,
      isOutGivenIn: true,
      token0Denom: pool.token0,
      currentSqrtPrice: pool.currentSqrtPrice,
      currentTickLiquidity: pool.currentTickLiquidity,
      exponentAtPriceOne: pool.exponentAtPriceOne,
    });

    console.log(
      "swapping in",
      tokenIn.denom,
      "initial bound tick",
      boundTickIndex.toString()
    );

    // return the next ticks
    const nextTicks = this.requestInDirectionWithInitialTickBound(
      pool,
      zeroForOne,
      boundTickIndex
    );

    if (
      incrementCounterMap(this._triesPerDenomOutGivenIn, tokenIn.denom) >
      this.maxNumRequeriesPerDenom
    ) {
      throw new Error(
        "Max tries exceeded for denom out given in: " + tokenIn.denom
      );
    }

    return nextTicks;
  }

  async getNextTickDepthsTokenInGivenOut(
    pool: ConcentratedLiquidityPool,
    tokenOut: {
      denom: string;
      amount: Int;
    }
  ): Promise<NextTickDepthsResponse> {
    const zeroForOne = pool.token0 !== tokenOut.denom;

    // get the initial tick bound based on the input token
    // convert token out to token in based on current price, since the bound tick is an estimate
    const { boundTickIndex } = estimateInitialTickBound({
      specifiedToken: tokenOut,
      isOutGivenIn: false,
      token0Denom: pool.token0,
      currentSqrtPrice: pool.currentSqrtPrice,
      currentTickLiquidity: pool.currentTickLiquidity,
      exponentAtPriceOne: pool.exponentAtPriceOne,
    });

    // return the next ticks
    const nextTicks = this.requestInDirectionWithInitialTickBound(
      pool,
      zeroForOne,
      boundTickIndex
    );

    if (
      incrementCounterMap(this._triesPerDenomInGivenOut, tokenOut.denom) >
      this.maxNumRequeriesPerDenom
    ) {
      throw new Error(
        "Max tries exceeded for denom in given out: " + tokenOut.denom
      );
    }

    return nextTicks;
  }

  /** Fetch and return **additional** ticks in the desired direction. Maintains state to determine which ticks have already been fetched. */
  protected async requestInDirectionWithInitialTickBound(
    pool: ConcentratedLiquidityPool,
    zeroForOne: boolean,
    initialBoundTick: Int
  ): Promise<NextTickDepthsResponse> {
    const queryDepths = this.queryLiquiditiesNetInDirection.getForPoolTokenIn(
      pool.id,
      pool.token0,
      pool.token1,
      zeroForOne,
      pool.exponentAtPriceOne,
      initialBoundTick // this is the initial bound tick index
    );

    // check if has fetched all ticks is true
    if (queryDepths.hasFetchedAllTicks) {
      console.warn("Pool", pool.id, "has fetched all ticks already");
      return {
        allTicks: queryDepths.depthsInDirection,
        isMaxTicks: true,
      };
    }

    // get the previous bound index used to fetch ticks
    const prevBoundIndex = zeroForOne
      ? this._zeroForOneBoundIndex
      : this._oneForZeroBoundIndex;

    const setLatestBoundTickIndex = (index: Int) => {
      if (zeroForOne) {
        this._zeroForOneBoundIndex = index;
      } else {
        this._oneForZeroBoundIndex = index;
      }
    };

    // we need to manage the fetch lifecycle for this query store manually,
    // since we may not be observing the query store directly through a mobx observer

    // haven't fetched ticks yet
    if (!prevBoundIndex) {
      console.log("fetching initial ticks");
      await queryDepths.waitResponse();
      setLatestBoundTickIndex(initialBoundTick);
    } else {
      // have fetched ticks, but should get more
      const nextBoundIndex = prevBoundIndex.mul(this.nextTicksRampMultiplier);
      await queryDepths.fetchUpToTickIndex(nextBoundIndex);
      console.log("setting new bound index to", nextBoundIndex.toString());
      setLatestBoundTickIndex(nextBoundIndex);
    }
    return {
      allTicks: queryDepths.depthsInDirection,
      isMaxTicks: queryDepths.hasFetchedAllTicks,
    };
  }
}

export function incrementCounterMap(map: Map<string, number>, key: string) {
  const prev = map.get(key) || 0;
  map.set(key, prev + 1);
  return prev + 1;
}
