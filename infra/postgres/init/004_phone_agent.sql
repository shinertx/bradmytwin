ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check
  CHECK (action_type IN ('SEND_EMAIL','CREATE_EVENT','UPDATE_EVENT','SUBMIT_FORM','PLACE_PHONE_CALL'));
