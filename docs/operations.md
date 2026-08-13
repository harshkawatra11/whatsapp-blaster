# Operations — sending safely

This app can send far faster than a human ever would, which is exactly what puts a WhatsApp
number at risk of being flagged or banned. Nothing in the app stops you from sending faster
than recommended here — the pacing settings are deliberately uncapped — but going faster is
a real risk, not just a suggestion being cautious for no reason.

**As of the current default, the inter-recipient delay is 0s** (changed from a randomised
8-20s gap at explicit operator request, to cut per-recipient time down to roughly the ~8s the
automation itself takes). This is a real reduction in anti-ban protection, not just a speed
tweak — a fixed, back-to-back sending rhythm is closer to what an automated sender looks
like than a randomised one. If a number gets flagged, raising the min/max delay in Settings
back up is the first thing to try.

## The settings that matter

All of these live in Step 1's Settings, editable any time (mid-run changes apply to the
*next* run, not the one in progress):

| Setting | Default | What it does |
|---|---|---|
| Min / max delay between sends | 0s / 0s | A random gap in this range before every send, on top of the ~8s the automation itself already takes per recipient (open chat, paste, verify, send). **Set to zero at explicit operator request** to remove that added wait — every send now moves to the next recipient the instant the previous one finishes. This was the app's main defence against looking automated; raising it back is just a Settings-panel edit. |
| Batch size | 50 | After this many sends, the app takes a longer pause (2-4 minutes, randomised) before continuing. |
| Daily cap | 200 | Hard stop — once this many messages have gone out from a sender number in the last 24 hours, the run skips every remaining recipient rather than continuing. |
| Default country code | 91 | Applied to any bare 10-digit phone number in an uploaded CSV. |

## Warming up a new number

A WhatsApp number with no send history is more sensitive to bulk activity than one with an
established pattern of normal use. Before a first real campaign on a new number:

- Use it normally for a few days first — regular 1:1 chats, not just as a send-only number.
- Start with a small batch (a few dozen, not a few hundred) on day one.
- Increase gradually over several days rather than jumping straight to a full campaign.
- Prefer the default pacing (or slower) for the first real campaign on any new number.

## Safe-batch practice

- **Slower is genuinely safer.** If you're not in a hurry, raise the min/max delay rather
  than lowering it.
- **Split very large lists across multiple days** rather than one long run, even if the
  daily cap would technically allow it in one sitting.
- **Watch WhatsApp Desktop itself while a run is going** — if you see anything unusual (a
  warning banner, being logged out, messages not appearing to send from the app's own UI),
  stop the run immediately via Abort rather than letting it continue.
- **A recipient list built from cold contacts** (people who don't know you and haven't
  messaged you before) is riskier than a list of people who've previously interacted with
  this number. If a campaign is going to a mostly-cold list, treat the pacing above as a
  floor, not a target.

## If a number gets flagged or banned

- Stop sending from it immediately — don't retry with the same number expecting the ban to
  lift on its own.
- WhatsApp bans usually come with either a temporary restriction (limits lift after a wait,
  often 24-72 hours with no further violations) or a permanent ban with no recovery path.
  There's no way to know in advance which one applies from outside WhatsApp itself.
- Register a different number for the sender list before your next campaign, and treat it as
  a brand-new number needing warm-up (see above) — don't assume the previous number's
  history transfers.
- Reduce pacing (slower delays, smaller batches) for future campaigns on any number that's
  had a prior flag, even after a temporary restriction lifts.

## Daily cap guidance

The default (200/day) is a starting point, not a researched safe maximum — there is no
single number that's safe for every WhatsApp account, since it depends heavily on account
age, prior activity, and how "cold" the recipient list is. As a rough guide:

- A brand-new or lightly-used number: stay well under the default, especially in the first
  couple of weeks.
- An established number with normal daily use: the default is a reasonable middle ground.
- Raising the cap is easy (it's just a setting) — but raise it gradually between campaigns,
  not all at once for a single big push, and watch how the number behaves afterward before
  raising it again.
