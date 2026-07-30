# RYS WhatsApp Blaster — documentation

A bulk WhatsApp invite tool for Rajdhani Yuva Sansad (RYS), built for a non-technical
operator to send a personalised message to a CSV list of participants by driving the real
WhatsApp Desktop app.

## Start here

- **Just want to use the app?** → [user-guide.md](user-guide.md)
- **Sending numbers, pacing, what to do if one gets flagged?** → [operations.md](operations.md)
- **Working on the code — architecture, data model, HTTP API?** → [architecture.md](architecture.md)
- **Why is it built this way? What was tried and abandoned?** → [decisions.md](decisions.md)

## In one paragraph

The app is an Electron desktop app wrapping a local Express server and a local SQLite
database — nothing leaves the machine except the WhatsApp messages themselves. It does not
log in to WhatsApp itself; instead it drives the WhatsApp Desktop Windows app directly via
keyboard automation (PowerShell + Win32), because that app publishes nothing to Windows UI
Automation and offers no other integration point. Every send is reported as **Submitted**,
never **Delivered** — that distinction is deliberate and explained in
[user-guide.md](user-guide.md#what-submitted-actually-means).
