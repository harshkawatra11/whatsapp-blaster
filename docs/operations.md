# Operations: sending safely

This app drives the real WhatsApp Desktop app, so to WhatsApp every message looks like it
came from you. That's also why a WhatsApp number can get restricted or banned if it sends
like a machine. Since v1.6.0 the app tries hard not to. **No setting makes a number
ban-proof**, though. Read the "What actually gets numbers banned" section below.

## Sending speed (⚙ Settings)

Click ⚙ in the header and pick one of three speeds. The choice applies from the next run.

| Speed | Gap between messages | Break | Daily cap | Hourly cap |
|---|---|---|---|---|
| Cautious | random 45–120 s | 5–15 min every 6–10 messages | 100 | 25 |
| **Balanced** (default) | random 20–60 s | 3–8 min every 8–15 messages | 150 | 40 |
| Fast | random 8–25 s | 2–4 min every 15–25 messages | 200 | none |

As a rough guide, Balanced gets through about 45–60 messages an hour, so 150 people take
about 3–4 hours. Caps count every message this sender submitted across all campaigns in the
last 24 hours / 60 minutes. When the hourly cap is reached the run **waits** and carries
on by itself. When the daily cap is reached, the remaining rows are skipped (send them
tomorrow with **Retry failed** or **Send another batch**).

## What the app does to look human

- **Random gaps and breaks.** No two gaps are the same, and the break interval changes
  after every break, so there's no fixed rhythm.
- **Typed greeting.** The first line of the message (e.g. "Hi Priya,") is typed key by key
  at a human pace, the blank lines after it are typed too, and the rest is pasted. If the
  first line has emoji or non-English letters, the whole message is pasted instead, because
  key-by-key typing can't reproduce those reliably.
- **Phone numbers typed digit by digit**, with uneven gaps.
- **Jittered timing.** Every internal wait is randomly 0–40% longer than its minimum.
- **A pause before typing and before sending**, like someone glancing at the chat and
  re-reading the message.
- **Hi / Hello variation.** If your message starts with "Hi" or "Hello", the app alternates
  between the two, so the run isn't one identical message copied hundreds of times.

## Pause, Resume, Abort

- **Pause** stops the run from starting anything new, and freezes the countdown to the next
  message. If a message is mid-way, it finishes first. You can use your computer while paused.
- **Resume** brings WhatsApp back to the front and carries on.
- **Abort** ends the run. Rows not reached are marked skipped.

## What actually gets numbers banned

Pacing helps, but WhatsApp's main signals are about the *people you message*:

- **Recipients blocking or reporting you** is the biggest factor by far. Message people who
  expect to hear from you (e.g. they registered for the event), and say who you are in
  the first line.
- **Cold contacts.** A list of people who have never messaged this number is riskier.
  Use Cautious for those, and consider asking people to save your number or message you first.
- **New numbers.** See warm-up below.
- **Replies are good.** Messages that start conversations look like normal use, so invite a reply.

## Warming up a new number

- Use it normally for a few days first, with regular 1:1 chats, not just as a send-only number.
- Day one: a few dozen messages on **Cautious**, not a full list.
- Increase gradually over a week or two before using Balanced.

## Safe-batch practice

- Split very large lists across several days, even if the cap would allow one long run.
- Watch WhatsApp Desktop during a run. If you see a warning, a logout, or messages not
  sending, press **Abort** immediately.
- Don't change the speed to Fast to "catch up" on a number that has had any warning.

## If a number gets flagged or banned

- Stop sending from it immediately. Don't retry expecting the ban to lift on its own.
- Restrictions are either temporary (often 24–72 hours with no further violations) or a
  permanent ban. There's no way to know in advance which one applies.
- Use a different number for the next campaign, and warm it up as a new number.
- Use Cautious on any number that has ever had a flag, even after it lifts.
