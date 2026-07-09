# HeyBack

Chrome extension that auto-sends a welcome DM to every new Instagram follower. You set 3-5 messages, pick a daily limit, flip it on, and forget about it. It checks for new followers every 20 minutes while your Instagram tab is open, types the message character-by-character like a real person, and never DMs the same follower twice.

## Install (2 minutes)

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome, Brave, or Edge
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select this folder
5. Click the HeyBack icon in your toolbar
6. Add your welcome messages (one per line), set a daily limit, flip the toggle ON
7. Keep an Instagram tab open. That's it.

## How it works

HeyBack runs as a content script on `instagram.com`. Every 20 minutes, the background service worker fires an alarm. The content script fetches your followers list via Instagram's internal API, diffs against a stored "seen" list, and identifies new followers. For each new follower, it navigates to Instagram's DM compose page, types the username into the search box using native browser events (so React picks it up), selects the user from the dropdown, types your message into the composer via `document.execCommand`, and clicks send. It then verifies the message appeared in the thread before marking the follower as seen.

On first install, all existing followers are marked as seen so nobody gets spammed retroactively.

## Risks and honest disclaimer

- **Instagram doesn't officially allow automation.** This extension violates their Terms of Service.
- **Your account might get action-blocked or banned.** Use a secondary/burner account, not your main.
- **No data is collected.** Everything runs locally in your browser. No server, no analytics, no tracking.
- **No updates promised.** Instagram changes their website regularly. When they do, this tool might break. It might get fixed. It might not.
- **Keep daily limits low.** Start at 10-15. Instagram flags accounts that send too many DMs too fast.
- **No warranty.** Software is provided as-is. See LICENSE and DISCLAIMER.md.

## Safety features built in

- Random 45-90 second delay between each DM
- Absolute ceiling of 30 DMs per day (hardcoded, can't override)
- Auto-pause for 24 hours if Instagram shows "action blocked"
- Auto-pause for 12 hours if Instagram's UI changes break the selectors
- Character-by-character typing with human-like timing
- Safety warning shown on first enable

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

See [DISCLAIMER.md](DISCLAIMER.md). By using this software, you accept full responsibility for any consequences.

---

Not affiliated with Instagram or Meta. Contributions welcome, no promises on merges.
