-- Require positive credited coins; opening balances may still be zero.
CREATE OR REPLACE FUNCTION public.pollpe_save_coins(
  p_email text, p_credited bigint, p_opening_balance bigint DEFAULT 0,
  p_expected_date date DEFAULT NULL::date, p_expected_yesterday bigint DEFAULT NULL::bigint
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_today date := (statement_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  v_expected_baseline bigint := 0;
  v_existing public.pollpe_coin_entries;
  v_saved public.pollpe_coin_entries;
  v_now timestamptz := statement_timestamp();
  v_max bigint := 9007199254740991;
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'A valid email address is required';
  END IF;
  IF p_credited IS NULL OR p_credited <= 0 OR p_credited > v_max THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'credited_today must be between 1 and 9007199254740991';
  END IF;
  IF p_opening_balance IS NULL OR p_opening_balance < 0 OR p_opening_balance > v_max THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'opening balance must be between 0 and 9007199254740991';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 0));
  IF p_expected_date IS NOT NULL AND p_expected_date <> v_today THEN
    RAISE EXCEPTION USING errcode = '40001', message = 'The tracking date is stale';
  END IF;
  SELECT e.* INTO v_existing FROM public.pollpe_coin_entries e WHERE e.email_address = v_email LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    v_expected_baseline := CASE WHEN v_existing.tracking_date = v_today THEN v_existing.yesterday_coins ELSE v_existing.total_today END;
  END IF;
  IF p_expected_yesterday IS NOT NULL AND p_expected_yesterday <> v_expected_baseline THEN
    RAISE EXCEPTION USING errcode = '40001', message = 'The yesterday balance is stale';
  END IF;
  IF p_opening_balance > v_max - p_credited THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'Total coins exceed the safe maximum';
  END IF;
  INSERT INTO public.pollpe_coin_entries(email_address, tracking_date, yesterday_coins, credited_today, total_today, created_at, updated_at)
  VALUES(v_email, v_today, p_opening_balance, p_credited, p_opening_balance + p_credited, v_now, v_now)
  ON CONFLICT(email_address) DO UPDATE SET
    tracking_date = excluded.tracking_date,
    yesterday_coins = excluded.yesterday_coins,
    credited_today = excluded.credited_today,
    total_today = excluded.total_today,
    updated_at = excluded.updated_at
  RETURNING * INTO v_saved;
  RETURN row_to_json(v_saved);
END;
$function$;

ALTER TABLE public.pollpe_coin_entries ALTER COLUMN credited_today DROP DEFAULT;
ALTER TABLE public.pollpe_coin_entries ADD CONSTRAINT pollpe_coin_entries_positive_credit_ck CHECK (credited_today > 0);
