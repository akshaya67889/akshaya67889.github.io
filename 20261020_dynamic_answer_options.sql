-- Independent option text and serial style; existing questions stay unnumbered.
ALTER TABLE public.pollpe_polls
  ADD COLUMN option_label_style text NOT NULL DEFAULT 'none'
  CHECK (option_label_style IN ('none', 'numeric', 'alpha'));
ALTER TABLE public.pollpe_polls DROP CONSTRAINT pollpe_polls_options_check;
ALTER TABLE public.pollpe_polls ADD CONSTRAINT pollpe_polls_options_check
  CHECK (cardinality(options) BETWEEN 2 AND 50 AND array_ndims(options) = 1);

-- Re-create with an optional argument so older clients still publish unchanged.
DROP FUNCTION public.pollpe_publish(text, uuid, date, text, text[], integer, text);
CREATE FUNCTION public.pollpe_publish(
  p_key text, p_id uuid, p_date date, p_question text, p_options text[],
  p_selected integer, p_note text DEFAULT '', p_label_style text DEFAULT 'none'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE result_id uuid; v_options text[];
BEGIN
  IF NOT pollpe_private.valid_publishing_credential(p_key) THEN
    RAISE EXCEPTION 'Invalid publishing key' USING ERRCODE='42501';
  END IF;
  IF p_date IS NULL OR p_question IS NULL OR length(btrim(p_question)) NOT BETWEEN 1 AND 1000
     OR p_options IS NULL OR cardinality(p_options) NOT BETWEEN 2 AND 50
     OR array_ndims(p_options)<>1 OR p_selected IS NULL OR p_selected<0
     OR p_selected>=cardinality(p_options) OR length(coalesce(p_note,''))>2000
     OR p_label_style IS NULL OR p_label_style NOT IN ('none','numeric','alpha') THEN
    RAISE EXCEPTION 'Check date, question, answer, options and serial style';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_options) AS opt WHERE opt IS NULL OR length(btrim(opt)) NOT BETWEEN 1 AND 300) THEN
    RAISE EXCEPTION 'Each option must contain 1 to 300 characters';
  END IF;
  SELECT array_agg(btrim(opt) ORDER BY ord) INTO v_options FROM unnest(p_options) WITH ORDINALITY AS t(opt,ord);
  IF p_id IS NULL THEN
    INSERT INTO public.pollpe_polls(poll_date,question,options,selected_option,note,option_label_style)
    VALUES(p_date,btrim(p_question),v_options,p_selected,coalesce(p_note,''),p_label_style)
    RETURNING id INTO result_id;
  ELSE
    UPDATE public.pollpe_polls SET poll_date=p_date,question=btrim(p_question),options=v_options,
      selected_option=p_selected,note=coalesce(p_note,''),option_label_style=p_label_style,updated_at=now()
    WHERE id=p_id RETURNING id INTO result_id;
    IF result_id IS NULL THEN RAISE EXCEPTION 'Poll not found'; END IF;
  END IF;
  RETURN result_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.pollpe_publish(text,uuid,date,text,text[],integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pollpe_publish(text,uuid,date,text,text[],integer,text,text) TO anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
