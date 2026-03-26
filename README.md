# Image Collector 2

Image Collector 2 is a cross-platform local web app for two jobs:

- Download up to 75 images from up to 6 exact page URLs
- Extract one clean square logo PNG from up to 8 client website URLs

The app runs on your computer, opens in the browser, and saves results into timestamped folders.

## Requirements

- Windows 10 or newer, or macOS
- Node.js 18 or newer
- Google Chrome or Microsoft Edge installed

## Quick Start

```bash
git clone https://github.com/creaitivelearning/image_collector_2.git
cd image_collector_2
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Double-Click Launch

- macOS: double-click `Launch Image Collector 2 for Mac.command` or `Launch Image Collector 2.command`
- Windows: double-click `Launch Image Collector 2 for Windows.bat` or `Launch Image Collector 2.bat`

Each launcher installs dependencies if needed, starts the local server, and opens the app in your browser.

Important: `.command` is a macOS launcher. On Windows, that file will open an "which app do you want to use?" prompt because it is not a Windows executable script. On Windows, use the `.bat` launcher instead.

## Where Files Are Saved

- Image mode saves images to `<Desktop>/<domain>/<timestamp>/`
- Logo PNG mode saves files to `<Desktop>/client-logos/<timestamp>/`

On Windows, the app also checks common OneDrive Desktop locations automatically. If no Desktop folder is available, it falls back to your home folder.

## Browser Fallback

For tougher pages such as Google and GBP-style results, the app uses Playwright with an installed Chromium-based browser. It will try:

- `IMAGE_COLLECTOR_BROWSER_PATH` if you set it
- Google Chrome
- Microsoft Edge
- Playwright's default browser resolution

If you want to save files somewhere else, set `IMAGE_COLLECTOR_OUTPUT_DIR` before starting the app.

## Notes

- Image mode accepts up to 6 URLs and downloads up to 75 images total.
- Logo PNG mode accepts up to 8 URLs and may take longer on the first run.
- The first run can be slower while dependencies finish installing.

## Tests

```bash
npm test
```
