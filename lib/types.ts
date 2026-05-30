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
  // Optional product image (URL or data URL). Falls back to the default
  // placeholder when not set.
  image_url?:         string | null;
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
export const USER_KEY    = 'aad_admin_user';
export const ROLE_KEY    = 'aad_user_role';

export type UserRole = 'admin' | 'staff';

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
  choice_group:         string | null;
}

export type ComponentMap = Record<number, { component_product_id: number; quantity: number; choice_group: string | null }[]>;

export interface StockMovement {
  id:               number;
  product_id:       number;
  from_location_id: number | null;
  to_location_id:   number | null;
  quantity:         number;
  movement_type:    string;
  reason:           string | null;
  created_at?:      string;
  movement_date?:   string;
}

// One row per checkout in the POS — a group of line items sold
// together. Designed for clean analytics (no string parsing required)
// so it's straightforward to feed into an AI agent later for things
// like "what's my best-selling product this month".
export interface Sale {
  sale_id:       number;
  sale_date:     string;          // YYYY-MM-DD
  performed_by:  string | null;
  location_id:   number | null;
  total_amount:  number;
  item_count:    number;
  notes:         string | null;
  status:        string;          // COMPLETED | VOIDED
  created_at:    string;
}

export interface SaleItem {
  id:           number;
  sale_id:      number;
  product_id:   number | null;
  product_name: string | null;    // snapshot at time of sale
  quantity:     number;
  unit:         string;           // 'piece' | the bulk unit name
  unit_price:   number | null;    // SELL price per unit (what we charged)
  cost_price:   number | null;    // BUY price per unit at time of sale (snapshot)
  line_total:   number | null;    // qty * unit_price
  created_at:   string;
}

// Cash drawn out of the till during a day — bills paid, owner take,
// etc. Day "net cash" = sum(sales.total_amount) − sum(withdrawals.amount).
export interface Withdrawal {
  withdrawal_id:   number;
  withdrawal_date: string;        // YYYY-MM-DD
  amount:          number;
  reason:          string | null;
  performed_by:    string | null;
  created_at:      string;
}
