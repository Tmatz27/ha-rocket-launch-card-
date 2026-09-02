# Rocket Launch Card

![Rocket Launch Card](banner.svg)

> The banner above is an illustration of the card's layout, not a screenshot.

Modern Home Assistant Lovelace cards and automation blueprints for
[djtimca/harocketlaunchlive](https://github.com/djtimca/harocketlaunchlive)
(Rocket Launch Live), built to answer one question fast: **is there a launch
from my site coming up, and how long until it goes?**

## Why this exists

The upstream integration's own example card (a static `button-card` grid)
just prints five fixed fields per sensor. It doesn't filter by launch site,
doesn't tick down live, and shows the same flat text whether a launch is
scrubbed, delayed, or minutes away. This project replaces it with:

- **`rocket-launch-card`** — an upcoming-launches list filtered to your
  launch site (defaults to Vandenberg SFB), with a live ticking countdown for
  near-term launches and a compact line for everything farther out
- **`rocket-launch-countdown-card`** — a dedicated countdown that stays out
  of the way until the next matching launch is close, then takes over with a
  big live timer
- Two **automation blueprints** — a daily "launch today" alert, and a
  countdown alert capped at a fallback time so an overnight launch still
  warns you before bed

### A real limit of the upstream integration

`harocketlaunchlive` always creates exactly five sensors —
`sensor.rocket_launch_1` through `_5` — holding the **next five launches
worldwide**, in order. There is no per-site filter and no config option to
track more of them. These cards filter *within* those five for your site,
but if five other launches are queued up before the next one from your site,
it genuinely will not appear yet — the data isn't there to show. When that
happens the card says so explicitly rather than showing nothing or stale
data.

The integration also doesn't expose an explicit Go/Hold/Scrub status field —
only target times. "Delayed" and "in launch window" states below are
inferred client-side from how those times change and from how far past a
predicted time we are, not read from a status flag.

## Requirements

1. Home Assistant 2024.10 or newer
2. HACS
3. [Rocket Launch Live](https://github.com/djtimca/harocketlaunchlive)
   integration installed and configured (a free rocketlaunch.live API key is
   enough; a paid key adds featured video links)

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

```yaml
type: custom:rocket-launch-card
site_filter: Vandenberg
```

```yaml
type: custom:rocket-launch-countdown-card
site_filter: Vandenberg
trigger_hours: 2
```

Both cards also have a visual editor — use **Add card → Rocket Launch Card**
/ **Rocket Launch Countdown Card** and everything below is editable there.

### `rocket-launch-card` options

| Option | Default | Description |
| --- | --- | --- |
| `title` | `Rocket Launches` | Card heading |
| `site_filter` | `Vandenberg` | Case-insensitive text matched against each launch's pad, state, and country. Blank shows every tracked launch |
| `live_window_hours` | `24` | Launches inside this window get the big live countdown; farther out shows as a simple line |
| `show_other_launches` | `false` | Also list the tracked launches that don't match `site_filter`, in a secondary compact section |
| `show_weather` | `true` | Show the pad weather summary when available |
| `show_description` | `true` | Show the mission description on the live countdown card |
| `entity_prefix` | `sensor.rocket_launch_` | YAML-only. Change if you renamed the integration's entities |

### `rocket-launch-countdown-card` options

| Option | Default | Description |
| --- | --- | --- |
| `title` | `Launch Countdown` | Card heading |
| `site_filter` | `Vandenberg` | Same matching as the main card |
| `trigger_hours` | `2` | The countdown takes over this many hours before launch |
| `show_when_inactive` | `true` | When outside the window, show a one-line "next launch in..." summary instead of collapsing to nothing |
| `entity_prefix` | `sensor.rocket_launch_` | YAML-only |

## How the live behavior works

- **Live countdown**: once a matching launch has a known target time and is
  inside `live_window_hours` (main card) or `trigger_hours` (countdown
  card), the timer ticks every second, client-side, between the
  integration's ~60-second polls.
- **Delayed launches**: each card remembers the first target time it saw for
  a given mission (by name + provider + pad, in your browser's
  `localStorage` — not tied to the sensor index, since the integration
  reassigns `_1`.._5` to whatever is soonest). If a later poll reports a
  later time for the same mission, a **"Slipped from ..."** badge appears
  until that mission clears the tracked five.
- **Past the predicted time**: for up to 15 minutes past a launch's target
  time, the card shows "in launch window" and counts up. Past that, it stops
  guessing and shows **"Awaiting updated status"** instead of a runaway or
  frozen timer, since the data is almost certainly about to change (either a
  new target time, or the mission drops off the tracked five).
- **No known time yet**: a launch with only a NET date (no `t0`/window-open
  time from the API) shows that date as text — never a fake countdown.

## Automation blueprints

Both live in [`blueprints/automation/`](blueprints/automation) and read the
same five sensors. Import with the buttons below (they open your own Home
Assistant), or **Settings → Automations & Scenes → Blueprints → Import
Blueprint** and paste the raw GitHub URL.

### Launch day alert

Checks once a day and sends one notification if a matching launch is
scheduled for today, naming the mission and its time.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_day_alert.yaml)

### Countdown alert

Fires once per launch, normally 1 hour before — but never later than a
fallback clock time (default 8:30 PM). A launch at 2 AM still gets a
heads-up at 8:30 PM the evening before instead of a 1-hour warning while
you're asleep; a launch at 6 PM still gets the normal 1-hour warning at 5 PM
since that's earlier than the fallback.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2FTmatz27%2Fha-rocket-launch-card-%2Fmain%2Fblueprints%2Fautomation%2Frocket_launch_countdown_alert.yaml)

This one needs a **one-time helper** so the minute-by-minute check doesn't
repeat itself: **Settings → Devices & Services → Helpers → + Create Helper →
Text**, name it anything (e.g. "Rocket Launch Alert Sent"), and pick it for
the blueprint's *Dedup helper* input.

Both blueprints need a **notify action** name, e.g.
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

Data comes from [rocketlaunch.live](https://rocketlaunch.live) via
[djtimca/harocketlaunchlive](https://github.com/djtimca/harocketlaunchlive).
Card structure and interaction patterns follow the same conventions as
[Tmatz27/ha-sab-deluge-card](https://github.com/Tmatz27/ha-sab-deluge-card).

## License

MIT
