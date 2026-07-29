'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { redirectIfSessionInvalid } from '@/lib/auth';
import type { Product, StockByLoc, LocationInfo, Company, StockByCompany } from '@/lib/types';

interface ProductsData {
  products:    Product[];
  locations:   LocationInfo[];          // all active locations from DB
  companies:   Company[];               // Aadinath, Jay Aadinath, …
  stockByLoc:  StockByLoc;              // location_id → product_id → pieces (ALL companies combined)
  boxByLoc:    StockByLoc;              // location_id → product_id → boxes  (ALL companies combined)
  stockByCompany: StockByCompany;       // company_id → location_id → product_id → pieces
  boxByCompany:   StockByCompany;       // company_id → location_id → product_id → boxes
  loading:     boolean;
  error:       string | null;
  refresh:     () => void;
}

export function useProducts(): ProductsData {
  const [products,   setProducts]   = useState<Product[]>([]);
  const [locations,  setLocations]  = useState<LocationInfo[]>([]);
  const [companies,  setCompanies]  = useState<Company[]>([]);
  const [stockByLoc, setStockByLoc] = useState<StockByLoc>({});
  const [boxByLoc,   setBoxByLoc]   = useState<StockByLoc>({});
  const [stockByCompany, setStockByCompany] = useState<StockByCompany>({});
  const [boxByCompany,   setBoxByCompany]   = useState<StockByCompany>({});
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [tick,       setTick]       = useState(0);
  // Only the FIRST load shows the full-page spinner. Subsequent
  // refreshes (after a sale/adjust/transfer) update data silently so
  // the page keeps its filters, search, and scroll position.
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    if (firstLoad.current) setLoading(true);
    setError(null);

    async function load() {
      const [{ data: prods, error: pErr }, { data: stock, error: sErr }, { data: locs }, { data: comps }] =
        await Promise.all([
          supabase.from('products').select('*').eq('active_status', true).order('product_name'),
          supabase.from('stock_by_location').select('product_id, quantity, box_quantity, location_id, company_id'),
          supabase.from('locations').select('location_id, location_name, active_status').eq('active_status', true).order('location_id'),
          supabase.from('companies').select('company_id, company_name, active_status').order('company_id'),
        ]);

      if (cancelled) return;
      if (pErr || sErr) {
        // A rejected/expired login token makes these reads fail even though
        // the data is fine (the public key can still read it). Send the user
        // back to login instead of showing a blank inventory.
        if (redirectIfSessionInvalid(pErr ?? sErr)) return;
        setError((pErr ?? sErr)!.message);
        setLoading(false);
        return;
      }

      // Combined maps (all companies summed) + per-company maps.
      const sbl: StockByLoc = {};
      const bbl: StockByLoc = {};
      const sbc: StockByCompany = {};
      const bbc: StockByCompany = {};
      for (const row of stock ?? []) {
        const lid = row.location_id as number;
        const cid = (row.company_id as number) ?? 1;
        const q = row.quantity ?? 0;
        const b = row.box_quantity ?? 0;
        // combined — SUM across companies (never overwrite)
        if (!sbl[lid]) { sbl[lid] = {}; bbl[lid] = {}; }
        sbl[lid][row.product_id] = (sbl[lid][row.product_id] ?? 0) + q;
        bbl[lid][row.product_id] = (bbl[lid][row.product_id] ?? 0) + b;
        // per-company
        if (!sbc[cid]) { sbc[cid] = {}; bbc[cid] = {}; }
        if (!sbc[cid][lid]) { sbc[cid][lid] = {}; bbc[cid][lid] = {}; }
        sbc[cid][lid][row.product_id] = q;
        bbc[cid][lid][row.product_id] = b;
      }

      // Locations fallback (RLS/empty) — keep names + the 3rd location visible.
      let locationList = (locs ?? []) as LocationInfo[];
      if (locationList.length === 0) {
        const KNOWN: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown', 3: 'Main Store First Floor' };
        locationList = [1, 2, 3].map(id => ({ location_id: id, location_name: KNOWN[id] ?? `Location ${id}`, active_status: true }));
        for (const row of stock ?? []) {
          if (!locationList.some(l => l.location_id === row.location_id)) {
            locationList.push({ location_id: row.location_id, location_name: `Location ${row.location_id}`, active_status: true });
          }
        }
      }

      // Companies fallback so the UI still works before the table is populated.
      let companyList = (comps ?? []) as Company[];
      if (companyList.length === 0) {
        companyList = [
          { company_id: 1, company_name: 'Aadinath Enterprise',     active_status: true },
          { company_id: 2, company_name: 'Jay Aadinath Enterprise', active_status: true },
        ];
      }

      setProducts(prods ?? []);
      setLocations(locationList);
      setCompanies(companyList);
      setStockByLoc(sbl);
      setBoxByLoc(bbl);
      setStockByCompany(sbc);
      setBoxByCompany(bbc);
      firstLoad.current = false;
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  return { products, locations, companies, stockByLoc, boxByLoc, stockByCompany, boxByCompany, loading, error, refresh };
}
