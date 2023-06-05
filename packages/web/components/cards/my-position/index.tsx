import { CoinPretty, Dec, Int, PricePretty } from "@keplr-wallet/unit";
import { tickToSqrtPrice } from "@osmosis-labs/math";
import { ConcentratedLiquidityPool } from "@osmosis-labs/pools";
import { observer } from "mobx-react-lite";
import { FunctionComponent, ReactNode, useState } from "react";
import { useTranslation } from "react-multi-lang";

import { PoolAssetsIcon, PoolAssetsName } from "~/components/assets";
import { MyPositionStatus } from "~/components/cards/my-position/status";
import { useHistoricalAndLiquidityData } from "~/hooks/ui-config/use-historical-and-depth-data";
import { useStore } from "~/stores";
import { formatPretty } from "~/utils/formatter";

import { MyPositionCardExpandedSection } from "./expanded";

/** User's concentrated liquidity position.  */
export const MyPositionCard: FunctionComponent<{
  positionIds: string[];
  baseAmount: CoinPretty;
  quoteAmount: CoinPretty;
  lowerTick: Int;
  upperTick: Int;
  poolId: string;
  passive: boolean;
}> = observer(
  ({
    positionIds,
    baseAmount,
    quoteAmount,
    passive,
    lowerTick,
    upperTick,
    poolId,
  }) => {
    const t = useTranslation();
    const { chainStore, priceStore } = useStore();
    const [collapsed, setCollapsed] = useState(true);

    const { chainId } = chainStore.osmosis;

    const config = useHistoricalAndLiquidityData(chainId, poolId);

    const { pool, quoteCurrency, baseCurrency, priceDecimal } = config;

    console.log({ priceDecimal });

    const fiatBase =
      baseCurrency &&
      priceStore.calculatePrice(new CoinPretty(baseCurrency, baseAmount));

    const fiatQuote =
      quoteCurrency &&
      priceStore.calculatePrice(new CoinPretty(quoteCurrency, quoteAmount));

    const fiatCurrency =
      priceStore.supportedVsCurrencies[priceStore.defaultVsCurrency];

    const liquidityValue =
      fiatBase &&
      fiatQuote &&
      fiatCurrency &&
      new PricePretty(fiatCurrency, fiatBase.add(fiatQuote));

    const clPool = pool?.pool as ConcentratedLiquidityPool;

    if (!clPool) return null;

    const currentSqrtPrice = clPool.currentSqrtPrice;
    const currentPrice = currentSqrtPrice.mul(currentSqrtPrice);
    const lowerPriceSqrt = tickToSqrtPrice(lowerTick);
    const upperPriceSqrt = tickToSqrtPrice(upperTick);
    const lowerPrice = lowerPriceSqrt.mul(lowerPriceSqrt);
    const upperPrice = upperPriceSqrt.mul(upperPriceSqrt);

    return (
      <div className="flex flex-col gap-8 overflow-hidden rounded-[20px] bg-osmoverse-800 p-8">
        <div
          className="flex cursor-pointer flex-row items-center gap-[52px]"
          onClick={() => setCollapsed(!collapsed)}
        >
          <div>
            <PoolAssetsIcon
              className="!w-[78px]"
              assets={pool?.poolAssets.map((poolAsset) => ({
                coinImageUrl: poolAsset.amount.currency.coinImageUrl,
                coinDenom: poolAsset.amount.currency.coinDenom,
              }))}
            />
          </div>
          <div className="flex flex-shrink-0 flex-grow flex-col gap-[6px]">
            <div className="flex flex-shrink-0 flex-grow flex-col gap-[6px]">
              <div className="flex flex-row items-center gap-[6px]">
                <PoolAssetsName
                  size="md"
                  assetDenoms={pool?.poolAssets.map(
                    (asset) => asset.amount.currency.coinDenom
                  )}
                />
                <span className="px-2 py-1 text-subtitle1 text-osmoverse-100">
                  {pool?.swapFee.toString()} {t("clPositions.fee")}
                </span>
              </div>
              <MyPositionStatus
                currentPrice={currentPrice}
                lowerPrice={lowerPrice}
                upperPrice={upperPrice}
              />
            </div>
          </div>
          <div className="flex flex-row gap-[52px] self-start">
            {/* TODO: use actual ROI */}
            <PositionDataGroup label={t("clPositions.roi")} value="-" />
            <RangeDataGroup lowerPrice={lowerPrice} upperPrice={upperPrice} />
            <PositionDataGroup
              label={t("clPositions.myLiquidity")}
              value={liquidityValue ? formatPretty(liquidityValue) : "$0"}
            />
            <PositionDataGroup label={t("clPositions.incentives")} value="-" />
          </div>
        </div>
        {!collapsed && (
          <MyPositionCardExpandedSection
            chartConfig={config}
            positionIds={positionIds}
            poolId={poolId}
            lowerPrice={lowerPrice}
            upperPrice={upperPrice}
            baseAmount={baseAmount}
            quoteAmount={quoteAmount}
            passive={passive}
          />
        )}
      </div>
    );
  }
);

const PositionDataGroup: FunctionComponent<{
  label: string;
  value: string | ReactNode;
}> = ({ label, value }) => (
  <div className="flex-grow-1 flex max-w-[12rem] flex-shrink-0 flex-col items-end gap-2">
    <div className="text-subtitle1 text-osmoverse-400">{label}</div>
    {typeof value === "string" ? (
      <h6 className="text-white w-full truncate text-right">{value}</h6>
    ) : (
      value
    )}
  </div>
);

const RangeDataGroup: FunctionComponent<{
  lowerPrice: Dec;
  upperPrice: Dec;
}> = ({ lowerPrice, upperPrice }) => {
  const t = useTranslation();
  return (
    <PositionDataGroup
      label={t("clPositions.selectedRange")}
      value={
        <div className="flex w-full flex-row justify-end gap-1 overflow-hidden">
          <h6>{lowerPrice.toString()}</h6>
          <img alt="" src="/icons/left-right-arrow.svg" className="h-6 w-6" />
          <h6>{upperPrice.toString()}</h6>
        </div>
      }
    />
  );
};
