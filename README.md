# Reactivate: AI database reactivation

This tool brings written-off leads back to life. You upload a client's list of dead leads as a CSV. An AI agent texts each lead a short "handraiser" message. When a lead replies, the agent qualifies them and books a callback with the business. If a lead rings the number back, an AI voice agent answers, and it can book the callback too.

- **Multi-client.** Every client has its own leads, campaigns and conversations. A client login only ever sees its own.
- **One shared Twilio number** (+61 485 074 685) sends and receives for every client, both SMS and calls.
- **Two anchors are detected automatically:** (1) the lead replied, (2) a callback was booked.
- **Niche presets** for solar, roofing, mortgages, insurance, car finance, claims, dental, cosmetic surgery, home improvements and ecommerce. You can edit everything per campaign.
- **Demo mode** for sales calls with prospects. A fake lead talks to the real agent, and nothing is sent by SMS.

## How it fits together

```
GitHub Pages (index.html + assets/)          Supabase project vcantdssoketpxaybtwh
  Inbox: Agent | Conversation | Insights  ->   Postgres + row level security + realtime
  Campaigns · Clients · Users · Demo      ->   edge function "reactivation"
                                                 /api            the app
                                                 /cron           send queue (pg_cron, every minute)
Twilio +61 485 074 685                           /twilio/sms     texts in
  SMS in  ------------------------------->       /twilio/status  delivery receipts
  Call in ------------------------------->       /twilio/voice   calls in -> SIP -> OpenAI Realtime
OpenAI Realtime (SIP) ------------------->       /openai/call    accepts the call, runs the voice agent
```

**How one number serves every client.** When a text or call comes in, the system matches the sender's phone number against the uploaded leads:

- If the number belongs to one client's lead, it goes to that lead.
- If the same number is a lead for several clients, it goes to whichever client texted it most recently.
- If none of those clients has texted it yet, it is dropped, because guessing could put it in the wrong client's account.
- Numbers that aren't in the system are ignored: texts get no reply, and calls are rejected.

This logic lives in one database function, `route_inbound_phone`. Client users can't call it.

**The callback is always made by the business.** The AI never makes calls. It agrees a time with the lead, the server checks that time against the client's callback hours and any other bookings, and then alerts the client by SMS and/or email.

**STOP.** A reply of STOP (or "unsubscribe", "stop texting me" and so on) opts that phone number out of the shared number for good, for every client. Future uploads skip that number, and nothing can be sent to it again.

## Setup

### 1. Database

In the Supabase dashboard, open **SQL Editor** and run these files in order:

1. `supabase/migrations/001_schema.sql`
2. `supabase/migrations/002_niche_presets.sql`

You can re-run `002` any time to refresh the presets. Existing campaigns aren't affected, because each campaign keeps its own copy of its script.

### 2. Auth

1. Under **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**. Only admins add users.
2. Under **Authentication → URL Configuration**, set the **Site URL** to the app's address (your custom domain) and add it to **Redirect URLs**.
3. Create yourself an account under **Authentication → Users → Add user** (tick auto-confirm). Then make it an admin in the SQL Editor:

   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```

### 3. Edge function

1. Under **Edge Functions → Deploy a new function → Via editor**, name it `reactivation`.
2. Paste in `supabase/functions/reactivation/index.ts` and deploy.
3. In the function's **Details** tab, turn off **Enforce JWT verification**. Twilio, OpenAI and the cron job can't send a Supabase login token, so the function checks every caller itself.
4. Under **Edge Functions → Secrets**, add:

| Secret | Value |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI key |
| `TWILIO_ACCOUNT_SID` | From the Twilio console |
| `TWILIO_AUTH_TOKEN` | From the Twilio console |
| `TWILIO_NUMBER` | `+61485074685` |
| `CRON_SECRET` | Any long random string |
| `SIP_HEADER_SECRET` | Any long random string (different from the one above) |
| `OPENAI_PROJECT_ID` | `proj_...` (OpenAI → Settings → Project → General) |
| `OPENAI_WEBHOOK_SECRET` | `whsec_...` (from step 6) |
| `APP_URL` | The app's address, e.g. `https://reactivate.yourdomain.com` |
| `RESEND_API_KEY` / `NOTIFY_FROM_EMAIL` | Optional. Turns on the "callback booked" emails |
| `OPENAI_MODEL` | Optional, default `gpt-5-mini` |
| `OPENAI_REALTIME_MODEL` | Optional, default `gpt-realtime` |

### 4. Send queue

Open `supabase/migrations/003_send_queue_cron.sql`, replace `REPLACE_WITH_CRON_SECRET` with your `CRON_SECRET`, and run it. Every minute it texts the next batch of queued leads. A batch only goes out inside the campaign's sending window (in the client's timezone), at that campaign's texts-per-minute rate, and never more than 30 a minute in total.

### 5. Twilio

Go to **Phone Numbers → Active numbers → +61 485 074 685**:

- **Messaging → A message comes in:** Webhook, `https://vcantdssoketpxaybtwh.supabase.co/functions/v1/reactivation/twilio/sms`, HTTP POST
- **Voice → A call comes in:** Webhook, `https://vcantdssoketpxaybtwh.supabase.co/functions/v1/reactivation/twilio/voice`, HTTP POST

Every request is checked against your Twilio auth token, so the URLs must match these exactly.

### 6. OpenAI (inbound calls)

Go to **platform.openai.com → Settings → Project → Webhooks → Create**:

- **URL:** `https://vcantdssoketpxaybtwh.supabase.co/functions/v1/reactivation/openai/call`
- **Event:** `realtime.call.incoming`

Copy the signing secret into `OPENAI_WEBHOOK_SECRET`.

Here's what happens on a call. Twilio answers, the function checks that the caller is a known lead, and Twilio forwards the call over SIP to OpenAI. The forwarded call carries a signed reference to that lead. OpenAI then calls the webhook, the function checks the signature, and it accepts the call with that client's script and voice. While the call runs, the function saves the transcript and carries out the agent's actions (booking the callback, saving answers). When the call ends, it refreshes the lead's insights.

### 7. Frontend (GitHub Pages)

1. Under **Settings → Pages**, choose **Deploy from a branch**, then `main` and `/ (root)`.
2. For a custom domain, enter it under **Custom domain**. GitHub adds a `CNAME` file. Point a CNAME DNS record at `<user>.github.io`.
3. Add the same address to the Supabase redirect URLs (step 2) and to `APP_URL`.

`assets/config.js` holds the Supabase URL and the anon key. Both are meant to be public: row level security decides what each login can read.

## Using it

1. **Clients:** add the business, its timezone, its callback hours, and where callback alerts go.
2. **Campaigns → New campaign:** pick the client and a niche preset, then adjust the script. That covers the agent's name, tone, handraiser messages, qualifying questions, disqualifiers and compliance rules. A live preview shows the exact first text.
3. **Upload CSV:** column matching is automatic for common headers and you can change it. Only a phone column is required. Any other columns are kept as extra details the agent can see.
4. **Launch:** leads are queued and texted during the sending window.
5. **Inbox:**
   - On desktop, the left panel shows the agent, its live state (idle, writing a reply, or on a call) and the lead list. The middle shows the conversation, with the anchors marked in the timeline. The right shows insights and actions: anchors, the callback, qualification answers, the summary, the next action, a pause/resume switch for the AI, manual booking, and status changes.
   - On a phone, the same three panels become tabs.
6. **Users:** add client logins. A client user sees only their own business. Typing in a conversation as a team member pauses the AI for that lead.

### Demo mode

As an admin, click **New demo** and pick a niche, the prospect's business name, the agent name and the lead's name. A fake lead is created under a separate "Demo" client, and the handraiser appears straight away. Type the lead's replies, and the agent answers through OpenAI just as it would by SMS. It qualifies the lead, books a callback, and the anchors and insights update live. Nothing touches Twilio. **Demo mode** switches the whole app between real and demo data, and **Restart this demo** clears the conversation so you can run it again.

## Limits and notes

- **Voice transcript length.** The process that saves the call transcript and carries out bookings runs inside the edge function. It lasts up to 150 seconds on Supabase's free plan, or 400 seconds on a paid plan (set `SIDEBAND_MAX_MS` to match). The call itself continues past that, but anything said or booked after that point isn't saved. If long calls turn out to be common, move that one piece to a small always-on server.
- **Compliance (Spam Act).** Only upload people who enquired with the client. Keep the opt-out line in the handraiser; the editor won't save a campaign without one.
- **Supabase's built-in email** only sends a few invite emails an hour. Either give new users a password when adding them, or set up custom SMTP in Supabase.
- **Failed sends.** If the send queue crashes partway through a batch, those leads stay marked as "sending". Set them back to `queued` to retry.
