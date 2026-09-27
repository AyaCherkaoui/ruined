# SMS notifications

Coverage Watchdog (`/coverage-alerts`) now has **Preview text** on each open alert.
The preview is the server-generated message. It contains no drug names, patient
details, affected counts, phone numbers, or identifying alert IDs. Demo-source
alerts explicitly say the coverage alert is simulated. The review link opens
the existing Coverage Watchdog page.

## Configuration

Copy the SMS settings from `.env.example` into your local environment. Preview
works without credentials or phone numbers; an unset `APP_URL` uses `[app link]`.
To enable sending, configure all of these server-only variables:

| Variable | Purpose |
| --- | --- |
| `SMS_MODE` | Set to `live`; defaults to preview behavior. |
| `TWILIO_ACCOUNT_SID` | Twilio account SID. |
| `TWILIO_AUTH_TOKEN` | Twilio authentication token. |
| `TWILIO_FROM_NUMBER` | Your SMS-capable sender in E.164 format. |
| `DOCTOR_PHONE` | Configured recipient in E.164 format. |
| `APP_URL` | Public app URL reachable from the recipient's phone. |
| `SMS_SEND_TOKEN` | Strong access key required for live send requests. |

No real numbers or credentials are supplied. Missing configuration keeps the
flow in preview mode. After configuration, preview the message, enter the
messaging access key, and select **Send text to configured recipient**. The key
stays in component memory only and is cleared after a completed send request.
Use HTTPS on a deployed site. The app currently has no user sign-in; the access
key protects this send endpoint, not the rest of the app.

Twilio trial accounts require verified recipients. Provider acceptance does not
prove handset delivery; the UI deliberately reports acceptance, not delivery.
See [Twilio's Message resource documentation](https://www.twilio.com/docs/messaging/api/message-resource).

## API

- `GET /api/notify`: returns `{ mode: "preview" | "live" }`, without secrets.
- `POST /api/notify`: JSON `{ "changeId": "<existing alert id>", "preview": true }`
  always previews without sending.
- Set `preview` to `false` (or omit it) to request sending. In live mode, include
  `Authorization: Bearer <SMS_SEND_TOKEN>`.
- Results include `mode`, `status`, `body`, and an optional generic `error`.
  Status is `preview`, `accepted`, `failed`, or `unknown`.
- The server owns the template and recipient; the caller cannot supply either.
  Unknown or resolved alerts are rejected.

## Delivery limits

Concurrent and repeated sends for an alert share a process-local result.
Accepted and uncertain outcomes remain held, including after a demo reset.
Definite failures can be retried after fixing configuration. Timeouts and
ambiguous provider errors are never retried automatically; check Twilio first.

State is in memory, matching the current demo architecture. Restarting the server
clears it, and separate server instances do not share it. Before multi-instance
production use, replace this with durable delivery records and authenticated
user/recipient ownership. There is no delivery-status webhook, inbound reply
handler, subscription management, or automatic notification trigger in this change.
The existing aggregate pipeline's console-only outbox remains separate.

Tests use a mocked transport and synthetic fixtures. No real SMS is sent by tests.
