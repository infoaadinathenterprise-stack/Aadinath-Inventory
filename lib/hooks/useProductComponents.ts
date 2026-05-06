'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { ComponentMap } from '@/lib/types';

export function useProductComponents(): ComponentMap {
  const [map, setMap] = useState<ComponentMap>({});

  useEffect(() => {
    supabase
      .from('product_components')
      .select('product_id, component_product_id, quantity')
      .then(({ data }) => {
        if (!data) return;
        const m: ComponentMap = {};
        for (const row of data) {
          if (!m[row.product_id]) m[row.product_id] = [];
          m[row.product_id].push({
            component_product_id: row.component_product_id,
            quantity: row.quantity,
          });
        }
        setMap(m);
      });
  }, []);

  return map;
}
