export interface Product {
  product_id:         number;
  product_name:       string;
  type:               string | null;
  brand:              string | null;
  model:              string | null;
  stock_keeping_unit: string | null;
  unit_type:          string | null;
  unit_of_measure:    string | null;
  display_unit:       string | null;
  pieces_per_box:     number | null;
  box_selling_price:  number | null;
  reorder_level:      number | null;
  active_status:      boolean;
  selling_price:      number | null;
  buying_price:       number | null;
  current_stock:      number | null;
  parent_product_id:  number | null;
  split_type:         string | null;
  // Computed join field: sum of stock_by_location quantities across all locations
  total_stock?:       number;
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

export const SESSION_KEY = 'aad_admin_auth';

export interface Supplier {
  supplier_id:   number;
  supplier_name: string;
  phone:         string | null;
  address:       string | null;
  notes:         string | null;
  active_status: boolean;
}

export interface Purchase {
  purchase_id:       number;
  supplier_id:       number | null;
  supplier_name_raw: string | null;
  purchase_date:     string | null;
  total_amount:      number | null;
  notes:             string | null;
  status:            string;
  bill_image_url:    string | null;
  created_at:        string;
}

export interface PurchaseItem {
  id:               number;
  purchase_id:      number;
  product_id:       number | null;
  product_name_raw: string | null;
  quantity:         number;
  unit_price:       number | null;
  total_price:      number | null;
  location_id:      number | null;
}

export interface ProductComponent {
  component_id:         number;
  product_id:           number;
  component_product_id: number;
  quantity:             number;
}

export type ComponentMap = Record<number, { component_product_id: number; quantity: number }[]>;

export interface StockMovement {
  id:               number;
  product_id:       number;
  from_location_id: number | null;
  to_location_id:   number | null;
  quantity:         number;
  movement_type:    string;
  reason:           string | null;
  created_at:       string;
}
