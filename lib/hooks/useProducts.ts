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
      // Only treat products/stock errors as fatal; locations error is handled gracefully below
      if (pErr || sErr) {
        setError((pErr ?? sErr)!.message);
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

      // If locations query returned empty (RLS blocking read / no data),
      // fall back to the known location set so names + the 3rd location
      // still appear. Run the SQL read policy on `locations` to make the
      // real table the source of truth instead of this fallback.
      let locationList = (locs ?? []) as LocationInfo[];
      if (locationList.length === 0) {
        const KNOWN: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown', 3: 'Main Store First Floor' };
        locationList = [1, 2, 3].map(id => ({
          location_id:   id,
          location_name: KNOWN[id] ?? `Location ${id}`,
          active_status: true,
        }));
        // Include any other location ids that appear in stock but aren't in KNOWN
        for (const row of stock ?? []) {
          if (!locationList.some(l => l.location_id === row.location_id)) {
            locationList.push({ location_id: row.location_id, location_name: `Location ${row.location_id}`, active_status: true });
          }
        }
      }

      setProducts(prods ?? []);
      setLocations(locationList);
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
