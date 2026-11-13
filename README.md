# WME Street View Road Assistant

A manual-assistance userscript for the Waze Map Editor (WME). It proposes draft road segments over places where Street View coverage exists but no Waze segment is mapped. You review every draft, align it to the real road, and save it yourself.

**Status: 1.0.0 beta.** Not audited by the Waze editing community. Use at your own risk.

Built to assist a human editor, not to mass-edit: the tool proposes, the editor decides. It is not an automated editor, and it is not endorsed or approved by Waze. Before using it, read the official [Guidelines for Bulk Editing Scripts](https://www.waze.com/discuss/t/guidelines-for-bulk-editing-scripts/407412) and your local community's rules.

## What it does

- Scans the current map view for Street View coverage that has no mapped Waze segment nearby.
- Traces candidate lines from that coverage and lists them in a table.
- Splits candidates at existing junctions and flags A/B direction "seams" where a draft meets a mapped road.
- Imports WME segment suggestions as candidates, so flagged missing roads go through the same review flow.
- On **Convert** (a click from you), creates the ticked candidates as new draft segments in WME.

## What it never does

- It never saves. Drafts stay pending until you press WME's own Save button.
- It never edits, deletes or moves existing segments, junctions or turn restrictions.
- It never connects drafts to existing roads. You connect them by hand.

## How candidate shapes are made (please read)

The script requests Street View coverage tiles from `mts*.google.com` and derives candidate line shapes from the coverage pixels. The shapes are only a starting guess, and they can be offset, cut short, or wrong.

- Treat every draft as unverified. Align it to the real road centerline using satellite imagery or other sources you are allowed to use, then verify it before saving.
- Do not rely on the draft geometry as it is.
- The tile endpoint is unofficial and may change or stop working without notice. If it does, the script cannot detect coverage.
- Check your local Waze community's rules on external reference sources before using or sharing this script.

## Requirements

- Tampermonkey or a compatible userscript manager.
- Access to the Waze Map Editor.

## Install

1. Install Tampermonkey or a compatible userscript manager.
2. **[Click here to install WME Street View Road Assistant](https://raw.githubusercontent.com/dinkaftac/wme-sv-road-assistant/main/wme-sv-road-assistant.user.js)** and confirm the installation.
3. Reload WME.

**Updates:** your userscript manager checks this repository automatically (Tampermonkey about once a day by default) and offers the new version when the `@version` number goes up. You can also run "Check for userscript updates" in Tampermonkey. The script is not on Greasyfork. If you paste new code into the Tampermonkey editor by hand, press Ctrl+A first, so the new version does not end up pasted inside the old one.

*If you installed an earlier copy, reinstall once with the link above to get automatic updates.*

## Workflow: Scan → Convert → Edit → Save

1. Zoom in to level 16 or higher and click **Scan**.
2. Tick the candidates you want.
3. Click **Convert**. One click converts up to the "Drafts per convert click" limit.
4. For each draft: align it to the road centerline, verify it, connect it to the road network yourself, then press WME's **Save**.
5. Scan again, or repeat from step 2. You can also scan, convert and edit first, and save once you have finished a pass.

### How Convert works

- **Nearest first.** Candidates already on screen are converted first, without moving the map. The rest follow, nearest to your starting view first.
- **Sub-batches.** A click is processed in silent sub-batches (1 draft by default) until the per-click cap is reached. This keeps WME's data loading ahead of the conversion.
- **Waits for the map to load.** Before creating drafts in an area, the script waits until the candidate is inside the view and WME has sent no map-data update for the "Wait for map tiles" time (an empty area is fine). Creating a segment before that can turn it into a suggested edit sent for review. A candidate longer than the view is handled by visiting both ends first.
- **Never stops early.** If the tiles around one candidate are not confirmed after a second, longer wait, that candidate is skipped and stays ticked. The rest of the click carries on, and the final message names the skipped candidates so you can press Convert again.
- **Checks WME kept the drafts.** After each sub-batch the script confirms every draft still exists. If WME silently dropped one ("That change isn't allowed at this time"), the candidate returns to the list, unticked, tagged "WME rejected this draft". One refused draft never stops the rest.
- **Returns to where you were.** After the last draft the script pauses for 2 seconds so you can see it, then snaps the map back to your starting view.
- **Road type validated.** The Road type preset is checked against the list WME reports for your account. If the chosen preset's road type is not in that list (for example, on a WME build where road type IDs changed), the script logs a warning and falls back to Street, so a draft is never created with a road type WME would reject.

### After conversion

- A converted candidate becomes a WME draft segment and disappears from the candidate layer at once. Its internal state changes from Candidate to Drafted.
- Scanning again over the same area does not propose it again.
- If you undo the draft segment in WME, the candidate comes back in the list.

### Undo

Use **Remove** on a converted draft, or Ctrl+Z in WME while the drafts are still unsaved. Ctrl+Z in the panel undoes a flip or 1W/2W change first, then clears ticks when WME has nothing left to undo. Remove undoes drafts newest-first and refuses if other edits were made after them, so nothing else is lost.

## Import WME suggestions

WME lets editors flag missing roads as suggestions. The script can import those OPEN suggestions as candidates, so they go through the same Scan-like → Convert → Save workflow.

- The import enables WME's **Edit Suggestions** layer for the duration of the import, then restores whatever state it was in before. If the layer was on before the import it stays on; if it was off it goes back to off. Your own on/off choice is never overridden.
- Only suggestions marked OPEN, with no attached segment, and whose geometry is inside the viewport are imported.
- Suggestions already covered by a candidate or a mapped road are merged or skipped.
- If the layer was off before the import, the script briefly waits for WME to actually deliver suggestion data before reading it, so the first import after a fresh zoom isn't empty.
- The **Import SUG** button shows the busy "Importing… ●" style for exactly the duration of the import.

Import is independent of Scan. Scan works on coverage gaps, Import works on WME suggestions, and neither requires the other.

## Reminders (never blocking)

All reminders are friendly checkpoints shown as a dismissible box at the top of the panel. They advise the editor and never stop a conversion. The numbers are labelled "script default" and can be changed or switched off in Settings.

- **Over-cap reminder.** If you tick more than the cap, for example 50 against a cap of 30: "You ticked 50; the cap is 30. This click will attempt 30. 20 stay ticked for the next pass."
- **Unsaved-edits reminder.** WME's total unsaved-edit count includes every kind of edit: new segments, connections, segment info, geometry changes and so on. When it reaches your threshold (script default 300; set 0 to never be reminded), the script reminds you to finish aligning, connecting and saving before adding more. It fires once per crossing and re-arms when the count falls below the threshold.
- **Unverified-draft reminder.** When the drafts this script created are still unsaved and reach a percentage of the per-click cap (script default 150%; 0 turns it off), it reminds you to align, verify and save them first.

## Panel controls

| Control | What it does |
| --- | --- |
| **Scan** | Finds candidates in the current view. |
| **Convert** | Creates the ticked candidates as new drafts in WME. Nothing is saved. |
| **Remove** | Undoes the ticked drafts, or removes ticked rows from the lists. |
| **Import SUG** | Imports WME segment suggestions as candidates. See "Import WME suggestions" above. |
| **Flip (⇆)** | Swaps the A and B ends of a candidate. Also flips neighbours that share a junction within 3 m. The result carries into the segment when you Convert. |
| **1W / 2W** | Switches a candidate between one-way (A to B) and two-way. |
| **Zoom (⌖)** | Zooms the map to a candidate. |
| **Street View** | Shows or hides the Street View coverage layer. |
| **Guide** | Shows the scanned-area guide frame and tips. |

### Seams and junction dots

- A **blue dot** marks an end that is a junction with a mapped road or another candidate. It stays on the same physical end when you flip.
- A **seam badge** shows whether the direction is clean where a draft meets an existing segment. ✓ means flow is continuous. ⚠ old #id means an existing segment's direction forces a break. ⚠ user means a hand-locked neighbour does.
- Orientation comes only from adjacent existing segments or the traced order. When the two ends disagree, the stronger existing segment (higher lock, then higher road type) wins.

## Settings

Saved in your browser (`localStorage`, key `wme-svra-settings`).

| Setting | Default |
| --- | --- |
| Min map zoom to scan | 16 |
| Zoom button level | 18 |
| Detection radius (m) | 20 |
| Min candidate length (m) | 30 |
| Max candidates stored | 1000 |
| Drafts per sub-batch | 1 |
| Drafts per convert click (max 50) | 10 |
| Zoom level when panning to convert (12-18) | 14 |
| Remind me when unsaved edits reach (0 = never) | 300 |
| Unverified-draft reminder, % of per-click cap (0 = off) | 150 |
| Pause between batches (ms) | 2000 |
| Delay between segments (ms) | 300 |
| Wait for map tiles before Convert (ms) | 1500 |
| High-lock buffer (m) | 5 |
| Road type | Street |
| Split candidates at junctions | on |
| Auto scan resolution | on |
| Tile budget per scan | 40 |
| Auto show/hide coverage with Street View | on |

## Troubleshooting

- **The panel does not appear:** check that your userscript manager is enabled for the page and that Chrome's "Allow User Scripts" toggle is on. Open the browser console and filter by `WME Street View Road Assistant`. You should see `SDK initialized in async mode`, `WME ready` and `Initialised v1.0.0-beta (build 2026-11-13-c: …)`. The build string tells you which revision is loaded, so if it prints an older build string than the one you installed, Tampermonkey is serving a cached copy.
- **Scan finds no coverage or reports that no tiles loaded:** the Street View tile endpoint may be blocked, offline or changed (see "How candidate shapes are made"). The message names the first failed tile.
- **Import reports "This WME build has no SegmentSuggestions API":** Import requires `sdk.DataModel.SegmentSuggestions`, which is not present on every WME build. Scan works regardless.
- **Import reports "Suggestions in view: 0 open" on the first import after a fresh zoom:** WME had not yet delivered the suggestion data. Press Import again; the layer is already on, so the second pass sees the data. Alternatively raise the internal wait cap.
- **"Could not undo … Use Ctrl+Z in WME":** the script's undo guard fires when other edits exist after the draft it's trying to undo, so it cannot prove nothing else will be undone. Undo the intervening edits in WME first.
- **Debug output:** run `localStorage.setItem('wme-svra-debug','1')` in the console and reload. Run `localStorage.removeItem('wme-svra-debug')` to turn it off.

## Known limitations

- Drafts are not aligned to any GPS data. Align them by hand.
- Junction and seam flags rely on the mapped segments next to a candidate. Odd geometry can give a wrong dot or badge, so check each one.
- The wait for map data is a heuristic. WME exposes no exact "tiles loaded" signal, so a draft can still be treated as a suggested edit on a slow connection. If that happens, raise "Wait for map tiles before Convert".
- Large views are scanned in the centre area only, within the tile budget. Work in smaller views for full coverage.
- Scanning again can join new pieces onto existing candidates or split them at junctions. Review after your last scan.
- Imported suggestions reflect whatever the WME community flagged, which can be wrong or incomplete. Verify each one.

## Compliance and accountability

- **Transparent.** The full source is public in this repository. Nothing is obfuscated or loaded from elsewhere, apart from the Street View coverage tiles described above.
- **Not for points.** The script exists to help editors map roads that are missing. It is not meant to raise edit counts. Every draft needs your own review and alignment, nothing is saved for you, and each Convert click is capped (script default 10, maximum 50).
- **Local knowledge comes first.** Bulk tools do not replace it. If anything the script proposes, such as road type, direction or geometry, conflicts with your local community's standards, follow the community and involve it in the decision.
- **Not approved by Waze.** This script has not been reviewed or endorsed by Waze or the editing community. Read the official [Guidelines for Bulk Editing Scripts](https://www.waze.com/discuss/t/guidelines-for-bulk-editing-scripts/407412) and ask your local community before using or sharing it.

## About

Written by [dinkaftac](https://github.com/dinkaftac). AI tools helped with code review and documentation. The author made the design decisions and approved the code.

Bug reports and suggestions: [issue tracker](https://github.com/dinkaftac/wme-sv-road-assistant/issues).

## Disclaimer

This is a review-and-approve tool, not an automated editor. You are responsible for every segment you save. Follow your local Waze community's editing guidelines.

## License

MIT. See [LICENSE](LICENSE).
