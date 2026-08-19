-- Standalone version of mac-inspect-newchat.js — no Node/repo needed, just
-- Terminal and macOS's own osascript. Run this whole file directly:
--   osascript scripts/mac-inspect-newchat.applescript
-- or paste it into Terminal via the heredoc form in docs (no file needed
-- on a machine that only has the installed .app, not the repo).

set bundleId to "net.whatsapp.WhatsApp"

if not (application id bundleId is running) then
  return "WhatsApp is not running. Open it and sign in first."
end if

tell application id bundleId to activate
delay 0.5
tell application "System Events" to keystroke "n" using command down
delay 1.2

set fullOutput to ""

tell application "System Events"
  tell (first process whose bundle identifier is bundleId)
    repeat with winIndex from 1 to 2
      set fullOutput to fullOutput & "--- window " & winIndex & " ---" & linefeed
      set winExists to false
      try
        if (count of windows) >= winIndex then set winExists to true
      end try
      if not winExists then
        set fullOutput to fullOutput & "(no such window)" & linefeed & linefeed
      else
        try
          set allEls to entire contents of window winIndex
          set n to count of allEls
          set fullOutput to fullOutput & n & " total elements" & linefeed & linefeed
          repeat with el in allEls
            set oneLine to ""
            try
              set oneLine to oneLine & "class=" & (class of el as string)
            end try
            try
              set oneLine to oneLine & " role=" & (role description of el)
            end try
            try
              set oneLine to oneLine & " subrole=" & (subrole of el)
            end try
            try
              set oneLine to oneLine & " name=" & (name of el)
            end try
            try
              set oneLine to oneLine & " desc=" & (description of el)
            end try
            try
              set oneLine to oneLine & " title=" & (title of el)
            end try
            try
              set v to value of el as string
              if (length of v) > 40 then set v to (text 1 thru 40 of v) & "..."
              set oneLine to oneLine & " value=\"" & v & "\""
            end try
            try
              set oneLine to oneLine & " focused=" & (focused of el)
            end try
            try
              set oneLine to oneLine & " enabled=" & (enabled of el)
            end try
            set fullOutput to fullOutput & oneLine & linefeed
          end repeat
        on error errMsg
          set fullOutput to fullOutput & "(error reading window " & winIndex & ": " & errMsg & ")" & linefeed
        end try
        set fullOutput to fullOutput & linefeed
      end if
    end repeat
  end tell
end tell

return fullOutput
