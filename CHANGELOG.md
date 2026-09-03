# Changelog

## 0.2.3

- Added a fourth blueprint, **pet safety alert**: a short-notice reminder
  (default T-15 minutes) to bring pets inside before a nearby launch's
  acoustic shock. Skipped entirely (not shifted, unlike the countdown
  alert) when that moment falls outside a configurable
  earliest-morning/bedtime window, since a launch that late or early means
  pets are already in for the night
- Companion fix in `ha-rocket-launch-tracker` v0.1.2: the site filter now
  resolves to an exact Launch Library location id instead of a text filter
  that was never confirmed to work against the launch endpoint - see that
  repo's changelog. No changes needed here; just update the integration.

## 0.2.2

- Added a third blueprint, **reschedule alert**: notifies you whenever the
  next tracked launch's time shifts by more than a configurable amount from
  what you were last told (weather hold, or moved up earlier than
  expected). Event-driven off the Next Launch sensor's own state changes,
  and tracks the launch by Launch Library's own id so turnover to a
  different launch (today's one flew) doesn't get mistaken for a reschedule

## 0.2.1

- Restyled both cards to match a flat dark theme instead of the earlier
  glassy gradient look: flat card surfaces (no glow), a colored left accent
  capsule and a large soft rocket-icon watermark per launch panel (matching
  a common "colored accent bar on a flat dark card" convention), and flat
  solid-color countdown digits instead of gradient-clipped text
- Retuned the accent/warn/hot/good palette to be less neon/saturated
- Swapped the decorative moon emoji for a proper `mdi:moon-waning-crescent`
  icon and toned down the star field, consistent with an all-mdi-icon theme

## 0.2.0

- **Breaking:** switched data sources from djtimca/harocketlaunchlive to
  [Tmatz27/ha-rocket-launch-tracker](https://github.com/Tmatz27/ha-rocket-launch-tracker),
  a small companion integration that polls Launch Library 2
  (thespacedevs.com) filtered server-side by launch site. The old
  integration only ever exposed the next 5 launches worldwide with no site
  filter of its own; a matching launch could simply not be in the data yet.
  Filtering now happens at the source instead of client-side
- Card config replaced `site_filter`/`entity_prefix`/`show_other_launches` with
  a single `entity` picker pointing at the tracker's "Upcoming Launches"
  sensor - filtering is already done by the time the card sees the data
- Real launch status (Go, TBD, Hold, Success, Failure, In Flight) now drives
  the status badge instead of being inferred purely from timing. A Hold or
  In Flight launch stays prominent regardless of the configured live window
- `show_weather` removed - Launch Library 2 doesn't provide a weather field
  the way rocketlaunch.live did; a launch's `probability` (weather-driven "go"
  percentage) is shown instead where available
- Added a subtle themable starfield + moon accent to both cards

## 0.1.0

- Initial HACS-ready release
- `rocket-launch-card`: upcoming-launches list filtered to a configurable
  launch site (defaults to Vandenberg), reading the harocketlaunchlive
  integration's five sensors
- Launches inside the configurable live window get a live, ticking countdown;
  farther-out launches show as a simple line
- Delay detection: a launch that slips later than when it was first seen gets
  a "Slipped from ..." badge, tracked per mission identity in `localStorage`
  so it survives a dashboard reload
- A stalled countdown (past its predicted time with no update) shows
  "Awaiting updated status" instead of a runaway or frozen timer
- `rocket-launch-countdown-card`: a dedicated big countdown that appears once
  the next matching launch is inside a configurable window (default 2 hours)
- Visual editors for both cards
- Two automation blueprints: a daily "launch today" alert, and a countdown
  alert that fires at T-minus-N-minutes but never later than a fallback clock
  time, so an overnight launch still warns you before bed
