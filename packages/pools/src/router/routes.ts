import { Dec, Int } from "@keplr-wallet/unit";
import {
  getOsmoRoutedMultihopTotalSwapFee,
  isOsmoRoutedMultihop,
} from "@osmosis-labs/math";

import { NotEnoughLiquidityError } from "../errors";
import { NoRouteError } from "./errors";
import { cacheKeyForRoute, calculateWeightForRoute, Route } from "./route";
import {
  Quote,
  RoutablePool,
  RouteWithInAmount,
  SplitTokenInQuote,
  TokenOutGivenInRouter,
} from "./types";
import {
  cacheKeyForTokenOutGivenIn,
  invertRoute,
  validateRoutes,
} from "./utils";

export type OptimizedRoutesParams = {
  pools: ReadonlyArray<RoutablePool>;
  preferredPoolIds?: string[];
  incentivizedPoolIds: string[];
  stakeCurrencyMinDenom: string;
  getPoolTotalValueLocked: (poolId: string) => Dec;
  maxHops?: number;
  maxRoutes?: number;
};

/** Use to find routes and simulate swaps through routes.
 *
 *  Maintains a cache for routes and swaps for the lifetime of the instance.
 *  No filtering assumptions are made on provided pools, pools are routed as given.
 */
export class OptimizedRoutes implements TokenOutGivenInRouter {
  protected readonly _sortedPools: RoutablePool[];
  protected readonly _incentivizedPoolIds: string[];
  protected readonly _stakeCurrencyMinDenom: string;
  protected readonly _getPoolTotalValueLocked: (poolId: string) => Dec;
  protected readonly _maxHops: number;
  protected readonly _maxRoutes: number;

  // caches
  protected readonly _candidatePathsCache = new Map<string, Route[]>();
  protected readonly _calcOutAmtGivenInAmtCache = new Map<string, Quote>();
  protected readonly _calcRouteOutAmtGivenInAmtCache = new Map<string, Int>();

  constructor({
    pools,
    preferredPoolIds,
    incentivizedPoolIds,
    stakeCurrencyMinDenom,
    getPoolTotalValueLocked,
    maxHops = 4,
    maxRoutes = 4,
  }: OptimizedRoutesParams) {
    this._sortedPools = pools
      .slice()
      // Sort by the total value locked.
      .sort((a, b) => {
        const aTvl = getPoolTotalValueLocked(a.id);
        const bTvl = getPoolTotalValueLocked(b.id);
        return Number(aTvl.sub(bTvl).toString());
      })
      // lift preferred pools to the front
      .reduce((pools, pool) => {
        if (preferredPoolIds && preferredPoolIds.includes(pool.id)) {
          pools.unshift(pool);
        } else {
          pools.push(pool);
        }
        return pools;
      }, [] as RoutablePool[]);
    this._incentivizedPoolIds = incentivizedPoolIds;
    this._stakeCurrencyMinDenom = stakeCurrencyMinDenom;
    this._getPoolTotalValueLocked = getPoolTotalValueLocked;
    if (maxHops > 5) throw new Error("maxHops must be less than 5");
    this._maxHops = maxHops;
    if (maxRoutes > 10) throw new Error("maxRoutes must be less than 10");
    this._maxRoutes = maxRoutes;
  }

  /** Find optimal routes to split through for a given amount of token in and out token. */
  async getOptimizedRoutesByTokenIn(
    tokenIn: {
      denom: string;
      amount: Int;
    },
    tokenOutDenom: string
  ): Promise<RouteWithInAmount[]> {
    if (!tokenIn.amount.isPositive() || this._sortedPools.length === 0) {
      return [];
    }

    let routes = this.getCandidateRoutes(tokenIn.denom, tokenOutDenom);

    // find routes with swapped in/out tokens since getCandidateRoutes is a greedy algorithm
    const reverseRoutes = this.getCandidateRoutes(tokenOutDenom, tokenIn.denom);
    const invertedRoutes = reverseRoutes.map(invertRoute);
    routes = [...routes, ...invertedRoutes];

    if (routes.length === 0) {
      throw new NoRouteError();
    }

    // sort routes by weight
    const routeWeights = await Promise.all(
      routes.map((route) =>
        calculateWeightForRoute(route, this._getPoolTotalValueLocked)
      )
    );
    routes = routes.sort((path1, path2) => {
      const path1Index = routes.indexOf(path1);
      const path2Index = routes.indexOf(path2);
      const path1Weight = routeWeights[path1Index];
      const path2Weight = routeWeights[path2Index];

      return path1Weight.gte(path2Weight) ? -1 : 1;
    });

    // Is direct swap, but not enough liquidity
    if (routes.length > 1 && routes[0].pools.length === 1) {
      const directSwapLimit = await routes[0].pools[0].getLimitAmountByTokenIn(
        tokenIn.denom
      );
      if (directSwapLimit.lt(tokenIn.amount)) {
        routes = routes.slice(1); // remove direct swap route
      }
    }

    const top2Routes = routes.slice(0, 2);
    return await this.findBestSplitTokenIn(top2Routes, tokenIn.amount);
  }

  /** Calculate the amount of token out by simulating a swap through a route. */
  async calculateTokenOutByTokenIn(
    routes: RouteWithInAmount[]
  ): Promise<SplitTokenInQuote> {
    validateRoutes(routes);

    /** Tracks special case when routing through _only_ 2 OSMO pools for a single route. */
    const osmoFeeDiscountForRoute = new Array(routes.length).fill(false);

    let totalOutAmount: Int = new Int(0);
    let totalBeforeSpotPriceInOverOut: Dec = new Dec(0);
    let totalAfterSpotPriceInOverOut: Dec = new Dec(0);
    let totalEffectivePriceInOverOut: Dec = new Dec(0);
    let totalSwapFee: Dec = new Dec(0);

    const sumInitialAmount = routes.reduce(
      (sum, route) => sum.add(route.initialAmount),
      new Int(0)
    );

    if (sumInitialAmount.isZero()) {
      throw new Error("All initial amounts are zero");
    }

    for (const route of routes) {
      const amountFraction = route.initialAmount
        .toDec()
        .quoTruncate(sumInitialAmount.toDec());

      let previousInDenom = route.tokenInDenom;
      let previousInAmount = route.initialAmount;

      let beforeSpotPriceInOverOut: Dec = new Dec(1);
      let afterSpotPriceInOverOut: Dec = new Dec(1);
      let effectivePriceInOverOut: Dec = new Dec(1);
      let swapFee: Dec = new Dec(0);

      for (let i = 0; i < route.pools.length; i++) {
        const pool = route.pools[i];
        const outDenom = route.tokenOutDenoms[i];

        let poolSwapFee = pool.swapFee;
        if (
          isOsmoRoutedMultihop(
            route.pools.map(({ id }) => ({
              id,
              isIncentivized: this._incentivizedPoolIds.includes(id),
            })),
            route.tokenOutDenoms[0],
            this._stakeCurrencyMinDenom
          )
        ) {
          osmoFeeDiscountForRoute[routes.indexOf(route)] = true;
          const { maxSwapFee, swapFeeSum } = getOsmoRoutedMultihopTotalSwapFee(
            route.pools
          );
          poolSwapFee = maxSwapFee.mul(poolSwapFee.quo(swapFeeSum));
        }

        // calc out given in through pool, cached
        const calcOutGivenInParams = [
          { denom: previousInDenom, amount: previousInAmount },
          outDenom,
          poolSwapFee, // fee may be lesser
        ] as const;
        const outByInCacheKey = cacheKeyForTokenOutGivenIn(
          pool.id,
          ...calcOutGivenInParams
        );
        const cacheHit = this._calcOutAmtGivenInAmtCache.get(outByInCacheKey);
        let tokenOut;
        if (cacheHit) {
          tokenOut = cacheHit;
        } else {
          tokenOut = await pool.getTokenOutByTokenIn(...calcOutGivenInParams);
        }

        if (!tokenOut.amount.gt(new Int(0))) {
          // not enough liquidity
          return {
            ...tokenOut,
            tokenInFeeAmount: new Int(0),
            swapFee,
            split: routes.map((route) => ({
              ...route,
              multiHopOsmoDiscount: false,
            })),
          };
        }

        beforeSpotPriceInOverOut = beforeSpotPriceInOverOut.mulTruncate(
          tokenOut.beforeSpotPriceInOverOut
        );
        afterSpotPriceInOverOut = afterSpotPriceInOverOut.mulTruncate(
          tokenOut.afterSpotPriceInOverOut
        );
        effectivePriceInOverOut = effectivePriceInOverOut.mulTruncate(
          tokenOut.effectivePriceInOverOut
        );
        swapFee = swapFee.add(new Dec(1).sub(swapFee).mulTruncate(poolSwapFee));

        // is last pool
        if (i === route.pools.length - 1) {
          totalOutAmount = totalOutAmount.add(tokenOut.amount);

          totalBeforeSpotPriceInOverOut = totalBeforeSpotPriceInOverOut.add(
            beforeSpotPriceInOverOut.mulTruncate(amountFraction)
          );
          totalAfterSpotPriceInOverOut = totalAfterSpotPriceInOverOut.add(
            afterSpotPriceInOverOut.mulTruncate(amountFraction)
          );
          totalEffectivePriceInOverOut = totalEffectivePriceInOverOut.add(
            effectivePriceInOverOut.mulTruncate(amountFraction)
          );
          totalSwapFee = totalSwapFee.add(swapFee.mulTruncate(amountFraction));
        } else {
          previousInDenom = outDenom;
          previousInAmount = tokenOut.amount;
        }
      }
    }

    const priceImpactTokenOut = totalEffectivePriceInOverOut
      .quo(totalBeforeSpotPriceInOverOut)
      .sub(new Dec(1));

    return {
      split: routes
        .map((route, i) => ({
          ...route,
          multiHopOsmoDiscount: osmoFeeDiscountForRoute[i],
        }))
        .sort((a, b) =>
          Number(b.initialAmount.sub(a.initialAmount).toString())
        ),
      amount: totalOutAmount,
      beforeSpotPriceInOverOut: totalBeforeSpotPriceInOverOut,
      beforeSpotPriceOutOverIn: new Dec(1).quoTruncate(
        totalBeforeSpotPriceInOverOut
      ),
      afterSpotPriceInOverOut: totalAfterSpotPriceInOverOut,
      afterSpotPriceOutOverIn: new Dec(1).quoTruncate(
        totalAfterSpotPriceInOverOut
      ),
      effectivePriceInOverOut: totalEffectivePriceInOverOut,
      effectivePriceOutOverIn: new Dec(1).quoTruncate(
        totalEffectivePriceInOverOut
      ),
      tokenInFeeAmount: sumInitialAmount.sub(
        new Dec(sumInitialAmount)
          .mulTruncate(new Dec(1).sub(totalSwapFee))
          .round()
      ),
      swapFee: totalSwapFee,
      priceImpactTokenOut,
    };
  }

  /** Greedily find potential routes through pools without optimization. */
  protected getCandidateRoutes(
    tokenInDenom: string,
    tokenOutDenom: string
  ): Route[] {
    if (this._sortedPools.length === 0) {
      return [];
    }
    const cacheKey = `${tokenInDenom}/${tokenOutDenom}`;
    const cached = this._candidatePathsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const poolsUsed = Array<boolean>(this._sortedPools.length).fill(false);
    const routes: Route[] = [];

    const findRoutes = (
      tokenInDenom: string,
      tokenOutDenom: string,
      currentRoute: RoutablePool[],
      currentTokenOuts: string[],
      poolsUsed: boolean[],
      _previousTokenOuts?: string[]
    ) => {
      if (currentRoute.length > this._maxHops) return;

      if (
        currentRoute.length > 0 &&
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        currentRoute[currentRoute.length - 1]!.poolAssetDenoms.includes(
          tokenOutDenom
        )
      ) {
        const foundRoute: Route = {
          pools: currentRoute.slice(),
          tokenOutDenoms: [...currentTokenOuts, tokenOutDenom],
          tokenInDenom,
        };
        routes.push(foundRoute);
        return;
      }

      if (routes.length > this._maxRoutes) {
        // only find top routes by iterating all pools by high liquidity first
        return;
      }

      for (let i = 0; i < this._sortedPools.length; i++) {
        if (poolsUsed[i]) {
          continue; // skip pool
        }

        const previousTokenOuts = _previousTokenOuts
          ? _previousTokenOuts
          : [tokenInDenom]; // imaginary prev pool

        const curPool = this._sortedPools[i];

        let prevPoolCurPoolTokenMatch: string | undefined;
        curPool.poolAssetDenoms.forEach((denom) =>
          previousTokenOuts.forEach((d) => {
            if (d === denom) {
              prevPoolCurPoolTokenMatch = denom;
            }
          })
        );
        if (!prevPoolCurPoolTokenMatch) {
          continue; // skip pool
        }

        currentRoute.push(curPool);
        if (
          currentRoute.length > 1 &&
          prevPoolCurPoolTokenMatch !== tokenInDenom &&
          prevPoolCurPoolTokenMatch !== tokenOutDenom
        ) {
          currentTokenOuts.push(prevPoolCurPoolTokenMatch);
        }
        poolsUsed[i] = true;
        findRoutes(
          tokenInDenom,
          tokenOutDenom,
          currentRoute,
          currentTokenOuts,
          poolsUsed,
          curPool.poolAssetDenoms.filter(
            (denom) => denom !== prevPoolCurPoolTokenMatch
          )
        );
        poolsUsed[i] = false;
        currentTokenOuts.pop();
        currentRoute.pop();
      }
    };

    findRoutes(tokenInDenom, tokenOutDenom, [], [], poolsUsed);
    this._candidatePathsCache.set(cacheKey, routes);
    return routes.filter(({ pools }) => pools.length <= this._maxHops);
  }

  /**
   * This function performs a binary search to find a subset of candidate routes that yield an optimal split trade.
   * It takes into account the input token amount and the maximum number of iterations allowed.
   *
   * The time complexity of the splitRecursive function can be expressed as O(n * m), where:
   *   - n is the number of elements in sortedOptimalRoutes
   *   - m is the value of maxIterations
   *
   * @function findBestSplitTokenIn
   * @async
   * @param sortedOptimalRoutes An array of optimal routes for the split trade. Optimal: will attempt to include all routes in same split. Sorted: routes should be sorted by weight, best first since this is a greedy search.
   * @param tokenInAmount The amount of input tokens for the trade.
   * @param [maxIterations=100] The maximum number of iterations allowed for the binary search. Determines the granularity of the split, so higher is slower but more thorough.
   * @returns A promise that resolves to an array of routes with their corresponding input amounts, which form the optimal split trade.
   * @throws Throws an error if maxIterations is not greater than 0. Throws an error if there is not enough liquidity for the split trade.
   */
  protected async findBestSplitTokenIn(
    sortedOptimalRoutes: Route[],
    tokenInAmount: Int,
    maxIterations: number = 10
  ): Promise<RouteWithInAmount[]> {
    if (maxIterations <= 0) {
      throw new Error("maxIterations must be greater than 0");
    }

    if (sortedOptimalRoutes.length === 0) {
      return [];
    }
    // nothing to split
    if (sortedOptimalRoutes.length === 1) {
      return [
        {
          ...sortedOptimalRoutes[0],
          initialAmount: tokenInAmount,
        },
      ];
    }

    /** Only relevant to this search, track the out amount for this route of a certain in amount. */
    type RouteWithInAndOutAmount = RouteWithInAmount & { outAmount: Int };

    let bestSplit: RouteWithInAmount[] = [];
    let bestOutAmount = new Int(0);

    const splitRecursive = async (
      remainingInAmount: Int,
      remainingRoutes: RouteWithInAndOutAmount[],
      currentSplit: RouteWithInAndOutAmount[]
    ): Promise<void> => {
      // base case: once all routes have been accounted for, check if maximal case
      if (remainingRoutes.length === 0) {
        const totalOutAmount = currentSplit.reduce(
          (total, route) => total.add(route.outAmount),
          new Int(0)
        );
        if (totalOutAmount.gt(bestOutAmount)) {
          bestOutAmount = totalOutAmount;
          // deep copy to preserve optimal initial amounts and out amounts that would get mutated
          bestSplit = currentSplit.map((route) => ({
            ...route,
            initialAmount: new Int(route.initialAmount.toString()),
            outAmount: new Int(route.outAmount.toString()),
          }));
        }

        // unfurl recursion
        return;
      }

      // test routes with various splits: 0%, 10%, 20%, ..., 100%
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const route = remainingRoutes.shift()! as RouteWithInAndOutAmount;
      for (let i = 0; i <= maxIterations; i++) {
        const fraction = new Dec(i).quo(new Dec(maxIterations));
        const inAmount = new Dec(remainingInAmount).mul(fraction).truncate();
        if (inAmount.isZero()) continue; // skip this traversal (0 in not worth considering)

        route.initialAmount = inAmount;

        const cacheKey = cacheKeyForRoute(route);
        const cacheHit = this._calcRouteOutAmtGivenInAmtCache.get(cacheKey);
        let outAmount;
        if (cacheHit) {
          outAmount = cacheHit;
        } else {
          const { amount } = await this.calculateTokenOutByTokenIn([route]);
          this._calcRouteOutAmtGivenInAmtCache.set(cacheKey, amount);
          outAmount = amount;
        }

        if (outAmount.isZero()) continue; // skip this traversal and similar future attempted traversals (not enough liquidity)
        route.outAmount = outAmount;

        currentSplit.push(route);
        await splitRecursive(
          remainingInAmount.sub(inAmount),
          remainingRoutes,
          currentSplit
        );
        currentSplit.pop();
      }

      remainingRoutes.unshift(route);
    };

    // start with routes with 0 in and out amount, as we're looking for the sum max out amounts
    const zeroAmountRoutes = sortedOptimalRoutes.map((route) => ({
      ...route,
      initialAmount: new Int(0),
      outAmount: new Int(0),
    }));
    await splitRecursive(tokenInAmount, zeroAmountRoutes, []);

    // Not enough liquidity
    const totalLimitAmount = bestSplit.reduce(
      (acc, route) => acc.add(route.initialAmount),
      new Int(0)
    );
    if (totalLimitAmount.lt(tokenInAmount)) {
      throw new NotEnoughLiquidityError(
        `Entry pools' limit amount ${totalLimitAmount.toString()} is less than in amount ${tokenInAmount.toString()}`
      );
    }

    return bestSplit;
  }
}
