WhatsApp Blaster — macOS install (read this first)

1. Drag "WhatsApp Blaster" into the Applications folder shown here.
   Do NOT run it from this disk image — move it to Applications first.

2. Open Terminal and paste this one line, then press Return:

   xattr -dr com.apple.quarantine "/Applications/WhatsApp Blaster.app"

   This app isn't signed with a paid Apple developer certificate, so macOS
   marks it "unidentified" the moment it's downloaded (the quarantine
   flag). The command above removes that flag so the app is allowed to
   open. This is safe — it does not disable any of your Mac's other
   security protections, and it only affects this one app.

3. Open WhatsApp Blaster from Applications or Spotlight. On first launch
   it will ask for Accessibility permission — this is required, since
   that's what lets the app type into WhatsApp on your behalf.

You'll need to repeat step 2 after every update (the "xattr -dr..." line),
since a fresh download gets a fresh quarantine flag each time.

Full instructions: docs/user-guide.md in the project repository, or
https://github.com/harshkawatra11/whatsapp-blaster
