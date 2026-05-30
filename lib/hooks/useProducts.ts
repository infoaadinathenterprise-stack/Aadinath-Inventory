'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Product, StockMap, StockByLoc, LocationInfo } from '@/lib/types';

interface ProductsData {
  products:    Product[];
  locations:   LocationInfo[];          // all active locations from DB
  stockByLoc:  StockByLoc;             // location_id → product_id → pieces
  boxByLoc:    StockByLoc;             // location_id → product_id → boxes
  loading:     boolean;
  error:       string | null;
  refresh:     () => void;
}

export function useProducts(): ProductsData {
  const [products,   setProducts]   = useState<Product[]>([]);
  const [locations,  setLocations]  = useState<LocationInfo[]>([]);
  const [stockByLoc, setStockByLoc] = useState<StockByLoc>({});
  const [boxByLoc,   setBoxByLoc]   = useState<StockByLoc>({});
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [tick,       setTick]       = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const [{ data: prods, error: pErr }, { data: stock, error: sErr }, { data: locs, error: lErr }] =
        await Promise.all([
          supabase.from('products').select('*').eq('active_status', true).order('product_name'),
          supabase.from('stock_by_location').select('product_id, quantity, box_quantity, location_id'),
          supabase.from('locations').select('location_id, location_name, active_status').eq('active_status', true).order('location_id'),
        ]);

      if (cancelled) return;
      if (pErr || sErr || lErr) {
        setError((pErr ?? sErr ?? lErr)!.message);
        setLoading(false);
        return;
      }

      // Build per-location maps
      const sbl: StockByLoc = {};
      const bbl: StockByLoc = {};
      for (const row of stock ?? []) {
        const lid = row.location_id as number;
        if (!sbl[lid]) { sbl[lid] = {}; bbl[lid] = {}; }
        sbl[lid][row.product_id] = row.quantity     ?? 0;
        bbl[lid][row.product_id] = row.box_quantity ?? 0;
      }

      setProducts(prods ?? []);
      setLocations((locs ?? []) as LocationInfo[]);
      setStockByLoc(sbl);
      setBoxByLoc(bbl);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  return { products, locations, stockByLoc, boxByLoc, loading, error, refresh };
}
