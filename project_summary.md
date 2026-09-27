# Heads Up — Project Summary

## 0. The product (the UI must tell this story)

Insurance plans change the rules on drugs: they drop a drug, raise its tier, or add prior authorization. Doctors get no notification. Patients find out at the pharmacy counter.

Heads Up watches insurance plan data. When it detects a coverage change, it texts the doctors whose patients are affected, and gives them a plan to act.

Core principles (show them in the UI):

- Every coverage decision comes from deterministic, rule-based code on plan data. No AI ever decides coverage.

- The SMS never contains patient names. Only the logged-in doctor sees their own patients.

- Honest numbers: every dollar amount is labeled "est.", and unknown values show "Unknown" (never 0).

## 1. Stack

Next.js (latest, App Router) + TypeScript + Tailwind CSS + shadcn/ui + lucide-react + framer-motion + recharts

No database. Data lives in JSON files in /data. Alert state (resolved, sent) is kept in memory on the server with a POST /api/demo/reset to clear it. (Optionally also write it to /data/state.json.)

Tests: vitest

Runs with npm install && npm run dev. Must also deploy cleanly to Vercel (we need a public URL so the link in the text message opens on a real phone).

## 2. Data (create these files exactly, these values come from real CMS Part D files)

### /data/snapshots.json

Two snapshots of plan coverage for the drugs we watch. before = CMS quarterly file (Q2 2026, SPUF_2026_20260701.zip). after = CMS monthly file (September 2026, 2026_20260916.zip).

```json
{
  "before": {
    "id": "v1",
    "label": "CMS quarterly formulary file, Q2 2026",
    "sourceFile": "SPUF_2026_20260701.zip",
    "capturedAt": "2026-07-01",
    "rows": [
      {
        "planId": "H1170-002",
        "planName": "Kaiser Permanente Senior Advantage Enhanced 1 (HMO)",
        "insurer": "Kaiser Permanente",
        "formularyId": "00026405",
        "rxcui": "1653204",
        "drugName": "NovoLog FlexPen (insulin aspart)",
        "covered": true,
        "tier": 3,
        "priorAuthorization": false,
        "stepTherapy": false,
        "quantityLimit": false,
        "estMonthlyCost": 47.0
      },
      {
        "planId": "S5884-135",
        "planName": "Humana Basic Rx Plan (PDP)",
        "insurer": "Humana",
        "formularyId": "00026399",
        "rxcui": "1653204",
        "drugName": "NovoLog FlexPen (insulin aspart)",
        "covered": true,
        "tier": 3,
        "priorAuthorization": false,
        "stepTherapy": false,
        "quantityLimit": false,
        "estMonthlyCost": 133.56
      },
      {
        "planId": "S5884-135",
        "planName": "Humana Basic Rx Plan (PDP)",
        "insurer": "Humana",
        "formularyId": "00026399",
        "rxcui": "1364445",
        "drugName": "Eliquis 5 mg (apixaban)",
        "covered": true,
        "tier": 3,
        "priorAuthorization": false,
        "stepTherapy": false,
        "quantityLimit": true,
        "estMonthlyCost": null
      }
    ]
  },
  "after": {
    "id": "v2-cms",
    "label": "CMS monthly formulary file, September 2026",
    "sourceFile": "2026_20260916.zip",
    "capturedAt": "2026-09-16",
    "rows": [
      {
        "planId": "S5884-135",
        "planName": "Humana Basic Rx Plan (PDP)",
        "insurer": "Humana",
        "formularyId": "00026399",
        "rxcui": "1653204",
        "drugName": "NovoLog FlexPen (insulin aspart)",
        "covered": true,
        "tier": 3,
        "priorAuthorization": false,
        "stepTherapy": false,
        "quantityLimit": false,
        "estMonthlyCost": 133.56
      },
      {
        "planId": "S5884-135",
        "planName": "Humana Basic Rx Plan (PDP)",
        "insurer": "Humana",
        "formularyId": "00026399",
        "rxcui": "1364445",
        "drugName": "Eliquis 5 mg (apixaban)",
        "covered": true,
        "tier": 3,
        "priorAuthorization": false,
        "stepTherapy": false,
        "quantityLimit": true,
        "estMonthlyCost": null
      }
    ]
  }
}
```

Note: the Kaiser NovoLog row is absent from after. That's the real change (NovoLog was dropped from that formulary). Missing from after while present in before = "removed".

### /data/doctor.json

```json
{
  "id": "doc-001",
  "name": "Dr. Amina Lee",
  "specialty": "Internal Medicine",
  "practice": "Peachtree Family Medicine, Atlanta GA",
  "patients": [
    {
      "id": "pt-001",
      "name": "Diane Whitfield",
      "planId": "H1170-002",
      "rxcuis": [
        "1653204"
      ]
    },
    {
      "id": "pt-002",
      "name": "Marcus Reyes",
      "planId": "H1170-002",
      "rxcuis": [
        "1653204"
      ]
    },
    {
      "id": "pt-003",
      "name": "Sandra Nguyen",
      "planId": "H1170-002",
      "rxcuis": [
        "1653204"
      ]
    },
    {
      "id": "pt-004",
      "name": "Harold Betancourt",
      "planId": "S5884-135",
      "rxcuis": [
        "1653204"
      ]
    },
    {
      "id": "pt-005",
      "name": "Rosa Lindqvist",
      "planId": "S5884-135",
      "rxcuis": [
        "1653204",
        "1364445"
      ]
    }
  ]
}
```

Label all patients in the UI as "Synthetic demo patients" (small caption).

### /data/facts.json (context stats for the dashboard, each with its source)

```json
[
  {
    "value": "79%",
    "label": "of physicians say patients abandon treatment due to prior authorization",
    "source": "AMA physician survey, released May 2026",
    "url": "https://www.ama-assn.org/press-center/ama-press-releases/ama-survey-prior-authorization-reform-pledge-falls-short-physicians"
  },
  {
    "value": "13 hrs",
    "label": "per week physicians and staff spend on prior authorization",
    "source": "AMA physician survey, released May 2026",
    "url": "https://www.ama-assn.org/press-center/ama-press-releases/ama-survey-prior-authorization-reform-pledge-falls-short-physicians"
  },
  {
    "value": "27%",
    "label": "of U.S. adults didn't fill a prescription in the past year because of cost",
    "source": "KFF Health Tracking Poll, 2026",
    "url": "https://www.kff.org/health-costs/americans-challenges-with-health-care-costs/"
  },
  {
    "value": "1,202",
    "label": "drug coverage rows dropped across Georgia Medicare formularies between the Q2 and September 2026 CMS files",
    "source": "Our analysis of CMS Part D formulary files",
    "url": "https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information"
  }
]
```

## 3. Backend logic (in /lib, pure functions, fully tested)

### lib/compare.ts: the engine

compareSnapshots(before, after) → Change[]. Match rows by (planId, rxcui). Rules:

- In before and covered, missing from after or covered: false → removed

- tier goes up → tier_increase; tier goes down → tier_decrease

- priorAuthorization, stepTherapy, quantityLimit false→true → *_added; true→false → *_removed

- null/unknown on either side is never a change

- several changes on the same row → one Change per type

- identical → no change

```text
Change = { id (deterministic hash of planId+rxcui+type+snapshot ids), planId, planName, insurer, rxcui, drugName, changeType, direction: "worsened"|"improved", before: {…row}, after: {…row}|null, evidence: { beforeFile, afterFile } }
```

### lib/match.ts

affectedPatients(change, doctor) → patients whose planId matches and whose rxcuis include the change's rxcui. Only for worsened changes.

### lib/sms.ts

buildSms(change, affectedCount, link) → plain text, under 320 characters, zero patient names:

Heads Up: Kaiser Permanente no longer covers NovoLog FlexPen on Senior Advantage Enhanced 1 (per CMS Sept 2026 data). 3 of your patients are affected. Review and act: `<link>`

Adapt the wording per change type (removed / higher tier / now requires prior authorization / step therapy / quantity limit).

### lib/twilio.ts

Send via Twilio REST API with fetch (no SDK): POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json, Basic Auth, form fields To, From, Body. Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, DOCTOR_PHONE, APP_URL. If any env var is missing → "preview mode": don't throw, return { sent: false, mode: "preview", body }. On a Twilio error, return { sent: false, error } instead of crashing. Always return toMasked (last 4 digits only).

### lib/watch.ts: the watcher step log

runWatch() returns real, computed steps with timings, for the UI to reveal one by one:

- "Checking CMS data catalog" → try a real fetch("https://data.cms.gov/data.json") with a 5s timeout, find the dataset titled "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information", and report its latest modified date. If the fetch fails or times out, report "CMS catalog unreachable, using cached release 2026_20260916.zip" (never fail the run).

- "Loaded snapshot v1: N rows (CMS Q2 2026)"

- "Loaded snapshot v2-cms: N rows (CMS Sept 2026)"

- "Compared N plan/drug pairs: X changes detected"

- "Matched to Dr. Amina Lee's panel: Y patients affected"

All numbers are computed at runtime. Store each run in memory for `/api/runs`.

### API routes

| Method | Route | Request / response |
| --- | --- | --- |
| POST | `/api/watch/run` | `{ steps, changes }` |
| GET | `/api/changes` | Changes + affectedCount + status (open/resolved) |
| GET | `/api/changes/[id]` | Change + affected patients (names) + explanation + status |
| POST | `/api/notify` | Body: `{ changeId }`. Builds the SMS, sends it (or preview), returns `{ sent, mode, body, toMasked }`. |
| POST | `/api/changes/[id]/resolve` | Body: `{ action: "reviewed" \| "switched" \| "prior_auth_started" }` |
| GET | `/api/runs` | Past watch runs |
| POST | `/api/demo/reset` | Clear resolved/sent state and runs |

explanation = a deterministic template: "Kaiser Permanente's September 2026 formulary no longer lists NovoLog FlexPen for this plan. Patients filling it at their next refill may face full price unless they switch or get an exception." (If XAI_API_KEY is set, P2 may rephrase it with Grok, but it must fall back to the template on any error, and must never receive patient names.)

### Tests (lib/*.test.ts, vitest): at least these must pass

- removed detected for the Kaiser row; Humana rows produce no change

- identical snapshots → no changes

- unknown (null) on either side → no change

- two changes on one row → two Changes

- tier down / PA removed → improved

- SMS contains no patient name (check all 5 names) and is ≤ 320 chars

- affectedPatients returns exactly pt-001, pt-002, pt-003

- twilio in preview mode when env vars are missing

## 4. Design: Impiricus-inspired, our own brand

Match the feel of impiricus.com (a physician engagement platform built around SMS) without copying their logo, name or copy.

- Dark navy hero sections: gradient #0A1020 → #0F1A33, white bold headlines, lots of space

- Font: Plus Jakarta Sans via next/font/google (400, 600, 800). Headlines 48 to 64px, weight 800, tight tracking

- Colors: primary electric blue #3B6BFF, glow cyan #22D3EE, danger #F43F5E, success #10B981, light bg #F6F8FC

- Cards: light = white, 16px radius, soft shadow, #E6EAF2 border. Dark = #111A2E with a subtle blue glow border

- Flowing wave SVG divider between the dark hero and light content, slowly animated

- Phone mockups are the signature visual (pure CSS iPhone: dark bezel, dynamic island, status bar with the real current time, iMessage-style bubbles)

- Nav: "Heads Up" wordmark with a lucide BellRing icon. Links: Command Center, Changes, How it works. Right: "Dr. Amina Lee" avatar

- Fully responsive: must look great at 1440px (projector) and 390px (phone)

## 5. P0 pages (the demo)

### / Command Center

Dark hero:

- Headline: "Insurance rules change. Now doctors know."

- Sub: "Heads Up watches plan data and texts you when a change affects your patients."

- 4 count-up stat tiles (computed from the API, show "–" before the first run): Plans watched · Drugs watched · Changes detected · Your patients affected

- Big button: Run watch now

The Gap timeline (the visual core of our pitch). A horizontal line with 3 nodes:① "Plan changes the rule" → ② "Doctor" → ③ "Pharmacy counter".

- Initially: node ② is gray with the label "No notification", and node ③ glows red: "Patient finds out here".

- After the SMS is sent: a blue pulse travels from ① to ②, node ② turns blue: "Alerted by text", node ③ fades to gray: "Before the counter".

- After resolve: node ② turns green: "Resolved".

This animation is the most important visual in the app. Make it beautiful.

Live run panel (after clicking Run watch now): a dark terminal card, monospace, blinking cursor. Call POST /api/watch/run, then reveal each returned step about 600ms apart with a check icon and its timing. Final green line: "Change detected. Alerting Dr. Amina Lee." Then smooth-scroll to the alert section.

Alert + phone, side by side:

Left, the alert card: red badge "Coverage removed", "NovoLog FlexPen", "Kaiser Permanente Senior Advantage Enhanced 1", before → after ("Tier 3 · est. $47.00/mo" → "Not covered"), chip "Source: CMS Sept 2026 file", "3 of your patients affected", buttons View details and Send text to doctor.

Right, the phone mockup on a lock screen. On "Send text to doctor": call /api/notify, show a typing indicator for about 1s, then the SMS bubble slides in with the EXACT body returned. Under the phone: "✓ Delivered to •••• 1234" (sent) or "Preview mode: Twilio not configured" (preview). Optional notification sound, muted by default with a toggle.

Why trust it strip (light section): 3 cards: "Real CMS data" · "No AI decisions" · "No patient names in texts".

The problem strip: the 4 facts from facts.json as big number cards, each with its source as a small link.

### /changes/[id] Change detail (doctor view)

- Header (drug, plan, type badge, "Real CMS data" chip)
- before vs after columns (red/green)
- "What this means" (explanation, caption: "Explanations never decide coverage")
- Evidence (both source files, snapshot dates)
- Your affected patients (names, caption "Synthetic demo patients")
- Action plan checklist: contact patients before the next refill, consider a covered alternative (for insulin show: "No automatic substitute: insulin changes need your clinical judgment"), check manufacturer copay or bridge programs, connect with a reimbursement specialist
- buttons: Prior auth started, Switched medication, Mark reviewed → resolve → green check animation.

### /m/[id] Mobile page (the link inside the SMS)

Phone-first, perfect at 390px: red status header, drug + plan, before/after, 3 big stacked action buttons (same as above), "Resolved ✓" state after tapping. The SMS link points here: ${APP_URL}/m/${id}.

### Demo safety

"Reset demo" in the avatar menu → /api/demo/reset + reload. Every API failure shows a friendly inline error with Retry. Never a blank screen.

## 6. P1

- /changes: table of all changes (search, filter by type, status), rows link to detail

- /how-it-works: a clean 5-step diagram: CMS/insurer data → snapshot → compare → match doctors → SMS → action. Plus an "Integrates with Impiricus" card: "Heads Up can act as a new real-world trigger, routing doctors to copay programs, bridge programs and reimbursement specialists."

- Watch run history under the terminal panel

## 7. P2 (only if everything above works)

- Two-way SMS: /api/sms/inbound Twilio webhook; reply "1" marks the change reviewed and updates the dashboard live (poll every 3s)

- Grok rephrase of the explanation (XAI_API_KEY), template fallback, never patient data

- "Add a watch" form: pick a plan + drug from the snapshot list

## 8. Environment

Create `.env.example`:

```dotenv
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
DOCTOR_PHONE=
APP_URL=http://localhost:3000
XAI_API_KEY=
```

Note in NOTES.md: Twilio trial accounts can only text numbers verified in the Twilio console.

## 9. Demo path: build for this, then run it 3 times

1. Open /. Gap timeline shows "No notification".

2. Run watch now → steps reveal → "Change detected".

3. Alert card: NovoLog dropped from the Kaiser plan (real CMS data).

4. Send text to doctor → SMS slides into the phone mockup, a real phone buzzes, and the gap timeline animates to "Alerted by text".

5. Tap the link on the real phone → /m/[id] → Prior auth started → the desktop dashboard shows Resolved and node ② turns green.

6. Reset demo.

## 10. Definition of done

- [ ] npm test passes, npx tsc --noEmit clean, npm run lint clean, npm run build succeeds

- [ ] The demo path works 3 times in a row, including after Reset

- [ ] Deployed to Vercel with env vars set, and the SMS link opens on a real phone

- [ ] NOTES.md lists assumptions, env setup, and anything not verified
