export interface Product {
  product_id:         number;
  product_name:       string;
  type:               string | null;
  brand:              string | null;
  model:              string | null;
  stock_keeping_unit: string | null;
  unit_type:          string | null;
  unit_of_measure:    string | null;
  pieces_per_box:     number | null;
  reorder_level:      number | null;
  active_status:      boolean;
  selling_price:      number | null;
  buying_price:       number | null;
}

export type StockMap = Record<number, number>;

export type AdjAction =
  | 'sold'
  | 'to_front'
  | 'to_back'
  | 'from_back'
  | 'from_main'
  | 'stockin';

export type Location = 'back' | 'main';

export const LOC_ID: Record<Location, number> = { back: 2, main: 1 };
export const OTHER_LOC: Record<Location, Location> = { back: 'main', main: 'back' };
