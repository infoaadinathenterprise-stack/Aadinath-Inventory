'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { ComponentMap } from '@/lib/types';

export function useProductComponents(): ComponentMap {
  const [map, setMap] = useState<ComponentMap>({});

  useEffect(() => {
    supabase
      .from('product_components')
      .select('product_id, component_product_id, quantity, choice_group')
      .then(({ data, error }) => {
        if (error) { console.error('product_components fetch error:', error.message); return; }
        if (!data) return;
        const m: ComponentMap = {};
        for (const row of data) {
          if (!m[row.product_id]) m[row.product_id] = [];
          m[row.product_id].push({
            component_product_id: row.component_product_id,
            quantity: row.quantity,
            choice_group: (row as { choice_group?: string | null }).choice_group ?? null,
          });
        }
        setMap(m);
      });
  }, []);

  return map;
}
