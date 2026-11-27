-- ============================================================================
--  26_single_company_name.sql  —  one company: Jay Aadinath Enterprises Ltd.
--  SAFE on a live database: renames the one remaining company row.
--
--  Aadinath (company 1) was merged into company 2 by 10_merge_companies.sql,
--  and the website no longer shows any company picker. company_id columns stay
--  as internal bookkeeping (every row is 2); the merge-guard triggers turn any
--  stray company 1 / null write into 2.
-- ============================================================================

update public.companies
   set company_name = 'Jay Aadinath Enterprises Ltd'
 where company_id = 2;

-- To undo:
--   update public.companies set company_name = 'Jay Aadinath Enterprise' where company_id = 2;
