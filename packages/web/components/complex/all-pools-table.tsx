import { Dec, PricePretty, RatePretty } from "@keplr-wallet/unit";
import { ObservableQueryPool } from "@osmosis-labs/stores";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import EventEmitter from "eventemitter3";
import { observer } from "mobx-react-lite";
import { useRouter } from "next/router";
import {
  FunctionComponent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-multi-lang";

import { useFilteredData, useWindowSize } from "../../hooks";
import { useStore } from "../../stores";
import { SelectMenu } from "../control/select-menu";
import { SearchBox } from "../input";
import {
  MetricLoaderCell,
  PoolCompositionCell,
  PoolQuickActionCell,
} from "../table/cells";
import PaginatedTable from "./paginated-table";

const TVL_FILTER_THRESHOLD = 1000;

type PoolWithMetrics = {
  pool: ObservableQueryPool;
  liquidity: PricePretty;
  myLiquidity: PricePretty;
  myAvailableLiquidity: PricePretty;
  apr?: RatePretty;
  poolName: string;
  networkNames: string;
  volume24h: PricePretty;
  volume7d: PricePretty;
  feesSpent24h: PricePretty;
  feesSpent7d: PricePretty;
  feesPercentage: string;
};

export type Pool = [
  {
    poolId: string;
    poolAssets: { coinImageUrl: string | undefined; coinDenom: string }[];
    stableswapPool: boolean;
  },
  {
    value: PricePretty;
  },
  {
    value: PricePretty;
    isLoading?: boolean;
  },
  {
    value: PricePretty;
    isLoading?: boolean;
  },
  {
    value: PricePretty | RatePretty | undefined;
    isLoading?: boolean;
  },
  {
    poolId: string;
    cellGroupEventEmitter: EventEmitter<string | symbol, any>;
    onAddLiquidity?: () => void;
    onRemoveLiquidity?: () => void;
    onLockTokens?: () => void;
  }
];

const PoolFilters: Record<"superfluid" | "stable" | "weighted", string> = {
  superfluid: "Superfluid",
  stable: "Stableswap",
  weighted: "Weighted",
};

const IncentiveFilters: Record<"internal" | "external", string> = {
  internal: "Internal incentives",
  external: "External incentives",
};

export const AllPoolsTable: FunctionComponent<{
  quickAddLiquidity: (poolId: string) => void;
  quickRemoveLiquidity: (poolId: string) => void;
  quickLockTokens: (poolId: string) => void;
}> = observer(
  ({ quickAddLiquidity, quickRemoveLiquidity, quickLockTokens }) => {
    const {
      chainStore,
      queriesExternalStore,
      priceStore,
      queriesStore,
      accountStore,
      derivedDataStore,
    } = useStore();
    const t = useTranslation();

    const router = useRouter();
    const poolFilter = router.query.pool as string;
    const incentiveFilter = router.query.incentive as string;
    const fetchedRemainingPoolsRef = useRef(false);
    const { isMobile } = useWindowSize();

    const { chainId } = chainStore.osmosis;
    const queryCosmos = queriesStore.get(chainId).cosmos;
    const queriesOsmosis = queriesStore.get(chainId).osmosis!;
    const account = accountStore.getAccount(chainId);
    const fiat = priceStore.getFiatCurrency(priceStore.defaultVsCurrency)!;
    const queryActiveGauges = queriesExternalStore.queryActiveGauges;

    const allPools = queriesOsmosis.queryGammPools.getAllPools();

    const allPoolsWithMetrics: PoolWithMetrics[] = useMemo(
      () =>
        allPools.map((pool) => {
          const poolTvl = pool.computeTotalValueLocked(priceStore);
          const myLiquidity = poolTvl.mul(
            queriesOsmosis.queryGammPoolShare.getAllGammShareRatio(
              account.bech32Address,
              pool.id
            )
          );

          return {
            pool,
            ...queriesExternalStore.queryGammPoolFeeMetrics.getPoolFeesMetrics(
              pool.id,
              priceStore
            ),
            liquidity: pool.computeTotalValueLocked(priceStore),
            myLiquidity,
            myAvailableLiquidity: myLiquidity.toDec().isZero()
              ? new PricePretty(fiat, 0)
              : poolTvl.mul(
                  queriesOsmosis.queryGammPoolShare
                    .getAvailableGammShare(account.bech32Address, pool.id)
                    .quo(pool.totalShare)
                ),
            poolName: pool.poolAssets
              .map((asset) => asset.amount.currency.coinDenom)
              .join("/"),
            networkNames: pool.poolAssets
              .map(
                (asset) =>
                  chainStore.getChainFromCurrency(asset.amount.denom)
                    ?.chainName ?? ""
              )
              .join(" "),
            apr: queriesOsmosis.queryIncentivizedPools
              .computeMostApr(pool.id, priceStore)
              .add(
                // swap fees
                queriesExternalStore.queryGammPoolFeeMetrics.get7dPoolFeeApr(
                  pool,
                  priceStore
                )
              )
              .add(
                // superfluid apr
                queriesOsmosis.querySuperfluidPools.isSuperfluidPool(pool.id)
                  ? new RatePretty(
                      queriesStore
                        .get(chainId)
                        .cosmos.queryInflation.inflation.mul(
                          queriesOsmosis.querySuperfluidOsmoEquivalent.estimatePoolAPROsmoEquivalentMultiplier(
                            pool.id
                          )
                        )
                        .moveDecimalPointLeft(2)
                    )
                  : new Dec(0)
              )
              .maxDecimals(0),
          };
        }),
      [
        // note: mobx only causes rerenders for values referenced *during* render. I.e. *not* within useEffect/useCallback/useMemo hooks (see: https://mobx.js.org/react-integration.html)
        // `useMemo` is needed in this file to avoid "debounce" with the hundreds of re-renders by mobx as the 200+ API requests come in and populate 1000+ observables (otherwise the UI is unresponsive for 30+ seconds)
        // also, the higher level `useMemo`s (i.e. this one) gain the most performance as other React renders are prevented down the line as data is calculated (remember, renders are initiated by both mobx and react)
        allPools,
        queriesOsmosis.queryGammPools.isFetching,
        queriesExternalStore.queryGammPoolFeeMetrics.response,
        queriesOsmosis.queryAccountLocked.get(account.bech32Address).response,
        queriesOsmosis.queryLockedCoins.get(account.bech32Address).response,
        queriesOsmosis.queryUnlockingCoins.get(account.bech32Address).response,
        priceStore.response,
        queriesExternalStore.queryGammPoolFeeMetrics.response,
        account.bech32Address,
      ]
    );

    const pools = useMemo(
      () =>
        queryActiveGauges.poolIdsForActiveGauges.map((poolId) =>
          queriesOsmosis.queryGammPools.getPool(poolId)
        ),
      [queryActiveGauges.poolIdsForActiveGauges, queriesOsmosis.queryGammPools]
    );

    const externalIncentivizedPools = useMemo(
      () =>
        pools.filter(
          (
            pool: ObservableQueryPool | undefined
          ): pool is ObservableQueryPool => {
            if (!pool) {
              return false;
            }

            const gauges = queryActiveGauges.getExternalGaugesForPool(pool.id);

            if (!gauges || gauges.length === 0) {
              return false;
            }

            let maxRemainingEpoch = 0;
            for (const gauge of gauges) {
              if (maxRemainingEpoch < gauge.remainingEpoch) {
                maxRemainingEpoch = gauge.remainingEpoch;
              }
            }

            return maxRemainingEpoch > 0;
          }
        ),
      [pools, queryActiveGauges.response]
    );

    const externalIncentivizedPoolsWithMetrics = useMemo(
      () =>
        externalIncentivizedPools.map((pool) => {
          const gauges = queryActiveGauges.getExternalGaugesForPool(pool.id);

          let maxRemainingEpoch = 0;
          for (const gauge of gauges ?? []) {
            if (gauge.remainingEpoch > maxRemainingEpoch) {
              maxRemainingEpoch = gauge.remainingEpoch;
            }
          }

          const {
            poolDetail,
            superfluidPoolDetail: _,
            poolBonding,
          } = derivedDataStore.getForPool(pool.id);

          return {
            pool,
            ...queriesExternalStore.queryGammPoolFeeMetrics.getPoolFeesMetrics(
              pool.id,
              priceStore
            ),
            liquidity: pool.computeTotalValueLocked(priceStore),
            epochsRemaining: maxRemainingEpoch,
            myLiquidity: poolDetail.userAvailableValue,
            myAvailableLiquidity: poolDetail.userAvailableValue,
            apr:
              poolBonding.highestBondDuration?.aggregateApr.maxDecimals(0) ??
              new RatePretty(0),
            poolName: pool.poolAssets
              .map((asset) => asset.amount.currency.coinDenom)
              .join("/"),
            networkNames: pool.poolAssets
              .map(
                (asset) =>
                  chainStore.getChainFromCurrency(asset.amount.denom)
                    ?.chainName ?? ""
              )
              .join(" "),
          };
        }),
      [
        chainId,
        externalIncentivizedPools,
        queriesOsmosis.queryIncentivizedPools.response,
        queriesOsmosis.querySuperfluidPools.response,
        queryCosmos.queryInflation.isFetching,
        queriesExternalStore.queryGammPoolFeeMetrics.response,
        queriesOsmosis.queryGammPools.response,
        queryActiveGauges.response,
        priceStore,
        account,
        chainStore,
      ]
    );

    const tvlFilteredPools = useMemo(() => {
      return [...allPoolsWithMetrics, ...externalIncentivizedPoolsWithMetrics]
        .filter((p) => p.liquidity.toDec().gte(new Dec(TVL_FILTER_THRESHOLD)))
        .filter((p) => {
          if (poolFilter === "superfluid") {
            return queriesOsmosis.querySuperfluidPools.isSuperfluidPool(
              p.pool.id
            );
          }
          if (poolFilter) {
            return p.pool.type === poolFilter;
          }
          return true;
        })
        .filter((p) => {
          if (incentiveFilter === "internal") {
            return queriesOsmosis.queryIncentivizedPools.isIncentivized(
              p.pool.id
            );
          }
          if (incentiveFilter === "external") {
            const gauges = queryActiveGauges.getExternalGaugesForPool(
              p.pool.id
            );
            return gauges && gauges.length > 0;
          }
          return true;
        });
    }, [
      allPoolsWithMetrics,
      externalIncentivizedPoolsWithMetrics,
      incentiveFilter,
      poolFilter,
      queriesOsmosis.queryIncentivizedPools,
      queriesOsmosis.querySuperfluidPools,
      queryActiveGauges,
    ]);

    const [query, _setQuery, filteredPools] = useFilteredData(
      tvlFilteredPools,
      useMemo(
        () => [
          "pool.id",
          "poolName",
          "networkNames",
          "pool.poolAssets.amount.currency.originCurrency.pegMechanism",
        ],
        []
      )
    );
    const setQuery = useCallback(
      (search: string) => {
        if (search !== "" && !fetchedRemainingPoolsRef.current) {
          queriesOsmosis.queryGammPools.fetchRemainingPools();
          fetchedRemainingPoolsRef.current = true;
        }
        setSorting([]);
        _setQuery(search);
      },
      [_setQuery, queriesOsmosis.queryGammPools]
    );

    const [cellGroupEventEmitter] = useState(() => new EventEmitter());
    const tableData: Pool[] = useMemo(
      () =>
        filteredPools.map((poolWithMetrics) => {
          const poolId = poolWithMetrics.pool.id;
          const poolAssets = poolWithMetrics.pool.poolAssets.map(
            (poolAsset) => ({
              coinImageUrl: poolAsset.amount.currency.coinImageUrl,
              coinDenom: poolAsset.amount.currency.coinDenom,
            })
          );

          const pool: Pool = [
            {
              poolId,
              poolAssets,
              stableswapPool: poolWithMetrics.pool.type === "stable",
            },
            { value: poolWithMetrics.liquidity },
            {
              value: poolWithMetrics.volume24h,
              isLoading: !queriesExternalStore.queryGammPoolFeeMetrics.response,
            },
            {
              value: poolWithMetrics.feesSpent7d,
              isLoading: !queriesExternalStore.queryGammPoolFeeMetrics.response,
            },
            {
              value: poolWithMetrics.apr,
              isLoading: queriesOsmosis.queryIncentivizedPools.isAprFetching,
            },
            {
              poolId,
              cellGroupEventEmitter,
              onAddLiquidity: () => quickAddLiquidity(poolId),
              onRemoveLiquidity: !poolWithMetrics.myAvailableLiquidity
                .toDec()
                .isZero()
                ? () => quickRemoveLiquidity(poolId)
                : undefined,
              onLockTokens: !poolWithMetrics.myAvailableLiquidity
                .toDec()
                .isZero()
                ? () => quickLockTokens(poolId)
                : undefined,
            },
          ];
          return pool;
        }),
      [
        cellGroupEventEmitter,
        filteredPools,
        queriesExternalStore.queryGammPoolFeeMetrics.response,
        queriesOsmosis.queryIncentivizedPools.isAprFetching,
        quickAddLiquidity,
        quickLockTokens,
        quickRemoveLiquidity,
      ]
    );

    const columnHelper = createColumnHelper<Pool>();

    const columns = [
      columnHelper.accessor((row) => row[0].poolId, {
        cell: (props) => <PoolCompositionCell {...props.row.original[0]} />,
        header: t("pools.allPools.sort.poolName"),
        id: "id",
      }),
      columnHelper.accessor(
        (row) => row[1].value.toDec().truncate().toString(),
        {
          cell: (props) => props.row.original[1].value.toString(),
          header: t("pools.allPools.sort.liquidity"),
          id: "liquidity",
        }
      ),
      columnHelper.accessor(
        (row) => row[2].value.toDec().truncate().toString(),
        {
          cell: (props) => (
            <MetricLoaderCell
              value={props.row.original[2].value.toString()}
              isLoading={props.row.original[2].isLoading}
            />
          ),
          header: t("pools.allPools.sort.volume24h"),
          id: "volume24h",
        }
      ),
      columnHelper.accessor(
        (row) => row[3].value.toDec().truncate().toString(),
        {
          cell: (props) => (
            <MetricLoaderCell
              value={props.row.original[3].value.toString()}
              isLoading={props.row.original[3].isLoading}
            />
          ),
          header: t("pools.allPools.sort.fees"),
          id: "fees",
        }
      ),
      columnHelper.accessor((row) => row[4].value?.toDec().toString(), {
        cell: (props) => (
          <MetricLoaderCell
            value={props.row.original[4].value?.toString()}
            isLoading={props.row.original[4].isLoading}
          />
        ),
        header: t("pools.allPools.sort.APRIncentivized"),
        id: "apr",
      }),
      columnHelper.accessor((row) => row[5], {
        cell: (props) => {
          return <PoolQuickActionCell {...props.row.original[5]} />;
        },
        header: "",
        id: "actions",
      }),
    ];

    const [sorting, setSorting] = useState<SortingState>([
      {
        id: "liquidity",
        desc: true,
      },
    ]);

    const table = useReactTable({
      data: tableData,
      columns,
      state: {
        sorting,
      },
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
      onSortingChange: (s) => {
        queriesOsmosis.queryGammPools.fetchRemainingPools();
        setSorting(s);
      },
    });

    const containerRef = useRef<HTMLDivElement | null>(null);
    const handleFetchRemaining = useCallback(
      () => queriesOsmosis.queryGammPools.fetchRemainingPools(),
      [queriesOsmosis.queryGammPools]
    );

    return (
      <>
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex place-content-between items-center">
            <h5>{t("pools.allPools.title")}</h5>
            <div className="flex flex-wrap items-center gap-3 lg:w-full lg:place-content-between">
              <SelectMenu
                text={
                  isMobile
                    ? t("components.pool.mobileTitle")
                    : t("components.pool.title")
                }
                options={useMemo(
                  () =>
                    Object.entries(PoolFilters).map(([id, display]) => ({
                      id,
                      display,
                    })),
                  []
                )}
                selectedOptionId={poolFilter}
                onSelect={useCallback(
                  (id: string) => {
                    if (id === poolFilter) {
                      router.replace(
                        { query: { ...router.query, pool: undefined } },
                        undefined,
                        {
                          scroll: false,
                        }
                      );
                    } else {
                      router.push(
                        { query: { ...router.query, pool: id } },
                        undefined,
                        {
                          scroll: false,
                        }
                      );
                    }
                  },

                  [poolFilter, router]
                )}
              />
              <SelectMenu
                text={
                  isMobile
                    ? t("components.incentive.mobileTitle")
                    : t("components.incentive.title")
                }
                options={useMemo(
                  () =>
                    Object.entries(IncentiveFilters).map(([id, display]) => ({
                      id,
                      display,
                    })),
                  []
                )}
                selectedOptionId={incentiveFilter}
                onSelect={useCallback(
                  (id: string) => {
                    if (id === incentiveFilter) {
                      router.replace(
                        {
                          query: { ...router.query, incentive: undefined },
                        },
                        undefined,
                        {
                          scroll: false,
                        }
                      );
                    } else {
                      router.push(
                        { query: { ...router.query, incentive: id } },
                        undefined,
                        {
                          scroll: false,
                        }
                      );
                    }
                  },

                  [incentiveFilter, router]
                )}
              />
              <SearchBox
                currentValue={query}
                onInput={setQuery}
                placeholder={t("pools.allPools.search")}
                className="!w-64"
                size="small"
              />
            </div>
          </div>
        </div>
        <div className="my-5 h-full overflow-auto" ref={containerRef}>
          <PaginatedTable
            containerRef={containerRef}
            paginate={handleFetchRemaining}
            table={table}
          />
        </div>
      </>
    );
  }
);
