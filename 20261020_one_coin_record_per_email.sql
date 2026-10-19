-- One current coin balance per normalized email; daily history is intentionally discarded.
-- Keep the most recently saved record, not the largest balance.
BEGIN;
LOCK TABLE public.pollpe_coin_entries IN ACCESS EXCLUSIVE MODE;
DELETE FROM public.pollpe_coin_entries e
USING (
  SELECT id, row_number() OVER (
    PARTITION BY email_address ORDER BY updated_at DESC, tracking_date DESC, created_at DESC, id DESC
  ) AS position
  FROM public.pollpe_coin_entries
) ranked
WHERE e.id = ranked.id AND ranked.position > 1;
ALTER TABLE public.pollpe_coin_entries DROP CONSTRAINT pollpe_coin_entries_email_day_uq;
ALTER TABLE public.pollpe_coin_entries ADD CONSTRAINT pollpe_coin_entries_email_uq UNIQUE (email_address);

CREATE OR REPLACE FUNCTION public.pollpe_coin_context(p_email text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_today date := (statement_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  v_current public.pollpe_coin_entries;
  v_baseline bigint := 0;
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'A valid email address is required';
  END IF;
  SELECT e.* INTO v_current FROM public.pollpe_coin_entries e WHERE e.email_address = v_email LIMIT 1;
  IF v_current.id IS NOT NULL THEN
    v_baseline := CASE WHEN v_current.tracking_date = v_today THEN v_current.yesterday_coins ELSE v_current.total_today END;
  END IF;
  RETURN json_build_object(
    'tracking_date', v_today,
    'yesterday_coins', v_baseline,
    'has_history', v_current.id IS NOT NULL,
    'today_entry', CASE WHEN v_current.tracking_date = v_today THEN row_to_json(v_current) ELSE NULL END
  );
END;
$function$;

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
  IF p_credited IS NULL OR p_credited < 0 OR p_credited > v_max THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'credited_today must be between 0 and 9007199254740991';
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
COMMIT;
