# Changelog

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
