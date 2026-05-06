'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Product, StockMap } from '@/lib/types';

interface ProductsData {
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
  loading:      boolean;
  error:        string | null;
  refresh:      () => void;
}

export function useProducts(): ProductsData {
  const [products,     setProducts]     = useState<Product[]>([]);
  const [backStockMap, setBackStockMap] = useState<StockMap>({});
  const [mainStockMap, setMainStockMap] = useState<StockMap>({});
  const [backBoxMap,   setBackBoxMap]   = useState<StockMap>({});
  const [mainBoxMap,   setMainBoxMap]   = useState<StockMap>({});
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [tick,         setTick]         = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const [{ data: prods, error: pErr }, { data: stock, error: sErr }] = await Promise.all([
        supabase.from('products').select('*').eq('active_status', true).order('product_name'),
        supabase.from('stock_by_location').select('product_id, quantity, box_quantity, location_id'),
      ]);

      if (cancelled) return;
      if (pErr || sErr) {
        setError((pErr ?? sErr)!.message);
        setLoading(false);
        return;
      }

      const bsm: StockMap = {};
      const msm: StockMap = {};
      const bbm: StockMap = {};
      const mbm: StockMap = {};

      for (const row of stock ?? []) {
        if (row.location_id === 2) {
          bsm[row.product_id] = row.quantity    ?? 0;
          bbm[row.product_id] = row.box_quantity ?? 0;
        } else if (row.location_id === 1) {
          msm[row.product_id] = row.quantity    ?? 0;
          mbm[row.product_id] = row.box_quantity ?? 0;
        }
      }

      setProducts(prods ?? []);
      setBackStockMap(bsm);
      setMainStockMap(msm);
      setBackBoxMap(bbm);
      setMainBoxMap(mbm);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  return { products, backStockMap, mainStockMap, backBoxMap, mainBoxMap, loading, error, refresh };
}
