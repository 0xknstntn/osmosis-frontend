import { KVStore } from "@keplr-wallet/common";
import {
  ChainGetter,
  ObservableChainQuery,
  ObservableChainQueryMap,
  QueryResponse,
} from "@keplr-wallet/stores";
import { CoinPretty, Dec, Int } from "@keplr-wallet/unit";
import { maxTick, minTick, tickToSqrtPrice } from "@osmosis-labs/math";
import { action, computed, makeObservable, observable } from "mobx";

import { LiquidityPosition } from "./types";

const URL_BASE = "/osmosis/concentratedliquidity/v1beta1";

export type PositionPrices = {
  sqrtPrice: Dec;
  price: Dec;
};

/** Stores liquidity data for a single pool. */
export class ObservableQueryLiquidityPositionById extends ObservableChainQuery<LiquidityPosition> {
  @observable.ref
  protected _raw?: LiquidityPosition;

  @observable
  protected _canFetch = false;

  get hasData() {
    return this._raw !== undefined;
  }

  /** `amount0` */
  @computed
  get baseAsset(): CoinPretty | undefined {
    const baseDenom = this._raw?.asset0.denom;
    const baseAmount = this._raw?.asset0.amount;

    if (!baseDenom || !baseAmount) return;

    return new CoinPretty(
      this.chainGetter.getChain(this.chainId).forceFindCurrency(baseDenom),
      baseAmount
    );
  }

  /** `amount1` */
  @computed
  get quoteAsset(): CoinPretty | undefined {
    const quoteDenom = this._raw?.asset1.denom;
    const baseAmount = this._raw?.asset1.amount;

    if (!quoteDenom || !baseAmount) return;

    return new CoinPretty(
      this.chainGetter.getChain(this.chainId).forceFindCurrency(quoteDenom),
      baseAmount
    );
  }

  @computed
  get bech32Address(): string | undefined {
    return this._raw?.position.address;
  }

  @computed
  get joinTime(): Date | undefined {
    if (!this._raw) return;
    return new Date(this._raw.position.join_time);
  }

  @computed
  get lowerTick(): Int | undefined {
    if (this._raw?.position.lower_tick)
      return new Int(this._raw?.position.lower_tick);
  }

  @computed
  get lowerPrices(): PositionPrices | undefined {
    if (!this.lowerTick) return;
    const sqrtPrice = tickToSqrtPrice(this.lowerTick);
    return {
      sqrtPrice,
      price: sqrtPrice.mul(sqrtPrice),
    };
  }

  @computed
  get upperTick(): Int | undefined {
    if (this._raw?.position.upper_tick)
      return new Int(this._raw?.position.upper_tick);
  }

  @computed
  get upperPrices(): PositionPrices | undefined {
    if (!this.upperTick) return;
    const sqrtPrice = tickToSqrtPrice(this.upperTick);
    return {
      sqrtPrice,
      price: sqrtPrice.mul(sqrtPrice),
    };
  }

  @computed
  get poolId(): string | undefined {
    return this._raw?.position.pool_id;
  }

  @computed
  get liquidity(): Dec | undefined {
    if (this._raw?.position.liquidity)
      return new Dec(this._raw?.position.liquidity);
  }

  @computed
  get claimableFees(): CoinPretty[] {
    if (!this._raw?.claimable_fees) return [];
    return this._raw?.claimable_fees.map(
      ({ denom, amount }) =>
        new CoinPretty(
          this.chainGetter.getChain(this.chainId).forceFindCurrency(denom),
          amount
        )
    );
  }

  @computed
  get claimableIncentives(): CoinPretty[] {
    if (!this._raw?.claimable_incentives) return [];
    return this._raw?.claimable_fees.map(
      ({ denom, amount }) =>
        new CoinPretty(
          this.chainGetter.getChain(this.chainId).forceFindCurrency(denom),
          amount
        )
    );
  }

  @computed
  get isFullRange(): boolean {
    if (this.lowerTick?.equals(minTick) && this.upperTick?.equals(maxTick)) {
      return true;
    }

    return false;
  }

  constructor(
    kvStore: KVStore,
    chainId: string,
    chainGetter: ChainGetter,
    readonly id: string
  ) {
    super(
      kvStore,
      chainId,
      chainGetter,
      `${URL_BASE}/position_by_id?position_id=${id}`
    );

    makeObservable(this);
  }

  @action
  allowFetch() {
    this._canFetch = true;
  }

  protected canFetch() {
    return this._canFetch;
  }

  protected setResponse(response: Readonly<QueryResponse<LiquidityPosition>>) {
    super.setResponse(response);
    this.setRaw(response.data);
    this.chainGetter
      .getChain(this.chainId)
      .addUnknownCurrencies(
        response.data.asset0.denom,
        response.data.asset1.denom,
        ...response.data.claimable_fees.map(({ denom }) => denom),
        ...response.data.claimable_incentives.map(({ denom }) => denom)
      );
  }

  @action
  setRaw(position: LiquidityPosition) {
    this._raw = position;
  }

  static makeWithRaw(
    kvStore: KVStore,
    chainId: string,
    chainGetter: ChainGetter,
    position: LiquidityPosition
  ) {
    const queryPosition = new ObservableQueryLiquidityPositionById(
      kvStore,
      chainId,
      chainGetter,
      position.position.position_id
    );

    queryPosition.setRaw(position);
    return queryPosition;
  }
}

export class ObservableQueryLiquidityPositionsById extends ObservableChainQueryMap<LiquidityPosition> {
  protected _fetchingPositionIds: Set<string> = new Set();
  constructor(kvStore: KVStore, chainId: string, chainGetter: ChainGetter) {
    super(kvStore, chainId, chainGetter, (positionId: string) => {
      return new ObservableQueryLiquidityPositionById(
        this.kvStore,
        this.chainId,
        this.chainGetter,
        positionId
      );
    });
  }

  getForPositionId(positionId: string) {
    const pos = super.get(positionId) as ObservableQueryLiquidityPositionById;

    // If the requested gauge does not have data, fetch it.
    if (!pos.hasData && !this._fetchingPositionIds.has(positionId)) {
      this._fetchingPositionIds.add(positionId);
      pos.allowFetch();
      pos.fetch();
      pos
        .waitResponse()
        .finally(() => this._fetchingPositionIds.delete(positionId));
    }

    return super.get(positionId) as ObservableQueryLiquidityPositionById;
  }

  setWithPosition(position: LiquidityPosition) {
    const queryLiquidityPosition =
      ObservableQueryLiquidityPositionById.makeWithRaw(
        this.kvStore,
        this.chainId,
        this.chainGetter,
        position
      );

    this.map.set(position.position.position_id, queryLiquidityPosition);
  }
}
