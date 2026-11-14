# WME Street View Road Assistant

A manual assistance tool for Waze Map Editors. This script proposes draft segments over Street View coverage gaps. It is designed to assist a human editor, not to mass-edit: **the tool proposes, the editor decides.**

Every draft must be reviewed, aligned to the road centerline, and confirmed against the latest satellite imagery before using WME's native **Save**. **Nothing is ever saved automatically, and no existing road is modified.**

## 🚀 Key Features

- **Street View Coverage Scanning:** Scans the current map viewport for Street View coverage and detects gaps where roads might exist but are not mapped.
- **Smart Rescan (Respects Manual Edits):** If you manually draw, extend, or connect a road in WME, the script's **Rescan** feature detects this. It dynamically clears old, invalid candidates in the viewport and rebuilds fresh ones based purely on the current map state.
- **WME Suggestions Import:** Pulls in "Edit Suggestions" (Task Layer) from WME directly into the candidate list.
- **Junction Splitting:** Automatically splits long candidate segments at junction points, respecting local editing standards.
- **Flow & Direction:** Attempts to automatically determine the A-to-B flow of the road based on connected segments. You can manually flip the direction (A/B) or toggle between 2-way (2W) and 1-way (1W) before converting.
- **Safety First (Undo Guard):**
  - The script will **never** save your edits. You must press WME's native Save button.
  - If you click "Convert", it creates *draft* segments.
  - If you try to remove a draft, the script uses WME's native undo stack, but it will **refuse to undo** if you've made other manual edits since creating the draft, protecting you from accidentally losing work.

## 🛠️ How to Use

1. **Zoom In:** Zoom into the map to level 16 or higher (the script will warn you if you are zoomed out too far).
2. **Scan:** Click the **Scan** button in the "SV Roads" sidebar tab. The script will fetch Street View tiles and draw orange/pink candidate lines over coverage gaps.
3. **Review Candidates:**
   - Use the **Street View** button to toggle the coverage layer.
   - Use the **Guide** button to see exactly which map frame is being scanned.
4. **Adjust:**
   - Click a candidate line on the map or tick the checkbox in the sidebar.
   - Use the `⇄` button to flip the A/B node flow.
   - Use the `2W / 1W` button to toggle one-way status.
5. **Convert:** Press **Convert**. The script will turn your ticked candidates into draft segments in WME.
6. **Review & Save:** The drafts are *not* connected to roads yet. You must align them, connect them to existing junctions, and then press **WME's native Save button**.

## 🧠 The "Rescan" Workflow

When you click **Scan** or **Import SUG**:

1. The script takes a snapshot of the current map viewport.
2. It identifies any existing candidates in the frame.
3. It **deletes** those old candidates from the script's internal state.
4. It builds brand-new candidates based on the exact roads and gaps currently visible.

*If you manually extend a road to cover a gap, the next time you hit "Scan", the script will see your new road and will no longer generate a candidate there. It also preserves your ticked checkboxes and 1W/2W settings if the refreshed candidate matches the old one.*

## ⚠️ Editing Rules & Guardrails

- **Manual Review is Mandatory:** Generated geometry comes from tracing Street View coverage gaps. It is **not** final. You must align it to the actual road centerline and verify against satellite imagery.
- **Unsaved Edit Reminder:** The script defaults to reminding you when you reach **30 unsaved edits** (customizable in settings). It will not stop you, but it is highly recommended to save frequently to prevent WME from timing out or rejecting the save.
- **Undo Protection:** If you try to remove a generated segment, the script will check WME's pending edit count. If other edits were made after the draft was created, it will refuse to undo it automatically to protect your other work. You will need to press `Ctrl+Z` in WME manually.

## ⚙️ Settings

- **Detection Radius:** How far away to look for existing roads when determining a gap.
- **Min Candidate Length:** Ignore tiny gaps under this length.
- **Drafts per sub-batch:** How many segments to create before pausing (helps prevent WME from lagging).
- **Road Preset:** The road type to assign to the generated drafts (e.g., Street, Primary, etc.).

## 📦 Installation

1. Install a userscript manager like [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Create a new script.
3. Copy the contents of `WME-Street-View-Road-Assistant.user.js` into the script editor.
4. Save and navigate to the [Waze Map Editor](https://www.waze.com/editor).

## 🛡️ License

MIT License. See `LICENSE` for details.
*This script is not affiliated with or endorsed by Waze or Google.*
