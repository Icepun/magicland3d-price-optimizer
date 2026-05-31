import { useCallback, useState } from "react";

/**
 * RefreshControl'ü SADECE elle aşağı-çekmeye bağlar.
 * `isRefetching`'e bağlamak, arka plan refetch'lerinde spinner'ı içeriği aşağı itip
 * takılı gösteriyordu — bu hook onu çözer: spinner yalnız kullanıcı çekince görünür.
 */
export function useManualRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);
  return { refreshing, onRefresh };
}
