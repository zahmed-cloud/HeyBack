# HeyBack

Free Chrome extension that auto-sends a welcome DM to every new Instagram follower. Set your messages, pick a daily limit, flip it on, forget about it. Checks every 3 minutes, sends like a human, never messages the same person twice. Built by ahmed in a weekend.

## Install (2 minutes)

1. Download the zip from the [landing page](https://zahmed-cloud.github.io/HeyBack/) or clone this repo
2. Open `chrome://extensions` in Chrome, Brave, or Edge
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the folder
5. Click the HeyBack icon in your toolbar
6. Add your welcome messages (one per line), set a daily limit, flip the toggle ON
7. Keep an Instagram tab open. That's it.

## How it works

Every 3 minutes, HeyBack checks for new followers using Instagram's notifications feed and followers API. When it finds someone new, it navigates to their profile, clicks the Message button, types your message character-by-character with human-like delays, and clicks send. After sending, it immediately navigates back to your home feed and waits before the next send.

Before sending, it checks if a DM thread already exists with that person. If you've already messaged them (manually or via the bot), it skips them. Only the first message ever gets sent. On first install, all your existing followers are marked as "seen" so nobody gets spammed retroactively.

## Features

- Checks every 3 minutes for new followers
- Sends via profile page (clicks Message button, types, sends)
- Character-by-character typing with random delays
- Never sends a second message to anyone
- Checks existing DM threads before sending
- Random message rotation from your list
- Daily limit with hard ceiling of 30
- 45-90 second delay between sends
- Auto-pauses if Instagram shows rate limit warnings
- Goes back to home feed after each send
- Zero data collected, everything runs locally

## Risks

- Instagram doesn't officially allow automation. Use at your own risk.
- We recommend using a secondary account.
- No updates promised. Instagram changes their site regularly. When they do, this might break.
- Keep daily limits low. Start at 10-15.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

See [DISCLAIMER.md](DISCLAIMER.md). By using this software, you accept full responsibility.

---

Built by ahmed. Free forever. Contributions welcome.
