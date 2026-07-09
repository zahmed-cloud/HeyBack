The downloadable zip file goes here.

Build it with this command (run from terminal):

cd /Users/jamilahmed/HeyBack && zip -r landing/downloads/heyback-v1.zip manifest.json background.js content.js popup.html popup.css popup.js icons/ -x '*.DS_Store'

This packages only the extension files (no landing page, no docs) into a zip
that users can download and sideload into Chrome/Brave/Edge.

After building, verify the zip contains:
  manifest.json
  background.js
  content.js
  popup.html
  popup.css
  popup.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
