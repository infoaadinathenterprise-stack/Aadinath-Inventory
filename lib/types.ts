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

// All StockMaps keyed by location_id  →  product_id  →  qty
export type StockByLoc = Record<number, StockMap>;

export interface LocationInfo {
  location_id:   number;
  location_name: string;
  active_status: boolean;
}

export interface Company {
  company_id:    number;
  company_name:  string;
  active_status: boolean;
}

// Aadinath owns all pre-existing stock. Jay Aadinath is company 2.
export const DEFAULT_COMPANY_ID = 1;

// Per-company stock: company_id → location_id → product_id → qty
export type StockByCompany = Record<number, StockByLoc>;

export type AdjAction = 'sold' | 'writeoff' | 'transfer' | 'receive' | 'stockin';

/** @deprecated use location_id (number) directly */
export type Location = number;

export const SESSION_KEY = 'aad_admin_auth';
export const USER_KEY    = 'aad_admin_user';
export const ROLE_KEY    = 'aad_user_role';
// Signed login token minted by /api/login. Sent as the Supabase access
// token on every request; the role inside it is what the database trusts.
export const TOKEN_KEY   = 'aad_session_token';

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
  company_id?:       number;          // which company this purchase stocked into
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
  company_id?:  number;           // which company this line sold from
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
