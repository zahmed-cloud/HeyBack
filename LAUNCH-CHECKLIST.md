# Launch Checklist

Run through every item before going public.

## Pre-launch testing

- [ ] Test extension on a fresh Chrome profile (not your dev profile)
- [ ] Verify a real DM delivers to a real inbox (use "Test send to yourself")
- [ ] Verify the same person does NOT get re-DMd on next cycle (check seenFollowers)
- [ ] Verify daily limit is enforced (set to 1, send 1, confirm it stops)
- [ ] Verify "Simulate full auto flow" completes end-to-end

## Landing page

- [ ] Open `/landing/index.html` in browser — verify it renders correctly
- [ ] Check mobile view (Chrome DevTools → toggle device toolbar)
- [ ] Verify download link points to `downloads/heyback-v1.zip`
- [ ] Verify no real names, emails, or brand references appear anywhere

## Build the zip

- [ ] Run: `cd /Users/jamilahmed/HeyBack && zip -r landing/downloads/heyback-v1.zip manifest.json background.js content.js popup.html popup.css popup.js icons/ -x '*.DS_Store'`
- [ ] Verify zip contains all 9 files (manifest + 3 js + 2 popup + 3 icons)
- [ ] Test: unzip in a new folder, load unpacked in Chrome, verify it works

## Domain and hosting

- [ ] Pick a domain NOT tied to your real brand (e.g. heyback.io, gethb.co)
- [ ] Deploy `/landing/` folder to Netlify or Vercel (free tier, drag-and-drop)
- [ ] Verify the live site loads and download link works

## GitHub

- [ ] Create a NEW GitHub account or org (not your main)
- [ ] Create public repo, push the HeyBack folder
- [ ] Verify README.md, LICENSE, and DISCLAIMER.md are visible
- [ ] Update the GitHub link in landing/index.html footer to match your actual repo URL

## Distribution (optional)

- [ ] Post to r/chrome_extensions
- [ ] Post to Indie Hackers
- [ ] Post to Hacker News (Show HN)
- [ ] Post to Product Hunt
- [ ] Post to relevant Discord servers / Telegram groups

## Safety reminders

- [ ] Do NOT link this from Ascent, WealthOS, or any real brand
- [ ] Do NOT tweet from your main account
- [ ] Use a separate email for any inquiries (protonmail, tutanota)
- [ ] Do NOT promise updates, support, or uptime
- [ ] Do NOT claim it's "safe" or "undetectable"
