# Patient policy-change demo

## Data

`npm run demo:seed` creates 136 synthetic patients for `doc-001`, with 136 prescriptions and matched alerts. It uses two insurers (Wellcare and CareSource), four plans, and two prescribed drug families: Farxiga 5/10 mg and exenatide 0.005/0.01 mg per actuation. Covered alternatives still come from the existing drug cache and CMS formularies. No real patient contacts are generated.

The source releases are the existing July quarterly `v1` and September monthly `v2-cms` CMS snapshots. The seed detects their recorded changes before matching patients. It does not alter insurer rules. New, seen, switched, and dismissed statuses are staged workflow examples; a seeded switched status does not represent an actual prescription order. The original five NovoLog patients remain archived under `doc-archive`.

Stop the app before seeding: DuckDB allows one writer. Rerunning the seed preserves IDs and row counts and restores the staged review statuses. The database is ignored by Git; teammates need the CMS bootstrap described in `pipeline-milestones.md`, the drug cache, and this seed command.

## Demo sequence

1. Run `npm run demo:seed`, then `npm run dev`.
2. Open `/`: 136 affected patients, medicine filters, name/ID/plan search, review-status filter, and 20 alerts at a time. The chart page counts only this doctor's patients.
3. Open a patient and save an alternative. The selection persists and no prescription is issued.
4. Click **Replay policy changes & preview WhatsApp**. This performs detection, patient matching, and a server-generated notification preview. Repeated runs preserve alert IDs and review decisions. This replays existing evidence; it is not a new live insurer update.
5. For a live send, configure `SMS_MODE=live`, `MESSAGING_CHANNEL=whatsapp`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `DOCTOR_PHONE`, `SMS_SEND_TOKEN`, and an `APP_URL` reachable from the demo phone. Restart the app after environment changes. Localhost links are rejected for live sends.
6. Join the Twilio WhatsApp Sandbox from the demo recipient's phone and open its messaging window. Preview, enter the messaging access key, and click **Send WhatsApp to demo recipient**. The text contains a synthetic-patient count and links to `/`, where the same matched patients are displayed.
7. Re-enter the key and click **Check delivery**. Queued/accepted/sent is not proof of delivery; delivered/read is confirmation reported by Twilio. See [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

The app never sends to generated patients. The old unsupported patient-SMS composer has been replaced with the actual doctor/demo-recipient pipeline. Live transport has not been handset-verified by automated tests; tests use a mocked provider.

## Repeatability and failure handling

`policy_notifications` in the app database reserves each change-set/recipient digest before the provider request. Accepted and uncertain attempts survive app restarts and demo resets. Repeat sends return the saved receipt; concurrent requests do not send twice. Definite API rejections can be retried after fixing configuration. An uncertain attempt without a provider receipt requires checking Twilio before any manual database intervention. A delivery failure found by status polling retains its receipt and is not automatically resent.

`POST /api/demo/policy` accepts `{ "action": "preview" }`, `{ "action": "send" }`, or `{ "action": "status", "receiptId": "..." }`. All actions use existing app authentication when configured; send/status also require `Authorization: Bearer <SMS_SEND_TOKEN>`. Recipients and message content are owned by the server. This demo uses explicit replay/send controls, not a background delivery scheduler or inbound WhatsApp bot.

## Policy-change regression test

Run `npm run demo:test`. An isolated in-memory fixture starts unchanged, then removes one drug and adds a higher tier, prior authorization, step therapy, and quantity limits to another. It verifies all five change types, affected-patient deduplication, preview content, actual WhatsApp request encoding with a mocked provider, repeated/concurrent-send protection, timeout/rejection behavior, delivery-status polling, authorization, and rollback. It does not modify real CMS data or contact Twilio.

Run `npm test`, `npx tsc --noEmit`, and `npm run lint` for broader checks. Stop the development server before `npm run build` on Windows so its DuckDB lock cannot conflict with build file tracing.
