# F2A — CEP install (dev / unsigned)

## Requirements
**After Effects 2022 (22.x) or newer.** The bundled presets and rigs are authored in a
newer After Effects; releases older than 2022 read those files incorrectly, so the panel
refuses to run there with a clear message instead of applying broken effects.

## 1. Enable unsigned extensions (once)
Because this build isn't code-signed, turn on **PlayerDebugMode**.

**Windows** — open Registry Editor, go to
`HKEY_CURRENT_USER\Software\Adobe\CSXS.11`
(also add `CSXS.12` if you're on the newest AE), create a **String value**
named `PlayerDebugMode` = `1`.

**macOS** — Terminal:
```
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

## 2. Copy the folder
Put the whole **`F2A`** folder into the CEP extensions directory:

- **Windows:** `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\F2A`
- **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/F2A`

(You can also use the system-wide `Program Files\Common Files\Adobe\CEP\extensions` on Windows.)

## 3. Launch
Restart After Effects → **Window ▸ Extensions ▸ F2A**.

## 4. Enable scripting access (required)
In After Effects open **Settings/Preferences ▸ Scripting & Expressions** and enable
**"Allow Scripts to Write Files and Access Network"**, then restart AE.
Depth Reveal, Cursor, Gradients, and the Figma bridge all write helper files and launch
the depth engine — with this switch off they silently do nothing.

## Using it
Select the relevant layer(s) in a composition, then click a tool.
Grouped tools (Typing, Text Reveal, Exploder, Cursor, Depth Reveal, Attach Layer, Gradients)
open a popup with their variants.

## Notes
- The panel calls the same logic as the original script — all functions live in
  `host/SaaSKit.jsx`, auto-loaded by the manifest.
- Depth Reveal uses the bundled depth engine exactly as the original script did.
- For a public release you'll want to **sign** the extension (ZXPSignCmd) and ship a `.zxp`.
- Open `client/index.html` in a browser to preview the UI (buttons show a "[preview]" toast
  instead of running, since AE isn't present).

---

## Figma → Shapes module (new)

This build adds an Overlord-style Figma bridge. The panel now runs a local WebSocket
server on **:7867**; a companion Figma plugin ships selected layers to it and they land
as **native shape layers** in the active comp.

### After Effects side
Nothing extra to install — it's inside this extension. The manifest already enables
`--enable-nodejs` and `--mixed-context` (both required). Opening the F2A panel starts
the bridge; the status bar under the toolbar shows **“Bridge running · :7867”** (green dot).
The **Figma ▸ Import from Figma** button also imports a local `.svg` by hand (no plugin needed) —
use it for a first smoke test.

First launch may show a Windows Firewall prompt for After Effects (local port). Allow it.

### Figma side (companion plugin)
1. Figma desktop → Plugins → Development → **Import plugin from manifest…** →
   `F2A/figma-plugin/manifest.json`.
2. Run the plugin. Green dot = it found the AE bridge (panel must be open).
3. Select a frame → **Ship to After Effects**.

### v1 coverage
path / rect (rounded) / circle / ellipse / line / poly, solid fills + strokes, opacity,
nested transforms. Not yet: gradients (mid-gray placeholder), clip paths, filters, text,
embedded images.
