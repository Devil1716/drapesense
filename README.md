# DrapeSense — Fabric Scanner App

A mobile-friendly web app that lets you scan a fabric swatch with your phone camera
and instantly see fabric type, drape, garment previews, yardage estimates, and
cutting diagrams.

---

## Setup

### 1. Get a Groq API key

Go to [https://console.groq.com/keys](https://console.groq.com/keys), create an
account (free tier available), and generate an API key.

### 2. Create your config file

```bash
cp config.example.js config.js
```

Open `config.js` and paste your Groq key:

```js
const GROQ_API_KEY = "gsk_your_actual_key_here";
```

> **Never commit `config.js`** — it's listed in `.gitignore`.

### 3. Run the app

**Option A — Just open the file (Chrome/Edge, may have camera restriction)**

```bash
open index.html   # macOS
start index.html  # Windows
```

**Option B — Serve with any static server (recommended for camera access)**

```bash
# Python 3
python -m http.server 8080

# Node (npx)
npx serve .

# Then open http://localhost:8080 in your mobile browser (or via local network IP)
```

For phone use, connect phone and laptop to the same Wi‑Fi network, then open
`http://<your-laptop-ip>:8080` in your phone browser.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page app shell |
| `style.css` | All styles (mobile-first) |
| `app.js` | All logic — camera, Groq API calls, UI updates |
| `config.js` | **You create this** — holds your Groq API key |
| `config.example.js` | Template for config.js |
| `pattern-shirt.svg` | Shirt cutting diagram template |
| `pattern-kurta.svg` | Kurta cutting diagram template |
| `pattern-dress.svg` | Dress cutting diagram template |
| `pattern-pants.svg` | Pants cutting diagram template |

---

## API calls (all via Groq)

| Call | Trigger | Model |
|---|---|---|
| Call 1 — Fabric scan | Photo taken | `qwen/qwen3.6-27b` (vision) |
| Call 2 — Fit advice | Silhouette tapped | `qwen/qwen3.6-27b` |
| Call 3 — Yardage estimate | "Estimate fabric needed" clicked | `qwen/qwen3.6-27b` |
| Call 4 — Pattern measurements | "Show cutting diagram" clicked | `qwen/qwen3.6-27b` |

---

## Notes

- Screen 3 and Screen 4 show **standard size reference** measurements, not custom
  measurements for an individual body. Treat them as working guides, not final specs.
- Camera access requires HTTPS or localhost in most mobile browsers.
- No data is stored anywhere. Photos are processed in memory and never uploaded
  to any server other than Groq's API.

## Android APK and GitHub releases

The project includes a Capacitor Android wrapper and a GitHub Actions release workflow.

Install dependencies and generate the Android project locally:

```bash
npm install
npx cap add android
npx cap sync android
```

Build a debug APK on Windows:

```bash
npm run apk:debug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

The workflow runs for tags such as `v1.0.0`, builds the APK, and attaches it to a
GitHub Release. Before creating a release, add the repository secret
`GROQ_API_KEY`; the workflow creates the ignored `config.js` only during the build.

The app checks `Devil1716/drapesense` once at startup and shows a dismissible banner
when a newer release is available. In the Android APK, tapping Update downloads the
APK inside DrapeSense and opens Android's installer directly. Android still requires
the user to confirm the installation; silent self-installation is blocked by Android
unless the app is distributed through Play Store or managed-device tooling. Browser
use keeps a safe fallback that opens the release page.
