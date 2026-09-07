# Rocket Launch Card

![Rocket Launch Card](banner.svg)

> The banner above is an illustration of the card's layout, not a screenshot.

Modern Home Assistant Lovelace cards and automation blueprints, built to
answer one question fast: **is there a launch from my site coming up, and
how long until it goes?**

This is the frontend half of a two-repo project:

- **[Tmatz27/ha-rocket-launch-tracker](https://github.com/Tmatz27/ha-rocket-launch-tracker)**
  — a small custom integration that polls
  [Launch Library 2](https://ll.thespacedevs.com) (thespacedevs.com), filtered
  **server-side** to whatever launch site you configure, and exposes it as
  Home Assistant sensors. Install this first — the cards below read its
  entities.
- **This repo** — the two Lovelace cards and four automation blueprints
  that consume those sensors.

### Why two repos, and why not the other rocketlaunch.live integration

An earlier version of this project read
[djtimca/harocketlaunchlive](https://github.com/djtimca/harocketlaunchlive)
instead. That integration always exposes exactly the **next 5 launches
worldwide**, with no per-site filter of its own — if 5 launches from other
sites were queued up before the next one from yours, it simply wasn't in the
data yet, and no amount of client-side filtering could show it. It also
doesn't expose an explicit Go/Hold/Scrub status field, only raw target times.

`ha-rocket-launch-tracker` exists to fix both of those: filtering happens at
the data source (Launch Library 2 supports it directly), and each launch
carries a real status (Go, TBD, Hold, Success, Failure, In Flight) instead of
one inferred purely from timing.

## What's here

- **`rocket-launch-card`** — an upcoming-launches list for your tracked site,
  with a live ticking countdown for near-term launches and a compact line for
  everything farther out
- **`rocket-launch-countdown-card`** — a dedicated countdown that stays out
  of the way until the next launch is close, then takes over with a big live
  timer
- Four **automation blueprints** — a daily "launch today" alert, a
  countdown alert capped at a fallback time so an overnight launch still
  warns you before bed, a reschedule alert for weather delays or a launch
  moving earlier than expected, and a pet-safety alert to bring animals
  inside before an imminent, nearby launch

## Requirements

1. Home Assistant 2024.10 or newer
2. HACS
3. [Rocket Launch Tracker](https://github.com/Tmatz27/ha-rocket-launch-tracker)
   installed and set up for your site first — **v0.1.4 or newer** if you want
   target orbit and booster landing/RTLS status (0.1.3 forwarded the data but
   had the landing *location* field wrong - always empty); older versions
   still work, the card just won't have that data to show

## Install with HACS

1. Open **HACS**
2. Open the three-dot menu and choose **Custom repositories**
3. Add `https://github.com/Tmatz27/ha-rocket-launch-card-`
4. Choose the **Dashboard** category
5. Install **Rocket Launch Card**
6. Refresh the browser

If the card doesn't show up under **Add card**, hard-refresh the dashboard
(`Ctrl+Shift+R` / `Cmd+Shift+R`) and check **Settings → Dashboards → ⋮ →
Resources** for a JavaScript module entry pointing at
`/hacsfiles/ha-rocket-launch-card-/rocket-launch-card.js`. YAML-mode
dashboards need that resource added by hand in `configuration.yaml`.

## Add the cards

Both cards need exactly one thing: the tracker integration's **Upcoming
Launches** sensor for your site (e.g. `sensor.vandenberg_upcoming_launches`
— check **Settings → Devices & Services → Rocket Launch Tracker** for the
exact entity id, or just use the visual editor's entity picker).

```yaml
type: custom:rocket-launch-card
entity: sensor.vandenberg_upcoming_launches
```

```yaml
type: custom:rocket-launch-countdown-card
entity: sensor.vandenberg_upcoming_launches
trigger_hours: 2
```

Both cards also have a visual editor — use **Add card → Rocket Launch Card**
/ **Rocket Launch Countdown Card** and everything below is editable there.

### `rocket-launch-card` options

| Option | Default | Description |
| --- | --- | --- |
| `title` | `Rocket Launches` | Card heading |
| `entity` | *(required)* | The tracker integration's "Upcoming Launches" sensor |
| `live_window_hours` | `24` | Launches inside this window get the big live countdown; farther out shows as a simple line |
| `show_description` | `true` | Show the mission description on the live countdown card |
| `max_launches` | `0` | Caps how many launches the list shows. `0` shows every launch the sensor provides |

### `rocket-launch-countdown-card` options

| Option | Default | Description |
| --- | --- | --- |
| `title` | `Launch Countdown` | Card heading |
| `entity` | *(required)* | Same sensor as the main card — the countdown tracks the first pending launch, skipping completed outcomes |
| `trigger_hours` | `2` | The countdown takes over this many hours before launch |
| `show_when_inactive` | `true` | When outside the window, show a one-line "next launch in..." summary instead of collapsing to nothing |

### Countdown appearance and actions (0.3.0)

The countdown uses violet (`#b49aff`) by default, with a subtle top accent
instead of a green left stripe. The countdown has no decorative stars or
moon. Hold/Failure warnings keep their red styling. The full launch-list
card retains its existing status colors.

| Option | Default | Description |
| --- | --- | --- |
| `accent_color` | `#b49aff` | Six-digit hex color for the countdown accent; also available in the visual editor |
| `tap_action` | `{action: popup}` | Action when tapped or activated with Enter/Space |
| `hold_action` | `{action: none}` | Action after holding at least 500 ms and releasing; Shift+Enter is the keyboard alternative |
| `popup_card` | `{}` | YAML-only overrides for the built-in main launch card, such as `title`, `max_launches`, `live_window_hours`, and `show_description`; the sensor always follows the countdown |

The visual editor offers **Open launch popup**, **Navigate**, **Sensor
details**, and **Do nothing** for each gesture. Navigation reveals a path
field, such as `/lovelace/launches` or a `#launch-popup` used by an existing
popup card. A swipe/drag cancels the gesture. A hold does not also fire a tap.

To keep the countdown on the front dashboard and open the larger list:

```yaml
type: custom:rocket-launch-countdown-card
title: Launch Countdown
entity: sensor.vandenberg_upcoming_launches
trigger_hours: 24
show_when_inactive: true
accent_color: "#b49aff"
tap_action:
  action: popup
hold_action:
  action: more-info
popup_card:
  title: Vandenberg Launches
  max_launches: 0
  show_description: true
```

No Browser Mod or additional popup integration is required for `action:
popup`. Close it with its Close button, Escape, or the backdrop. The popup
continues receiving Home Assistant updates and stops its nested card timer
when closed. This custom native dialog does not add a browser-history entry;
use Close/Escape/backdrop rather than browser Back to dismiss it.

To navigate on tap and open the built-in popup on hold:

```yaml
tap_action:
  action: navigate
  navigation_path: /lovelace/launches
  navigation_replace: false
hold_action:
  action: popup
```

Supported action names are `popup` (specific to this card), `navigate`,
`more-info`, `none`, and YAML-only `fire-dom-event`. `more-info` accepts an
optional `entity` override. Navigation accepts same-origin dashboard paths
starting with `/` or `#`. Other Home Assistant action types and action
confirmation options are not implemented by this card.

For an existing external popup integration, a YAML `fire-dom-event` action
forwards the full action object as a bubbling, composed `ll-custom` event.
The receiving integration must be installed and configured separately.
Editing other visual settings preserves that action payload.

As of 0.3.1, the launch-details popup and standalone upcoming-launch list also
skip completed outcomes, including while the popup is open. The `max_launches`
limit applies to pending launches after filtering. Holds and in-flight missions
remain visible until their outcome is confirmed.

Completed launches are skipped automatically (Success, Failure, Partial
Failure). If a pending launch remains, the normal trigger window and
`show_when_inactive` setting apply to that launch. If no pending launches
remain, the countdown hides completely, even with `show_when_inactive: true`.
It reappears when a future sensor update supplies the next pending launch.
Holds and overdue unconfirmed launches are kept visible.

## How the live behavior works

- **Live countdown**: once the next launch has a known target time and is
  inside `live_window_hours` (main card) or `trigger_hours` (countdown
  card), the timer ticks every second, client-side, between the
  integration's own adaptive polling (as often as every few minutes once a
  launch is close — see the tracker repo's README for exactly how that's
  paced against Launch Library's rate limit).
- **Real status, not just timing**: a launch carries an actual status —
  Go, TBD, Hold, Success, Failure, In Flight — shown as a pill badge, and
  echoed in a 6px left accent bar on the main list's rows (green for Go/Success, red
  for Hold/Failure, blue/gray for TBD or an ordinary scheduled launch). A
  Hold or an In-Flight launch stays prominent regardless of the configured
  window. The launch provider gets its own neutral pill badge next to it.
- **T-minus line, color-coded by proximity**: a compact row shows the
  formatted date and, beneath it, a relative "T- 14 days" line (with the
  hours remainder shown too once it's under 2 days, e.g. "T- 1d 18h", so it
  never reads as "about a day" for something up to 47 hours out). That
  second line is muted gray beyond 30 days out, warning yellow/orange
  inside 7 days, and switches to a bold live countdown once inside 24
  hours — even if that row isn't the hero card.
- **Click a row for more detail**: any launch row (hero or compact) expands
  in place to show target orbit, rocket, booster landing status, and the
  mission description, without opening Home Assistant's more-info dialog.
  Keyboard-accessible (Enter/Space), and clicking inside the open panel
  itself won't collapse it back.
- **Booster landing and RTLS warning**: when Launch Library reports a
  landing attempt, its location shows as a pill badge — unless that location
  is a return-to-launch-site pad (matched on "LZ-1", "LZ-4", "RTLS", or
  "Vandenberg" in the location name), which instead gets an aggressive solid
  red "⚠️ RTLS Landing: Sonic Boom Expected" badge, since that means an
  audible sonic boom near the site. A launch known not to attempt a landing
  shows "Expendable" instead, and one Launch Library just hasn't assigned a
  specific pad or drone ship to yet shows "Landing planned, site TBD".
  Requires Rocket Launch Tracker v0.1.4+; older tracker versions simply
  won't have this data to show, and the badge is silently omitted rather
  than guessing.
- **Delayed launches**: each card remembers the first target time it saw for
  a given launch (by Launch Library's own launch id, in your browser's
  `localStorage`). If a later poll reports a later time for the same launch,
  a **"Slipped from ..."** badge appears until that launch is no longer
  tracked.
- **Past the predicted time with no status update yet**: for up to 15
  minutes, the card shows "in launch window" and counts up. Past that, it
  shows **"Awaiting updated status"** instead of a runaway or frozen timer.
- **No known time yet**: a launch with only a rough precision (e.g. "Month")
  and no exact date shows that as text — never a fake countdown.

## Automation blueprints

All four live in [`blueprints/automation/`](blueprints/automation) and read
the tracker's **Next Launch** sensor (a timestamp entity —
`sensor.<site>_next_launch`). Import with the buttons below (they open your
own Home Assistant), or **Settings → Automations & Scenes → Blueprints →
Import Blueprint** and paste the raw GitHub URL.

### Updating existing blueprints (0.3.2)

HACS updates the card; it does **not** replace blueprints already imported in
Home Assistant. Go to **Settings > Automations & scenes > Blueprints**, open
each Rocket Launch blueprint's three-dot menu, select **Re-import blueprint**,
and reload automations. Existing inputs remain compatible. If you previously
used **Take control**, that automation is an independent copy: update its YAML
or recreate it from the blueprint instead. Save any personal blueprint edits
before re-importing. See [Home Assistant's re-import guide](https://www.home-assistant.io/docs/automation/using_blueprints/#re-importing-a-blueprint).

Version 0.3.2 fixes datetime/string errors in the day/countdown/pet templates,
the countdown's overnight fallback, and the reschedule history initialization.
Each countdown, pet and reschedule automation must have its own Text helper.
An empty, available helper is valid; an unavailable helper pauses that alert.
Manual **Run actions** now obeys eligibility checks, so it may correctly send
nothing outside the alert window. Test the notify action separately in
Developer Tools > Actions if you only want to verify phone delivery.

### Launch day alert

Checks once a day and sends one notification if a launch is scheduled for
today and still ahead, naming it and its time. Set the daily check before
the launches you want to hear about: the default 8 AM is too late for a
7:26 AM launch. Missed daily checks are not replayed after downtime.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_day_alert.yaml)

### Countdown alert

Fires once per launch, normally 1 hour before — but never later than a
fallback clock time (default 8:30 PM). A launch at 2 AM still gets a
heads-up at 8:30 PM the evening before instead of a 1-hour warning while
you're asleep; a launch at 6 PM still gets the normal 1-hour warning at 5 PM
since that's earlier than the fallback.

The **Earliest morning alert time** defaults to 6 AM. If the normal warning
would be earlier, the fallback is the preceding evening. Later warnings use
that same day's fallback. Future days do not borrow today's bedtime. Alerts
do not catch up during quiet hours; the minute containing the evening cutoff
is included because the trigger runs once per minute. Set morning earlier
than the evening cutoff. Date/lead calculations use the configured HA timezone.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_countdown_alert.yaml)

This one needs a **one-time helper** so the minute-by-minute check doesn't
repeat itself: **Settings → Devices & Services → Helpers → + Create Helper →
Text**, name it anything (e.g. "Rocket Launch Alert Sent"), and pick it for
the blueprint's *Dedup helper* input.

### Reschedule alert

Fires whenever the next tracked launch's time changes by more than a
configurable amount (default 15 minutes) from what you were last told —
a weather hold pushing it back, or it moving up earlier than expected —
naming the old and new time. Event-driven (fires on the change itself, not
a fixed check interval), and stays silent when a different launch simply
becomes "next" after today's one flies — that's not a reschedule.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_reschedule_alert.yaml)

This also needs a **one-time helper** (same steps as above) — use a
**different** Text helper than the countdown alert's, since they track
different things.

The first valid observation silently seeds the history helper. A different
mission also replaces that baseline silently; only a qualifying time change
for the same mission sends a notification. Failed notification actions do
not advance the baseline, so the next sensor update can retry.

### Pet safety alert

A short-notice nudge to bring pets inside before a nearby launch's acoustic
shock: fires a set number of minutes before launch (default 15), but only
if that moment falls between an "earliest morning" time and a bedtime
cutoff (defaults 6:00 AM–8:30 PM). Unlike the countdown alert, a launch
outside that window is **skipped entirely rather than shifted** — if
you're already asleep, the pets are already in for the night and there's
nothing to act on. Optionally personalize the message with your pets'
names.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_pet_safety_alert.yaml)

This also needs its own **one-time helper**, separate from the other two.

All four blueprints need a **notify action** name, e.g.
`notify.mobile_app_your_phone` — find the exact name under **Developer
Tools → Actions** by searching "notify". `notify.notify` broadcasts to every
notify target.

After importing, open the automation's **Traces** (or **Developer Tools →
Template**, pasting in the blueprint's template) to confirm it's reading
your launch data as expected before relying on it.

## Privacy

Both cards read only Home Assistant's local entity state — no outbound
requests, no telemetry, no third-party calls. Delay tracking is stored in
your browser's `localStorage`, scoped to your Home Assistant origin, and is
pruned automatically after 14 days of inactivity.

## Development

```bash
npm test
```

No build step. `rocket-launch-card.js` is the HACS release file.

## Credits

Data comes from [Launch Library 2](https://ll.thespacedevs.com)
(thespacedevs.com) via
[Tmatz27/ha-rocket-launch-tracker](https://github.com/Tmatz27/ha-rocket-launch-tracker).
Card structure and interaction patterns follow the same conventions as
[Tmatz27/ha-sab-deluge-card](https://github.com/Tmatz27/ha-sab-deluge-card).

## License

MIT


### Optional browser interaction checks

`npm test` runs the dependency-free fake-DOM suite. For a real browser check:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

An installed Chrome/Chromium can be used with `CHROME_PATH` instead. The
browser harness serves local fixture data and exercises the actual card
source; it does not connect to a real Home Assistant server. Its stub
Home Assistant icons use placeholder glyphs. Screenshots go to
`test-artifacts/` (or `BROWSER_ARTIFACT_DIR`).
