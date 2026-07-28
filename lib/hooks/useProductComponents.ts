'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { ComponentMap } from '@/lib/types';

interface Result {
  map:     ComponentMap;
  refresh: () => void;
}

export function useProductComponents(): Result {
  const [map, setMap] = useState<ComponentMap>({});
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Try with the per-choice `price` column; if the DB hasn't been
      // migrated yet (08_component_prices.sql), retry without it so the
      // app keeps working — components just won't carry a price.
      let rows: Record<string, unknown>[] | null = null;
      let res = await supabase
        .from('product_components')
        .select('product_id, component_product_id, quantity, choice_group, price');
      if (res.error && /price/.test(res.error.message)) {
        res = await supabase
          .from('product_components')
          .select('product_id, component_product_id, quantity, choice_group');
      }
      if (res.error) { console.error('product_components fetch error:', res.error.message); return; }
      rows = res.data as Record<string, unknown>[] | null;
      if (cancelled || !rows) return;

      const m: ComponentMap = {};
      for (const row of rows) {
        const pid = row.product_id as number;
        if (!m[pid]) m[pid] = [];
        m[pid].push({
          component_product_id: row.component_product_id as number,
          quantity:             row.quantity as number,
          choice_group:         (row.choice_group as string | null) ?? null,
          price:                (row.price as number | null) ?? null,
        });
      }
      setMap(m);
    }

    load();
    return () => { cancelled = true; };
  }, [tick]);

  return { map, refresh };
}
