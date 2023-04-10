import { AmountConfig, IFeeConfig } from "@keplr-wallet/hooks";
import { ChainGetter, IQueriesStore } from "@keplr-wallet/stores";
import { AppCurrency } from "@keplr-wallet/types";
import {
  CoinPretty,
  Dec,
  DecUtils,
  Int,
  IntPretty,
  RatePretty,
} from "@keplr-wallet/unit";
import {
  MultihopSwapResult,
  NotEnoughLiquidityError,
  OptimizedRoutes,
  RouteWithAmount,
} from "@osmosis-labs/pools";
import { debounce } from "debounce";
import {
  action,
  autorun,
  computed,
  makeObservable,
  observable,
  override,
  runInAction,
} from "mobx";
import { fromPromise, IPromiseBasedObservable } from "mobx-utils";
import { IPriceStore } from "src/price";

import { ObservableQueryPool, OsmosisQueries } from "../queries";
import {
  InsufficientBalanceError,
  NoRouteError,
  NoSendCurrencyError,
} from "./errors";

type PrettyMultihopSwapResult = {
  amount: CoinPretty;
  beforeSpotPriceWithoutSwapFeeInOverOut: IntPretty;
  beforeSpotPriceWithoutSwapFeeOutOverIn: IntPretty;
  beforeSpotPriceInOverOut: IntPretty;
  beforeSpotPriceOutOverIn: IntPretty;
  afterSpotPriceInOverOut: IntPretty;
  afterSpotPriceOutOverIn: IntPretty;
  effectivePriceInOverOut: IntPretty;
  effectivePriceOutOverIn: IntPretty;
  tokenInFeeAmount: CoinPretty;
  swapFee: RatePretty;
  priceImpact: RatePretty;
  isMultihopOsmoFeeDiscount: boolean;
};

export class ObservableTradeTokenInConfig extends AmountConfig {
  @observable.ref
  protected _pools: ObservableQueryPool[];
  @observable
  protected _incentivizedPoolIds: string[] = [];

  @observable
  protected _sendCurrencyMinDenom: string | undefined = undefined;
  @observable
  protected _outCurrencyMinDenom: string | undefined = undefined;

  // must match AmountConfig.error
  @observable
  protected _error: Error | undefined = undefined;
  @observable
  protected _notEnoughLiquidity: boolean = false;

  @observable.ref
  protected _latestSwapResult:
    | IPromiseBasedObservable<MultihopSwapResult>
    | undefined = undefined;
  @observable.ref
  protected _spotPriceResult:
    | IPromiseBasedObservable<MultihopSwapResult>
    | undefined = undefined;

  @override
  get sendCurrency(): AppCurrency {
    if (this.sendableCurrencies.length === 0) {
      // For the case before pools are initially fetched,

      return this.initialSelectCurrencies.send;
    }

    if (this._sendCurrencyMinDenom) {
      const currency = this.currencyMap.get(this._sendCurrencyMinDenom);
      if (currency) {
        return currency;
      }
    }

    const initialSendCurrency = this.sendableCurrencies.find(
      (c) => c.coinDenom === this.initialSelectCurrencies.send.coinDenom
    );
    const initialCurrency =
      initialSendCurrency &&
      this.sendableCurrencies.find(
        (c) => c.coinDenom === this.initialSelectCurrencies.out.coinDenom
      )
        ? initialSendCurrency
        : undefined;

    return initialCurrency ?? this.sendableCurrencies[0];
  }

  @computed
  get outCurrency(): AppCurrency {
    if (this.sendableCurrencies.length <= 1) {
      // For the case before pools are initially fetched,
      return this.initialSelectCurrencies.out;
    }

    if (this._outCurrencyMinDenom) {
      const currency = this.currencyMap.get(this._outCurrencyMinDenom);
      if (currency) {
        return currency;
      }
    }

    const initialOutCurrency = this.sendableCurrencies.find(
      (c) => c.coinDenom === this.initialSelectCurrencies.out.coinDenom
    );
    const initialCurrency =
      initialOutCurrency &&
      this.sendableCurrencies.find(
        (c) => c.coinDenom === this.initialSelectCurrencies.send.coinDenom
      )
        ? initialOutCurrency
        : undefined;

    return initialCurrency ?? this.sendableCurrencies[1];
  }

  @computed
  get sendableCurrencies(): AppCurrency[] {
    if (this._pools.length === 0) {
      return [];
    }

    const chainInfo = this.chainInfo;

    // Get all coin denom in the pools.
    const coinDenomSet = new Set<string>(
      this._pools.flatMap((pool) => pool.poolAssetDenoms)
    );

    const coinDenoms = Array.from(coinDenomSet);

    const currencyMap = chainInfo.currencies.reduce<Map<string, AppCurrency>>(
      (previous, current) => {
        previous.set(current.coinMinimalDenom, current);
        return previous;
      },
      new Map()
    );

    return coinDenoms
      .filter((coinDenom) => {
        return currencyMap.has(coinDenom);
      })
      .map((coinDenom) => {
        // eslint-disable-next-line
        return currencyMap.get(coinDenom)!;
      });
  }

  @computed
  protected get optimizedRoutes(): OptimizedRoutes {
    const stakeCurrencyMinDenom = this.chainGetter.getChain(this.initialChainId)
      .stakeCurrency.coinMinimalDenom;
    const getTvl = (poolId: string) => {
      const queryPool = this._pools.find((pool) => pool.id === poolId);
      if (queryPool) {
        return queryPool.computeTotalValueLocked(this.priceStore).toDec();
      } else {
        console.warn("Returning 0 TVL for poolId: " + poolId);
        return new Dec(0);
      }
    };

    return new OptimizedRoutes(
      this._pools.map((pool) => pool.pool),
      this._incentivizedPoolIds,
      stakeCurrencyMinDenom,
      getTvl
    );
  }

  @computed
  get optimizedRoutePaths(): RouteWithAmount[] {
    runInAction(() => {
      this._notEnoughLiquidity = false;
    });
    this.setError(undefined);
    const amount = this.getAmountPrimitive();

    if (
      !amount.amount ||
      new Int(amount.amount).lte(new Int(0)) ||
      this.sendableCurrencies.length === 0
    ) {
      return [];
    }

    try {
      return this.optimizedRoutes.getOptimizedRoutesByTokenIn(
        {
          denom: amount.denom,
          amount: new Int(amount.amount),
        },
        this.outCurrency.coinMinimalDenom,
        4
      );
    } catch (e: any) {
      if (e instanceof NotEnoughLiquidityError) {
        runInAction(() => {
          this._notEnoughLiquidity = true;
        });
      }
      this.setError(e);
      return [];
    }
  }

  /** Prettify swap result for display. */
  get expectedSwapResult(): PrettyMultihopSwapResult {
    return (
      this._latestSwapResult?.case({
        fulfilled: (result) => this.makePrettyMultihopResult(result),
      }) ?? this.zeroSwapResult
    );
  }

  get expectedSwapResultIsLoading(): boolean {
    return this._latestSwapResult?.state === "pending";
  }

  /** Calculated spot price with amount of 1 token in. */
  get expectedSpotPrice(): IntPretty {
    return (
      this._spotPriceResult?.case({
        fulfilled: (result) =>
          this.makePrettyMultihopResult(result)
            .beforeSpotPriceWithoutSwapFeeInOverOut,
      }) ?? new IntPretty(0)
    );
  }

  get expectedSpotPriceIsLoading(): boolean {
    return this._spotPriceResult?.state === "pending";
  }

  @override
  get error(): Error | undefined {
    const sendCurrency = this.sendCurrency;
    if (!sendCurrency) {
      return new NoSendCurrencyError("Currency to send not set");
    }

    if (this.amount) {
      if (this._error instanceof NoRouteError) return this._error;
      if (this._notEnoughLiquidity) return new NotEnoughLiquidityError();

      const dec = new Dec(this.amount);
      const balance = this.queriesStore
        .get(this.chainId)
        .queryBalances.getQueryBech32Address(this.sender)
        .getBalanceFromCurrency(this.sendCurrency);
      const balanceDec = balance.toDec();
      if (dec.gt(balanceDec)) {
        return new InsufficientBalanceError("Insufficient balance");
      }
    }

    return this._error;
  }

  @computed
  protected get currencyMap(): Map<string, AppCurrency> {
    return this.sendableCurrencies.reduce<Map<string, AppCurrency>>(
      (previous, current) => previous.set(current.coinMinimalDenom, current),
      new Map()
    );
  }

  protected get zeroSwapResult(): PrettyMultihopSwapResult {
    return {
      amount: new CoinPretty(this.outCurrency, new Dec(0)).ready(false),
      beforeSpotPriceWithoutSwapFeeInOverOut: new IntPretty(0).ready(false),
      beforeSpotPriceWithoutSwapFeeOutOverIn: new IntPretty(0).ready(false),
      beforeSpotPriceInOverOut: new IntPretty(0).ready(false),
      beforeSpotPriceOutOverIn: new IntPretty(0).ready(false),
      afterSpotPriceInOverOut: new IntPretty(0).ready(false),
      afterSpotPriceOutOverIn: new IntPretty(0).ready(false),
      effectivePriceInOverOut: new IntPretty(0).ready(false),
      effectivePriceOutOverIn: new IntPretty(0).ready(false),
      tokenInFeeAmount: new CoinPretty(this.sendCurrency, new Dec(0)).ready(
        false
      ),
      swapFee: new RatePretty(0).ready(false),
      priceImpact: new RatePretty(0).ready(false),
      isMultihopOsmoFeeDiscount: false,
    };
  }

  constructor(
    chainGetter: ChainGetter,
    protected readonly queriesStore: IQueriesStore<OsmosisQueries>,
    protected readonly priceStore: IPriceStore,
    protected readonly initialChainId: string,
    sender: string,
    feeConfig: IFeeConfig | undefined,
    pools: ObservableQueryPool[],
    protected readonly initialSelectCurrencies: {
      send: AppCurrency;
      out: AppCurrency;
    }
  ) {
    super(chainGetter, queriesStore, initialChainId, sender, feeConfig);

    this._pools = pools;

    const debounceCalculateRoutes = debounce((paths: RouteWithAmount[]) => {
      const calcPromise =
        this.optimizedRoutes.calculateTokenOutByTokenIn(paths);
      this.setSwapResult(fromPromise(calcPromise));
    }, 350);

    // React to user input and request a swap result. This is debounced to prevent spamming the server
    autorun(() => {
      const paths = this.optimizedRoutePaths;
      this.setError(undefined);

      if (paths.length === 0 && this.amount !== "" && this.amount !== "0") {
        this.setError(new NoRouteError("No route found"));
        return this.setSwapResult(undefined);
      }

      if (paths.length === 0 || this.amount === "" || this.amount === "0") {
        return this.setSwapResult(undefined);
      }

      // clear any previous user input debounce
      debounceCalculateRoutes.clear();
      // debounce the new user input
      debounceCalculateRoutes(paths);
    });

    // react to changes in send/out currencies, then generate a spot price
    autorun(() => {
      let paths;
      const one = new Int(
        DecUtils.getTenExponentNInPrecisionRange(this.sendCurrency.coinDecimals)
          .truncate()
          .toString()
      );
      try {
        paths = this.optimizedRoutes.getOptimizedRoutesByTokenIn(
          {
            denom: this.sendCurrency.coinMinimalDenom,
            amount: one,
          },
          this.outCurrency.coinMinimalDenom,
          5
        );
      } catch (e: any) {
        console.error("No route found", e.message);
        return this.setSpotPriceResult(undefined);
      }

      if (paths.length === 0) return this.setSpotPriceResult(undefined);

      const promiseCalc =
        this.optimizedRoutes.calculateTokenOutByTokenIn(paths);
      this.setSpotPriceResult(fromPromise(promiseCalc));
    });

    makeObservable(this);
  }

  @action
  setPools(pools: ObservableQueryPool[]) {
    this._pools = pools;
  }

  @action
  setIncentivizedPoolIds(poolIds: string[]) {
    this._incentivizedPoolIds = poolIds;
  }

  @override
  setSendCurrency(currency: AppCurrency | undefined) {
    if (currency) {
      this._sendCurrencyMinDenom = currency.coinMinimalDenom;
    } else {
      this._sendCurrencyMinDenom = undefined;
    }
  }

  @action
  setOutCurrency(currency: AppCurrency | undefined) {
    if (currency) {
      this._outCurrencyMinDenom = currency.coinMinimalDenom;
    } else {
      this._outCurrencyMinDenom = undefined;
    }
  }

  @action
  switchInAndOut() {
    // give back the swap fee amount
    const outAmount = this.expectedSwapResult?.amount;
    if (outAmount && outAmount.toDec().isZero()) {
      this.setAmount("");
    } else if (outAmount) {
      this.setAmount(
        outAmount
          .shrink(true)
          .maxDecimals(6)
          .trim(true)
          .hideDenom(true)
          .toString()
      );
    }

    // Since changing in and out affects each other, it is important to use the stored value.
    const prevInCurrency = this.sendCurrency.coinMinimalDenom;
    const prevOutCurrency = this.outCurrency.coinMinimalDenom;

    this._sendCurrencyMinDenom = prevOutCurrency;
    this._outCurrencyMinDenom = prevInCurrency;
  }

  @action
  setError(error: Error | undefined) {
    this._error = error;
  }

  @action
  protected setSwapResult(
    result: IPromiseBasedObservable<MultihopSwapResult> | undefined
  ) {
    this._latestSwapResult = result;
  }

  @action
  protected setSpotPriceResult(
    result: IPromiseBasedObservable<MultihopSwapResult> | undefined
  ) {
    this._spotPriceResult = result;
  }

  /** Convert raw router type into a prettified form ready for display. */
  protected makePrettyMultihopResult(
    result: MultihopSwapResult
  ): PrettyMultihopSwapResult {
    const multiplicationInOverOut = DecUtils.getTenExponentN(
      this.outCurrency.coinDecimals - this.sendCurrency.coinDecimals
    );
    const beforeSpotPriceWithoutSwapFeeInOverOutDec =
      result.beforeSpotPriceInOverOut.mulTruncate(
        new Dec(1).sub(result.swapFee)
      );

    return {
      amount: new CoinPretty(this.outCurrency, result.amount).locale(false), // locale - remove commas
      beforeSpotPriceWithoutSwapFeeInOverOut: new IntPretty(
        beforeSpotPriceWithoutSwapFeeInOverOutDec.mulTruncate(
          multiplicationInOverOut
        )
      ),
      beforeSpotPriceWithoutSwapFeeOutOverIn:
        beforeSpotPriceWithoutSwapFeeInOverOutDec.gt(new Dec(0)) &&
        multiplicationInOverOut.gt(new Dec(0))
          ? new IntPretty(
              new Dec(1)
                .quoTruncate(beforeSpotPriceWithoutSwapFeeInOverOutDec)
                .quoTruncate(multiplicationInOverOut)
            )
          : new IntPretty(0),
      beforeSpotPriceInOverOut: new IntPretty(
        result.beforeSpotPriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      beforeSpotPriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.beforeSpotPriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      afterSpotPriceInOverOut: new IntPretty(
        result.afterSpotPriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      afterSpotPriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.afterSpotPriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      effectivePriceInOverOut: new IntPretty(
        result.effectivePriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      effectivePriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.effectivePriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      tokenInFeeAmount: new CoinPretty(
        this.sendCurrency,
        result.tokenInFeeAmount
      ).locale(false), // locale - remove commas
      swapFee: new RatePretty(result.swapFee),
      priceImpact: new RatePretty(result.priceImpact),
      isMultihopOsmoFeeDiscount: result.multiHopOsmoDiscount,
    };
  }
}
