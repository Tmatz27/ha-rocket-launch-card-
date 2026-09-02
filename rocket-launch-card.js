/**
 * Rocket Launch Card for Home Assistant
 * Version 0.1.0
 *
 * Two custom cards backed by djtimca/harocketlaunchlive (Rocket Launch Live):
 *   - rocket-launch-card: an upcoming-launches list, filtered to a launch site,
 *     with a live ticking countdown for near-term launches.
 *   - rocket-launch-countdown-card: a dedicated countdown that appears once the
 *     next matching launch is inside a configurable window.
 *
 * The upstream integration always exposes exactly the next 5 GLOBAL launches
 * as sensor.rocket_launch_1..5 (no per-site filtering, no explicit delay/hold
 * status). Everything site-specific, live-countdown, and delay-aware here is
 * computed client-side from those five sensors' attributes.
 *
 * Copyright (c) 2026 Travis Matzdorf
 * SPDX-License-Identifier: MIT
 */

const ROCKET_LAUNCH_CARD_VERSION = "0.1.0";

const DEFAULT_ENTITY_PREFIX = "sensor.rocket_launch_";

const DEFAULT_MAIN_CONFIG = Object.freeze({
  title: "Rocket Launches",
  site_filter: "Vandenberg",
  entity_prefix: DEFAULT_ENTITY_PREFIX,
  live_window_hours: 24,
  show_other_launches: false,
  show_weather: true,
  show_description: true,
});

const DEFAULT_COUNTDOWN_CONFIG = Object.freeze({
  title: "Launch Countdown",
  site_filter: "Vandenberg",
  entity_prefix: DEFAULT_ENTITY_PREFIX,
  trigger_hours: 2,
  show_when_inactive: true,
});

// Fixed internal refresh-rate threshold: tick every second once a matched
// launch is within this many hours, otherwise a slow tick is plenty. This is
// deliberately independent of the configurable "live window" that decides
// layout, since second-level precision is only useful once a launch is close.
const FAST_TICK_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const FAST_TICK_MS = 1000;
const SLOW_TICK_MS = 30 * 1000;
const DORMANT_TICK_MS = 60 * 1000;

// Once a countdown runs this far past its predicted target with no updated
// timestamp, stop counting up and say status is unconfirmed instead of
// showing an ever-growing (and probably wrong) T+ timer.
const STALE_AFTER_MS = 15 * 60 * 1000;

const DELAY_STORE_PREFIX = "rocket-launch-card:";
const DELAY_STORE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
let delayStorePruned = false;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const sameConfig = (left, right) => {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of keys) {
    if (left?.[key] !== right?.[key]) return false;
  }
  return true;
};

// --- Launch data -----------------------------------------------------------

function normalizeTimestamp(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeDate(value) {
  if (!value || value === "NA") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function truthyFlag(value) {
  return String(value ?? "").toLowerCase() === "true";
}

function readLaunch(hass, entityId) {
  const state = hass?.states?.[entityId];
  if (!state) return null;
  const a = state.attributes || {};
  return {
    entityId,
    name: a.name || state.state || "Unknown launch",
    provider: a.provider || "",
    vehicle: a.vehicle || "",
    pad: a.launch_pad || "",
    country: a.launch_location || "",
    usState: a.launch_US_state || "",
    missions: a.launch_missions || "",
    description: a.launch_description || "",
    mediaLink: a.launch_media_link || "",
    warning24h: truthyFlag(a.launch_24h_warning),
    warning20m: truthyFlag(a.launch_20m_warning),
    targetTs: normalizeTimestamp(a.launch_target_timestamp),
    dateTarget: a.launch_date_target && a.launch_date_target !== "NA" ? a.launch_date_target : "",
    estDate: normalizeDate(a.est_launch_date),
    tags: (a.tags || "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean),
    weatherSummary: a.weather_summary && a.weather_summary !== "TBD" ? a.weather_summary : "",
    weatherTemp: a.weather_temp,
    lastUpdated: state.last_updated || "",
  };
}

function collectLaunches(hass, entityPrefix) {
  const prefix = entityPrefix || DEFAULT_ENTITY_PREFIX;
  const states = hass?.states || {};
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\d+$`);
  return Object.keys(states)
    .filter((id) => pattern.test(id))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map((id) => readLaunch(hass, id))
    .filter(Boolean);
}

function matchesSite(launch, filter) {
  const needle = String(filter || "").trim().toLowerCase();
  if (!needle) return true;
  return [launch.pad, launch.country, launch.usState].some((field) =>
    String(field || "").toLowerCase().includes(needle),
  );
}

function byTargetAscending(a, b) {
  if (a.targetTs == null && b.targetTs == null) return 0;
  if (a.targetTs == null) return 1;
  if (b.targetTs == null) return -1;
  return a.targetTs - b.targetTs;
}

function splitLaunches(launches, siteFilter) {
  const matches = [];
  const others = [];
  for (const launch of launches) (matchesSite(launch, siteFilter) ? matches : others).push(launch);
  matches.sort(byTargetAscending);
  others.sort(byTargetAscending);
  return { matches, others };
}

function launchKey(launch) {
  return `${launch.name}|${launch.provider}|${launch.pad}`.toLowerCase();
}

// --- Delay tracking (localStorage; keyed by mission identity, not entity_id,
// since the integration reassigns sensor_1..5 to whichever launches are
// soonest and a given index can refer to a different mission from one poll
// to the next) -------------------------------------------------------------

function pruneDelayStoreOnce() {
  if (delayStorePruned) return;
  delayStorePruned = true;
  try {
    const now = Date.now();
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DELAY_STORE_PREFIX)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (!value || !value.touchedAt || now - value.touchedAt > DELAY_STORE_MAX_AGE_MS) stale.push(key);
      } catch {
        stale.push(key);
      }
    }
    stale.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage unavailable (private browsing, etc.) - delay tracking is
    // best-effort and simply won't persist across reloads.
  }
}

function trackDelay(launch) {
  if (launch.targetTs == null) return { delayed: false };
  const storeKey = DELAY_STORE_PREFIX + launchKey(launch);
  let state = null;
  try {
    const raw = localStorage.getItem(storeKey);
    if (raw) state = JSON.parse(raw);
  } catch {
    state = null;
  }
  if (!state || typeof state.firstTs !== "number") {
    state = { firstTs: launch.targetTs, latestTs: launch.targetTs, touchedAt: Date.now() };
  } else {
    state.latestTs = launch.targetTs;
    state.touchedAt = Date.now();
  }
  try {
    localStorage.setItem(storeKey, JSON.stringify(state));
  } catch {
    // Best-effort only.
  }
  return {
    delayed: state.latestTs - state.firstTs > 60,
    originalTs: state.firstTs,
    latestTs: state.latestTs,
  };
}

// --- Formatting --------------------------------------------------------

function formatCountdown(totalSeconds) {
  const negative = totalSeconds < 0;
  const s = Math.max(0, Math.round(Math.abs(totalSeconds)));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  const core = days > 0 ? `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return negative ? `T+${core}` : core;
}

function formatClock(epochSeconds) {
  if (epochSeconds == null) return "";
  const date = new Date(epochSeconds * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function formatShortClock(epochSeconds) {
  if (epochSeconds == null) return "";
  const date = new Date(epochSeconds * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

function formatDateOnly(date) {
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
  } catch {
    return date.toDateString();
  }
}

function formatRelative(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function formatAgo(isoString, nowMs) {
  if (!isoString) return "";
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.round((nowMs - then) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

// diffMs > 0 => still counting down. Once past target, "window" covers a
// short grace period (holds, final polling lag) before falling back to
// "stale", which stops the timer instead of counting up indefinitely against
// data that is probably just waiting on the next 60s integration poll.
function launchPhase(launch, nowMs) {
  if (launch.targetTs == null) return "no-time";
  const diffMs = launch.targetTs * 1000 - nowMs;
  if (diffMs > 0) return "counting";
  if (diffMs > -STALE_AFTER_MS) return "window";
  return "stale";
}

// --- Shared editor base --------------------------------------------------

const EDITOR_STYLES = `
  :host {
    display: block;
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  }
  .section { margin: 0; }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 34px;
    margin-bottom: 8px;
  }
  .label { flex: 1; font-size: 13px; }
  .hint {
    margin: -4px 0 10px;
    color: var(--secondary-text-color);
    font-size: 11px;
    line-height: 1.4;
  }
  input[type="text"],
  input[type="number"] {
    box-sizing: border-box;
    width: 150px;
    padding: 6px 8px;
    border: 1px solid var(--divider-color);
    border-radius: 7px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font: inherit;
    font-size: 13px;
  }
  .toggle { position: relative; width: 38px; height: 22px; flex: 0 0 auto; }
  .toggle input { position: absolute; width: 0; height: 0; opacity: 0; }
  .slider {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: var(--divider-color);
    cursor: pointer;
    transition: background .18s ease;
  }
  .slider::before {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    content: "";
    transition: transform .18s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .28);
  }
  input:checked + .slider { background: var(--primary-color); }
  input:checked + .slider::before { transform: translateX(16px); }
`;

class RocketLaunchEditorBase extends HTMLElement {
  constructor(defaults, schema) {
    super();
    this._defaults = defaults;
    this._schema = schema;
    this.attachShadow({ mode: "open" });
    this._config = { ...defaults };
    this._rendered = false;
  }

  set hass(hass) {
    this._hass = hass;
  }

  setConfig(config) {
    const next = { ...this._defaults, ...(config || {}) };
    // Home Assistant echoes every config-changed event back into setConfig.
    // Rebuilding the DOM on that echo would tear down live inputs mid-edit,
    // dropping focus and closing anything open, so skip unchanged updates.
    const unchanged = this._rendered && sameConfig(next, this._config);
    this._config = next;
    if (unchanged) return;
    this._render();
  }

  connectedCallback() {
    if (!this._rendered) this._render();
  }

  _update(key, value) {
    this._config = { ...this._config, [key]: value };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _render() {
    if (!this.shadowRoot) return;
    const rows = this._schema.map((field) => this._renderField(field)).join("");
    this.shadowRoot.innerHTML = `<style>${EDITOR_STYLES}</style><div class="section">${rows}</div>`;

    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((input) => {
      input.addEventListener("change", () => this._update(input.dataset.toggle, input.checked));
    });
    this.shadowRoot.querySelectorAll("[data-text]").forEach((input) => {
      input.addEventListener("change", () => this._update(input.dataset.text, input.value));
    });
    this.shadowRoot.querySelectorAll("[data-number]").forEach((input) => {
      input.addEventListener("change", () => {
        const field = this._schema.find((f) => f.key === input.dataset.number);
        const min = field?.min ?? 0;
        const max = field?.max ?? 999;
        const fallback = field?.default ?? min;
        const value = clamp(Number.parseInt(input.value, 10) || fallback, min, max);
        input.value = String(value);
        this._update(input.dataset.number, value);
      });
    });

    this._rendered = true;
  }

  _renderField(field) {
    const value = this._config[field.key];
    const hint = field.hint ? `<div class="hint">${escapeHtml(field.hint)}</div>` : "";
    if (field.type === "toggle") {
      return `
        <div class="row">
          <span class="label">${escapeHtml(field.label)}</span>
          <label class="toggle">
            <input type="checkbox" data-toggle="${field.key}" ${value !== false ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
        ${hint}
      `;
    }
    if (field.type === "number") {
      return `
        <div class="row">
          <span class="label">${escapeHtml(field.label)}</span>
          <input type="number" min="${field.min}" max="${field.max}" step="1" data-number="${field.key}"
            value="${Number(value) || field.default}">
        </div>
        ${hint}
      `;
    }
    return `
      <div class="row">
        <span class="label">${escapeHtml(field.label)}</span>
        <input type="text" data-text="${field.key}" value="${escapeHtml(value ?? "")}"
          placeholder="${escapeHtml(field.placeholder || "")}">
      </div>
      ${hint}
    `;
  }
}

class RocketLaunchCardEditor extends RocketLaunchEditorBase {
  constructor() {
    super(DEFAULT_MAIN_CONFIG, [
      { type: "text", key: "title", label: "Title", placeholder: DEFAULT_MAIN_CONFIG.title },
      {
        type: "text",
        key: "site_filter",
        label: "Site filter",
        placeholder: "Vandenberg",
        hint: 'Matches against launch pad, state, and country (e.g. "Vandenberg", "Cape Canaveral", "CA"). Leave blank to show every tracked launch.',
      },
      {
        type: "number",
        key: "live_window_hours",
        label: "Live countdown window (hours)",
        min: 1,
        max: 96,
        default: DEFAULT_MAIN_CONFIG.live_window_hours,
        hint: "Launches inside this window get the big live countdown treatment. Farther-out launches show as a simple line, same as the upstream card.",
      },
      {
        type: "toggle",
        key: "show_other_launches",
        label: "Show non-matching launches too",
        hint: "Adds a compact secondary list of the other tracked launches that do not match the site filter.",
      },
      { type: "toggle", key: "show_weather", label: "Show weather" },
      { type: "toggle", key: "show_description", label: "Show mission description" },
    ]);
  }
}

class RocketLaunchCountdownCardEditor extends RocketLaunchEditorBase {
  constructor() {
    super(DEFAULT_COUNTDOWN_CONFIG, [
      { type: "text", key: "title", label: "Title", placeholder: DEFAULT_COUNTDOWN_CONFIG.title },
      {
        type: "text",
        key: "site_filter",
        label: "Site filter",
        placeholder: "Vandenberg",
        hint: "Same matching as the main card. Leave blank to track the very next launch from anywhere.",
      },
      {
        type: "number",
        key: "trigger_hours",
        label: "Appear this many hours before launch",
        min: 1,
        max: 48,
        default: DEFAULT_COUNTDOWN_CONFIG.trigger_hours,
      },
      {
        type: "toggle",
        key: "show_when_inactive",
        label: "Show a compact summary when not counting down",
        hint: "Off collapses the card to nothing until it enters the countdown window.",
      },
    ]);
  }
}

// --- Shared card chrome (icon, empty states, styles) ------------------------

function integrationMissingHtml() {
  return `
    <div class="rl-empty">
      <ha-icon icon="mdi:rocket-outline"></ha-icon>
      <strong>No Rocket Launch Live sensors found</strong>
      <span>Install and configure the harocketlaunchlive integration, or check the entity prefix in the card config.</span>
    </div>
  `;
}

function baseStyles() {
  return `
    :host {
      --rl-surface: var(--ha-card-background, var(--card-background-color, #14162a));
      --rl-surface-2: var(--secondary-background-color, rgba(255, 255, 255, .05));
      --rl-text: var(--primary-text-color, #f4f5fb);
      --rl-muted: var(--secondary-text-color, rgba(228, 230, 255, .64));
      --rl-border: var(--divider-color, rgba(255, 255, 255, .14));
      --rl-accent: #6c8cff;
      --rl-accent-2: #7fe0ff;
      --rl-warn: #ffb648;
      --rl-hot: #ff5f6d;
      --rl-good: #57e6a1;
      display: block;
      color: var(--rl-text);
      font-family: var(--paper-font-body1_-_font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    * { box-sizing: border-box; }
    ha-card {
      overflow: hidden;
      border: 1px solid var(--rl-border);
      border-radius: var(--ha-card-border-radius, 26px);
      background:
        radial-gradient(circle at 10% -10%, rgba(108, 140, 255, .14), transparent 45%),
        radial-gradient(circle at 100% 115%, rgba(127, 224, 255, .10), transparent 45%),
        var(--rl-surface);
      box-shadow: var(--ha-card-box-shadow, 0 10px 30px rgba(0, 0, 0, .22));
    }
    .card-content { padding: clamp(16px, 3vw, 24px); }
    .rl-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .rl-title h2 {
      margin: 0;
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -.01em;
    }
    .rl-title .rl-sub {
      color: var(--rl-muted);
      font-size: 11px;
    }
    .rl-empty, .rl-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 130px;
      padding: 10px;
      color: var(--rl-muted);
      font-size: 12.5px;
      text-align: center;
    }
    .rl-empty ha-icon { --mdc-icon-size: 32px; opacity: .8; }
    .rl-empty strong { color: var(--rl-text); font-size: 14px; }
    .rl-empty span { max-width: 320px; line-height: 1.4; }
    .rl-footer {
      margin-top: 10px;
      color: var(--rl-muted);
      font-size: 10.5px;
      text-align: right;
    }
    .rl-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      border: 1px solid;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .02em;
      white-space: nowrap;
    }
    .rl-badge ha-icon { --mdc-icon-size: 12px; }
    .rl-badge.accent { color: #dbe4ff; border-color: rgba(108, 140, 255, .55); background: rgba(108, 140, 255, .18); }
    .rl-badge.warn { color: #ffe4bd; border-color: rgba(255, 182, 72, .55); background: rgba(255, 182, 72, .18); }
    .rl-badge.hot { color: #ffd7d9; border-color: rgba(255, 95, 109, .55); background: rgba(255, 95, 109, .20); }
    .rl-badge.good { color: #d3ffea; border-color: rgba(87, 230, 161, .5); background: rgba(87, 230, 161, .16); }
    .rl-badge.muted { color: var(--rl-muted); border-color: var(--rl-border); background: rgba(255, 255, 255, .04); }
  `;
}

function urgencyBadge(launch, phase) {
  if (phase === "stale") return `<span class="rl-badge muted"><ha-icon icon="mdi:help-circle-outline"></ha-icon>Awaiting update</span>`;
  if (phase === "window") return `<span class="rl-badge hot"><ha-icon icon="mdi:rocket-launch"></ha-icon>In launch window</span>`;
  if (launch.warning20m) return `<span class="rl-badge hot"><ha-icon icon="mdi:timer-alert-outline"></ha-icon>Final countdown</span>`;
  if (launch.warning24h) return `<span class="rl-badge warn"><ha-icon icon="mdi:timer-outline"></ha-icon>Launching soon</span>`;
  return `<span class="rl-badge accent"><ha-icon icon="mdi:calendar-clock"></ha-icon>Scheduled</span>`;
}

function delayBadge(delayInfo) {
  if (!delayInfo?.delayed) return "";
  return `<span class="rl-badge warn"><ha-icon icon="mdi:clock-alert-outline"></ha-icon>Slipped from ${escapeHtml(formatShortClock(delayInfo.originalTs))}</span>`;
}

// --- rocket-launch-card (main list) ----------------------------------------

class RocketLaunchCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULT_MAIN_CONFIG };
    this._hass = null;
    this._root = null;
    this._lastHtml = "";
    this._tickTimer = null;
    this._tickMs = null;
    this._connected = false;
  }

  setConfig(config) {
    if (!config) throw new Error("Rocket Launch Card configuration is required");
    this._config = {
      ...DEFAULT_MAIN_CONFIG,
      ...config,
      live_window_hours: clamp(Number.parseInt(config.live_window_hours, 10) || DEFAULT_MAIN_CONFIG.live_window_hours, 1, 96),
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._connected = true;
    pruneDelayStoreOnce();
    this._render();
  }

  disconnectedCallback() {
    this._connected = false;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _ensureTick(desiredMs) {
    if (!this._connected) return;
    if (this._tickMs === desiredMs && this._tickTimer) return;
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickMs = desiredMs;
    this._tickTimer = setInterval(() => this._render(), desiredMs);
  }

  _render() {
    if (!this.shadowRoot) return;
    const now = Date.now();

    if (!this._hass) {
      this._paint(`<ha-card><div class="card-content"><div class="rl-loading">Waiting for Home Assistant</div></div></ha-card>`);
      return;
    }

    const launches = collectLaunches(this._hass, this._config.entity_prefix);
    if (launches.length === 0) {
      this._paint(`<ha-card><div class="card-content">${this._header()}${integrationMissingHtml()}</div></ha-card>`);
      return;
    }

    const { matches, others } = splitLaunches(launches, this._config.site_filter);
    const liveWindowMs = this._config.live_window_hours * 60 * 60 * 1000;
    const nearestMs = matches.length && matches[0].targetTs != null ? matches[0].targetTs * 1000 - now : Infinity;
    this._ensureTick(nearestMs < FAST_TICK_THRESHOLD_MS ? FAST_TICK_MS : SLOW_TICK_MS);

    const body = matches.length === 0 ? this._emptyMatchHtml() : matches.map((launch) => this._renderLaunch(launch, now, liveWindowMs)).join("");

    const othersHtml =
      this._config.show_other_launches && others.length
        ? `
          <div class="rl-others-divider">Other tracked launches</div>
          <div class="rl-others">${others.map((launch) => this._renderCompactRow(launch, now)).join("")}</div>
        `
        : "";

    const freshest = [...matches, ...others].reduce((latest, l) => (l.lastUpdated > latest ? l.lastUpdated : latest), "");

    this._paint(`
      <ha-card>
        <div class="card-content">
          ${this._header()}
          <div class="rl-list">${body}</div>
          ${othersHtml}
          ${freshest ? `<div class="rl-footer">Data refreshed ${escapeHtml(formatAgo(freshest, now))}</div>` : ""}
        </div>
      </ha-card>
    `);
  }

  _header() {
    return `
      <div class="rl-title">
        <h2>${escapeHtml(this._config.title || DEFAULT_MAIN_CONFIG.title)}</h2>
        <span class="rl-sub">Next 5 tracked globally</span>
      </div>
    `;
  }

  _emptyMatchHtml() {
    const filter = this._config.site_filter?.trim();
    return `
      <div class="rl-empty">
        <ha-icon icon="mdi:rocket-outline"></ha-icon>
        <strong>No ${escapeHtml(filter || "matching")} launches right now</strong>
        <span>The integration only tracks the next 5 launches worldwide, so a ${escapeHtml(filter || "matching")} launch further out won't appear here yet.</span>
      </div>
    `;
  }

  _renderLaunch(launch, now, liveWindowMs) {
    const phase = launchPhase(launch, now);
    const isLive = launch.targetTs != null && launch.targetTs * 1000 - now < liveWindowMs;
    return isLive ? this._renderHero(launch, now, phase) : this._renderCompactRow(launch, now);
  }

  _renderHero(launch, now, phase) {
    const delayInfo = trackDelay(launch);
    const seconds = launch.targetTs != null ? launch.targetTs - now / 1000 : 0;
    const countdown = phase === "counting" ? formatCountdown(seconds) : phase === "window" ? formatCountdown(seconds) : "— : — : —";
    const urgent = phase === "window" || launch.warning20m;
    const missionLine = launch.missions ? launch.missions.split("|").map((m) => m.trim()).filter(Boolean).join(" · ") : launch.name;

    return `
      <article class="hero ${urgent ? "imminent" : ""}">
        <div class="hero-top">
          ${urgencyBadge(launch, phase)}
          ${delayBadge(delayInfo)}
        </div>
        <div class="hero-name">${escapeHtml(missionLine)}</div>
        <div class="hero-meta">${escapeHtml(launch.provider)}${launch.vehicle ? ` · ${escapeHtml(launch.vehicle)}` : ""}</div>
        <div class="hero-countdown">${escapeHtml(countdown)}</div>
        <div class="hero-detail">
          <span><ha-icon icon="mdi:map-marker-outline"></ha-icon>${escapeHtml(launch.pad)}</span>
          ${launch.targetTs != null ? `<span><ha-icon icon="mdi:clock-outline"></ha-icon>${escapeHtml(formatClock(launch.targetTs))}</span>` : ""}
          ${this._config.show_weather && launch.weatherSummary ? `<span><ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>${escapeHtml(launch.weatherSummary)}${launch.weatherTemp ? ` (${escapeHtml(String(launch.weatherTemp))}°)` : ""}</span>` : ""}
        </div>
        ${this._config.show_description && launch.description ? `<div class="hero-description">${escapeHtml(launch.description)}</div>` : ""}
      </article>
    `;
  }

  _renderCompactRow(launch, now) {
    const delayInfo = trackDelay(launch);
    const when = launch.targetTs != null ? formatClock(launch.targetTs) : launch.dateTarget || (launch.estDate ? `NET ${formatDateOnly(launch.estDate)}` : "Date TBD");
    return `
      <div class="rl-row">
        <div class="rl-row-main">
          <span class="rl-row-name">${escapeHtml(launch.name)}</span>
          <span class="rl-row-meta">${escapeHtml(launch.provider)} · ${escapeHtml(launch.pad)}</span>
        </div>
        <div class="rl-row-side">
          ${delayBadge(delayInfo)}
          <span class="rl-row-when">${escapeHtml(when)}</span>
        </div>
      </div>
    `;
  }

  _paint(html) {
    if (this._root && html === this._lastHtml) return;
    this._lastHtml = html;
    if (!this._root) {
      const style = document.createElement("style");
      style.textContent = baseStyles() + this._styles();
      const root = document.createElement("div");
      root.className = "rl-root";
      this.shadowRoot.replaceChildren(style, root);
      this._root = root;
    }
    this._root.innerHTML = html;
  }

  _styles() {
    return `
      .rl-list { display: flex; flex-direction: column; gap: 10px; }
      .hero {
        position: relative;
        overflow: hidden;
        padding: 16px 18px;
        border: 1px solid var(--rl-border);
        border-radius: 20px;
        background:
          radial-gradient(circle at 12% -20%, rgba(108, 140, 255, .30), transparent 55%),
          radial-gradient(circle at 105% 130%, rgba(127, 224, 255, .18), transparent 50%),
          var(--rl-surface-2);
      }
      .hero.imminent {
        border-color: rgba(255, 95, 109, .5);
        animation: rl-pulse 2.4s ease-in-out infinite;
      }
      @keyframes rl-pulse {
        0%, 100% { box-shadow: 0 0 0 rgba(255, 95, 109, 0); }
        50% { box-shadow: 0 0 26px rgba(255, 95, 109, .28); }
      }
      .hero-top { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .hero-name { font-size: 18px; font-weight: 800; letter-spacing: -.01em; }
      .hero-meta { margin-top: 2px; color: var(--rl-muted); font-size: 12px; }
      .hero-countdown {
        margin: 12px 0;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        font-size: clamp(26px, 6vw, 36px);
        font-weight: 700;
        letter-spacing: .02em;
        background: linear-gradient(90deg, var(--rl-accent-2), var(--rl-accent));
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .hero-detail {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--rl-muted);
        font-size: 11.5px;
      }
      .hero-detail span { display: inline-flex; align-items: center; gap: 4px; }
      .hero-detail ha-icon { --mdc-icon-size: 13px; }
      .hero-description {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--rl-border);
        color: var(--rl-muted);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .rl-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 14px;
        border: 1px solid var(--rl-border);
        border-radius: 14px;
        background: rgba(255, 255, 255, .03);
      }
      .rl-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .rl-row-name { font-size: 13.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rl-row-meta { color: var(--rl-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rl-row-side { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      .rl-row-when { color: var(--rl-muted); font-size: 11.5px; font-weight: 600; white-space: nowrap; }
      .rl-others-divider {
        margin: 14px 0 8px;
        padding-top: 12px;
        border-top: 1px solid var(--rl-border);
        color: var(--rl-muted);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .rl-others { display: flex; flex-direction: column; gap: 8px; }
      @media (max-width: 500px) {
        .hero-countdown { font-size: clamp(22px, 8vw, 30px); }
        .rl-row-meta { display: none; }
      }
    `;
  }

  getCardSize() {
    return 4;
  }

  static getConfigElement() {
    return document.createElement("rocket-launch-card-editor");
  }

  static getStubConfig() {
    return { ...DEFAULT_MAIN_CONFIG };
  }
}

// --- rocket-launch-countdown-card ------------------------------------------

class RocketLaunchCountdownCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULT_COUNTDOWN_CONFIG };
    this._hass = null;
    this._root = null;
    this._lastHtml = "";
    this._tickTimer = null;
    this._tickMs = null;
    this._connected = false;
  }

  setConfig(config) {
    if (!config) throw new Error("Rocket Launch Countdown Card configuration is required");
    this._config = {
      ...DEFAULT_COUNTDOWN_CONFIG,
      ...config,
      trigger_hours: clamp(Number.parseInt(config.trigger_hours, 10) || DEFAULT_COUNTDOWN_CONFIG.trigger_hours, 1, 48),
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._connected = true;
    pruneDelayStoreOnce();
    this._render();
  }

  disconnectedCallback() {
    this._connected = false;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _ensureTick(desiredMs) {
    if (!this._connected) return;
    if (this._tickMs === desiredMs && this._tickTimer) return;
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickMs = desiredMs;
    this._tickTimer = setInterval(() => this._render(), desiredMs);
  }

  _render() {
    if (!this.shadowRoot) return;
    const now = Date.now();

    if (!this._hass) {
      this._paint(`<ha-card><div class="card-content"><div class="rl-loading">Waiting for Home Assistant</div></div></ha-card>`, true);
      return;
    }

    const launches = collectLaunches(this._hass, this._config.entity_prefix);
    if (launches.length === 0) {
      this._paint(`<ha-card><div class="card-content">${integrationMissingHtml()}</div></ha-card>`, true);
      return;
    }

    const { matches } = splitLaunches(launches, this._config.site_filter);
    const next = matches[0];
    const triggerMs = this._config.trigger_hours * 60 * 60 * 1000;
    const withinWindow = next && next.targetTs != null && next.targetTs * 1000 - now <= triggerMs;

    if (!next || !withinWindow) {
      this._ensureTick(DORMANT_TICK_MS);
      if (!this._config.show_when_inactive) {
        this._paint("", true);
        return;
      }
      this._paint(this._dormantHtml(next, now), false);
      return;
    }

    const nearestMs = next.targetTs * 1000 - now;
    this._ensureTick(nearestMs < FAST_TICK_THRESHOLD_MS ? FAST_TICK_MS : SLOW_TICK_MS);
    this._paint(this._activeHtml(next, now), false);
  }

  _dormantHtml(next, now) {
    const summary = next
      ? next.targetTs != null
        ? `Next ${this._siteLabel()} launch in ${formatRelative(next.targetTs - now / 1000)} — countdown appears at T-${this._config.trigger_hours}h`
        : `Next ${this._siteLabel()} launch: ${next.dateTarget || "date TBD"}`
      : `No ${this._siteLabel()} launch in the next 5 tracked globally right now`;
    return `
      <ha-card>
        <div class="card-content rl-dormant">
          <ha-icon icon="mdi:rocket-outline"></ha-icon>
          <span>${escapeHtml(summary)}</span>
        </div>
      </ha-card>
    `;
  }

  _activeHtml(launch, now) {
    const delayInfo = trackDelay(launch);
    const phase = launchPhase(launch, now);
    const seconds = launch.targetTs - now / 1000;
    const countdown = phase === "stale" ? "Awaiting updated status…" : formatCountdown(seconds);
    const missionLine = launch.missions ? launch.missions.split("|").map((m) => m.trim()).filter(Boolean).join(" · ") : launch.name;
    const urgent = phase === "window" || launch.warning20m;

    return `
      <ha-card>
        <div class="card-content">
          <div class="rl-title">
            <h2>${escapeHtml(this._config.title || DEFAULT_COUNTDOWN_CONFIG.title)}</h2>
            ${urgencyBadge(launch, phase)}
          </div>
          <div class="cd-wrap ${urgent ? "imminent" : ""}">
            <div class="cd-name">${escapeHtml(missionLine)}</div>
            <div class="cd-meta">${escapeHtml(launch.provider)}${launch.vehicle ? ` · ${escapeHtml(launch.vehicle)}` : ""}</div>
            <div class="cd-big ${phase === "stale" ? "cd-big-text" : ""}">${escapeHtml(countdown)}</div>
            ${delayBadge(delayInfo)}
            <div class="cd-detail">
              <span><ha-icon icon="mdi:map-marker-outline"></ha-icon>${escapeHtml(launch.pad)}</span>
              <span><ha-icon icon="mdi:clock-outline"></ha-icon>${escapeHtml(formatClock(launch.targetTs))}</span>
              ${launch.weatherSummary ? `<span><ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>${escapeHtml(launch.weatherSummary)}</span>` : ""}
            </div>
          </div>
        </div>
      </ha-card>
    `;
  }

  _siteLabel() {
    return this._config.site_filter?.trim() || "tracked";
  }

  _paint(html, allowEmpty) {
    if (allowEmpty && !html) {
      this.style.display = "none";
      if (this._root) this._root.innerHTML = "";
      this._lastHtml = "";
      return;
    }
    this.style.display = "";
    if (this._root && html === this._lastHtml) return;
    this._lastHtml = html;
    if (!this._root) {
      const style = document.createElement("style");
      style.textContent = baseStyles() + this._styles();
      const root = document.createElement("div");
      root.className = "rl-root";
      this.shadowRoot.replaceChildren(style, root);
      this._root = root;
    }
    this._root.innerHTML = html;
  }

  _styles() {
    return `
      .rl-dormant {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: auto;
        padding: 4px 2px;
        color: var(--rl-muted);
        font-size: 12px;
      }
      .rl-dormant ha-icon { --mdc-icon-size: 18px; flex: 0 0 auto; }
      .cd-wrap {
        position: relative;
        overflow: hidden;
        padding: 18px;
        border: 1px solid var(--rl-border);
        border-radius: 20px;
        text-align: center;
        background:
          radial-gradient(circle at 50% -30%, rgba(108, 140, 255, .32), transparent 60%),
          var(--rl-surface-2);
      }
      .cd-wrap.imminent {
        border-color: rgba(255, 95, 109, .55);
        animation: rl-pulse 2.4s ease-in-out infinite;
      }
      .cd-name { font-size: 17px; font-weight: 800; }
      .cd-meta { margin-top: 2px; color: var(--rl-muted); font-size: 12px; }
      .cd-big {
        margin: 14px 0;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        font-size: clamp(32px, 9vw, 52px);
        font-weight: 700;
        letter-spacing: .01em;
        background: linear-gradient(90deg, var(--rl-accent-2), var(--rl-accent));
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .cd-big-text {
        font-family: inherit;
        font-size: 16px;
        font-weight: 700;
        background: none;
        -webkit-text-fill-color: initial;
        color: var(--rl-muted);
      }
      .cd-detail {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 12px;
        margin-top: 8px;
        color: var(--rl-muted);
        font-size: 11.5px;
      }
      .cd-detail span { display: inline-flex; align-items: center; gap: 4px; }
      .cd-detail ha-icon { --mdc-icon-size: 13px; }
    `;
  }

  getCardSize() {
    return this.style.display === "none" ? 1 : 3;
  }

  static getConfigElement() {
    return document.createElement("rocket-launch-countdown-card-editor");
  }

  static getStubConfig() {
    return { ...DEFAULT_COUNTDOWN_CONFIG };
  }
}

// --- Registration ------------------------------------------------------

window.customCards = window.customCards || [];
[
  {
    type: "rocket-launch-card",
    name: "Rocket Launch Card",
    description: "Upcoming launches filtered to your launch site, with a live countdown for near-term launches",
    preview: true,
    documentationURL: "https://github.com/Tmatz27/ha-rocket-launch-card-",
  },
  {
    type: "rocket-launch-countdown-card",
    name: "Rocket Launch Countdown Card",
    description: "A big live countdown that appears once the next matching launch is close",
    preview: true,
    documentationURL: "https://github.com/Tmatz27/ha-rocket-launch-card-",
  },
].forEach((card) => {
  if (!window.customCards.some((existing) => existing?.type === card.type)) {
    window.customCards.push(card);
  }
});

try {
  const registrations = [
    ["rocket-launch-card-editor", RocketLaunchCardEditor],
    ["rocket-launch-countdown-card-editor", RocketLaunchCountdownCardEditor],
    ["rocket-launch-card", RocketLaunchCard],
    ["rocket-launch-countdown-card", RocketLaunchCountdownCard],
  ];
  for (const [tag, ctor] of registrations) {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  }
} catch (error) {
  console.error("Rocket Launch Card could not register its custom elements", error);
}

console.info(
  `%c Rocket Launch Card %c v${ROCKET_LAUNCH_CARD_VERSION} `,
  "color: white; background: #4a5bc7; font-weight: 700;",
  "color: #4a5bc7; background: transparent;",
);
