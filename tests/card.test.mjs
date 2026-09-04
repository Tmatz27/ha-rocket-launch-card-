import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../rocket-launch-card.js", import.meta.url), "utf8");
const registry = new Map();

class FakeNode {
  constructor(localName = "div") {
    this.localName = localName;
    this.className = "";
    this.children = [];
    this._html = "";
    this._listeners = new Map();
  }

  set innerHTML(value) {
    this._html = value;
  }

  get innerHTML() {
    return this._html;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  replaceWith() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  // Real (if minimal) event plumbing: the card delegates row-click/keydown
  // handling to one listener on the persistent root element (see
  // rocket-launch-card.js's _paint), so tests exercise it via dispatchEvent
  // rather than calling the private handler directly.
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event) {
    const handlers = this._listeners.get(event.type);
    if (handlers) for (const handler of handlers) handler(event);
    return true;
  }
}

class FakeHTMLElement {
  constructor() {
    this.style = {};
  }

  attachShadow() {
    this.shadowRoot = new FakeNode("#shadow-root");
    return this.shadowRoot;
  }
}

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const sandbox = {
  HTMLElement: FakeHTMLElement,
  CustomEvent: class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
  customElements: {
    define(name, constructor) {
      registry.set(name, constructor);
    },
    get(name) {
      return registry.get(name);
    },
  },
  document: {
    createElement(name) {
      return new FakeNode(name);
    },
  },
  window: { customCards: [] },
  console: { info() {}, error() {} },
  localStorage: makeFakeLocalStorage(),
  setInterval: () => 0,
  clearInterval: () => {},
};

vm.runInNewContext(source, sandbox, { filename: "rocket-launch-card.js" });

const Card = registry.get("rocket-launch-card");
const CardEditor = registry.get("rocket-launch-card-editor");
const CountdownCard = registry.get("rocket-launch-countdown-card");
const CountdownCardEditor = registry.get("rocket-launch-countdown-card-editor");

test("registers both card types and both editors", () => {
  assert.ok(Card, "rocket-launch-card should be registered");
  assert.ok(CardEditor, "rocket-launch-card-editor should be registered");
  assert.ok(CountdownCard, "rocket-launch-countdown-card should be registered");
  assert.ok(CountdownCardEditor, "rocket-launch-countdown-card-editor should be registered");
});

test("announces both cards to the dashboard picker", () => {
  const types = sandbox.window.customCards.map((c) => c.type);
  assert.ok(types.includes("rocket-launch-card"));
  assert.ok(types.includes("rocket-launch-countdown-card"));
});

// --- fixtures ---------------------------------------------------------
// Shape matches what the ha-rocket-launch-tracker integration's api.py
// parse_launch() produces, which is what ends up in the "Upcoming Launches"
// sensor's `launches` attribute.

function makeRawLaunch({
  id = "abc-123",
  name = "Falcon 9 Block 5 | Starlink Group 12-3",
  missionName = "Starlink Group 12-3",
  provider = "SpaceX",
  rocket = "Falcon 9",
  padName = "Space Launch Complex 4E",
  locationName = "Vandenberg SFB, CA, USA",
  status = "Go for Launch",
  statusAbbrev = "Go",
  net = null,
  windowStart = null,
  netPrecision = null,
  probability = null,
  description = "",
  orbit = null,
  landingAttempt = undefined,
  landingLocation = null,
} = {}) {
  return {
    id,
    name,
    mission_name: missionName,
    mission_description: description,
    status,
    status_abbrev: statusAbbrev,
    provider,
    rocket,
    orbit,
    landing_attempt: landingAttempt,
    landing_location: landingLocation,
    pad_name: padName,
    location_name: locationName,
    net,
    window_start: windowStart,
    window_end: null,
    net_precision: netPrecision,
    probability,
    image: "",
    webcast_live: false,
    hold_reason: "",
    fail_reason: "",
  };
}

function makeUpcomingState(launches, { siteFilter = "Vandenberg", lastUpdated } = {}) {
  return {
    state: String(launches.length),
    attributes: { site_filter: siteFilter, launches },
    last_updated: lastUpdated || new Date().toISOString(),
  };
}

// A minimal stand-in for a real DOM event target: the card's delegated
// handler only ever calls target.closest(selector), so that's all this needs
// to fake. Mirrors how a real click's target.closest("[data-launch-key]")
// would resolve to the row/hero ancestor carrying that attribute.
function fakeTargetWithLaunchKey(key) {
  return {
    closest(selector) {
      if (selector === "[data-launch-key]") return { dataset: { launchKey: key } };
      return null;
    },
  };
}

function render(card, config, hass) {
  card.setConfig(config);
  card.connectedCallback();
  card.hass = hass;
  return card._root.innerHTML;
}

const ENTITY_ID = "sensor.vandenberg_upcoming_launches";

// --- rocket-launch-card -------------------------------------------------

test("main card shows a near-term launch with a live countdown", () => {
  const nowIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: nowIso })]),
    },
  };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /class="hero/, "near-term launch should render as a hero card");
  assert.match(html, /Starlink Group 12-3/);
  assert.match(html, /Space Launch Complex 4E/);
  assert.match(html, /Go for Launch/);
  assert.match(html, /\d{2}:\d{2}:\d{2}/, "hero card should show a ticking countdown");
});

test("main card shows a far-out launch as a compact row, not a hero", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.doesNotMatch(html, /class="hero/);
  assert.match(html, /rl-row/);
  assert.match(html, /Starlink Group 12-3/);
});

test("main card shows a NET/date-only launch without a fake countdown", () => {
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: null, netPrecision: "Month" })]),
    },
  };
  const html = render(new Card(), { entity: ENTITY_ID }, hass);

  assert.match(html, /Month precision/);
  assert.doesNotMatch(html, /class="hero/, "a launch with no known time should never render as a live countdown");
});

test("main card always shows an In Flight launch as a hero, regardless of window", () => {
  const pastIso = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ net: pastIso, status: "In Flight", statusAbbrev: "InFlight" }),
      ]),
    },
  };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 1 }, hass);

  assert.match(html, /class="hero/);
  assert.match(html, /In Flight/);
});

test("main card shows a friendly empty state when nothing is tracked", () => {
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([], { siteFilter: "Vandenberg" }) } };
  const html = render(new Card(), { entity: ENTITY_ID }, hass);

  assert.match(html, /No upcoming launches tracked/);
  assert.match(html, /Vandenberg/);
});

test("main card asks for a sensor when none is configured", () => {
  const html = render(new Card(), { entity: "" }, { states: {} });
  assert.match(html, /No sensor selected/);
});

test("main card reports when the configured entity doesn't exist", () => {
  const html = render(new Card(), { entity: ENTITY_ID }, { states: {} });
  assert.match(html, /Sensor not found/);
});

test("main card flags a launch that has slipped later than first observed", () => {
  const card = new Card();
  const baseMs = Date.now() + 3600 * 1000;

  render(card, { entity: ENTITY_ID }, {
    states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "same-id", net: new Date(baseMs).toISOString() })]) },
  });

  // Same launch id, later net time - simulates the next poll picking up a delay.
  const html = render(card, { entity: ENTITY_ID }, {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ id: "same-id", net: new Date(baseMs + 3600 * 1000).toISOString() }),
      ]),
    },
  });

  assert.match(html, /Slipped from/);
});

test("max_launches caps how many launches the main card renders", () => {
  const launches = [0, 1, 2].map((i) =>
    makeRawLaunch({
      id: `launch-${i}`,
      missionName: `Mission ${i}`,
      net: new Date(Date.now() + (96 + i * 24) * 3600 * 1000).toISOString(),
    }),
  );
  const hass = { states: { [ENTITY_ID]: makeUpcomingState(launches) } };
  const html = render(new Card(), { entity: ENTITY_ID, max_launches: 1 }, hass);

  assert.match(html, /Mission 0/);
  assert.doesNotMatch(html, /Mission 1/);
  assert.doesNotMatch(html, /Mission 2/);
});

test("max_launches of 0 (default) shows every launch the sensor provides", () => {
  const launches = [0, 1, 2].map((i) =>
    makeRawLaunch({
      id: `launch-${i}`,
      missionName: `Mission ${i}`,
      net: new Date(Date.now() + (96 + i * 24) * 3600 * 1000).toISOString(),
    }),
  );
  const hass = { states: { [ENTITY_ID]: makeUpcomingState(launches) } };
  const html = render(new Card(), { entity: ENTITY_ID }, hass);

  assert.match(html, /Mission 0/);
  assert.match(html, /Mission 1/);
  assert.match(html, /Mission 2/);
});

test("Hold status renders with the hot (red) tone, not the old warning tone", () => {
  const farIso = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
  const hass = {
    states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso, status: "Hold", statusAbbrev: "Hold" })]) },
  };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /rl-badge hot/);
});

test("Go status renders with the good (green) tone", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso, status: "Go for Launch", statusAbbrev: "Go" })]),
    },
  };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /--rl-tone: var\(--rl-good\)/);
});

test("provider renders as a neutral pill badge, not plain text", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso, provider: "SpaceX" })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /rl-badge neutral small/);
  assert.match(html, />SpaceX</);
});

test("the background watermark icon is gone", () => {
  const farIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID }, hass);

  assert.doesNotMatch(html, /rl-watermark/);
});

test("compact row shows a T-minus line beneath the formatted date", () => {
  const farIso = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /rl-row-when/, "the static formatted date should still be present");
  assert.match(html, /T- 1[34] days?/, "a relative T-minus line should appear beneath it");
});

test("compact row's T-minus line switches to hours inside a day", () => {
  const soonIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: soonIso })]) } };
  // live_window_hours below 5 keeps this a compact row even though it's under 24h out.
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 1 }, hass);

  assert.match(html, /rl-tier-imminent/);
  assert.match(html, /\d{2}:\d{2}:\d{2}/, "under 24h the T-minus line becomes a live countdown");
});

test("clicking a compact row expands its accordion, and clicking again collapses it", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso })]),
    },
  };
  let html = render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /rl-row-expand-attached open/);

  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });
  html = card._root.innerHTML;
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /rl-row-expand-attached open/);

  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });
  html = card._root.innerHTML;
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /rl-row-expand-attached open/);
});

test("a click inside the expanded panel doesn't collapse it", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso })]) } };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });
  assert.match(card._root.innerHTML, /aria-expanded="true"/);

  // Simulates a click landing inside .rl-row-expand itself (e.g. on a badge),
  // which should not also match [data-launch-key] via closest().
  card._root.dispatchEvent({
    type: "click",
    target: { closest: (selector) => (selector === ".rl-row-expand" ? {} : null) },
  });
  assert.match(card._root.innerHTML, /aria-expanded="true"/, "still expanded");
});

test("Enter/Space toggle the accordion the same as a click", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso })]) } };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  const noop = () => {};
  card._root.dispatchEvent({ type: "keydown", key: "Tab", target: fakeTargetWithLaunchKey("id:row-1"), preventDefault: noop });
  assert.match(card._root.innerHTML, /aria-expanded="false"/, "an unrelated key should not toggle");

  card._root.dispatchEvent({ type: "keydown", key: "Enter", target: fakeTargetWithLaunchKey("id:row-1"), preventDefault: noop });
  assert.match(card._root.innerHTML, /aria-expanded="true"/);
});

test("accordion shows rocket and orbit pill badges", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso, rocket: "Falcon 9", orbit: "Low Earth Orbit" })]),
    },
  };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });

  const html = card._root.innerHTML;
  assert.match(html, /mdi:rocket"/);
  assert.match(html, />Falcon 9</);
  assert.match(html, /mdi:orbit/);
  assert.match(html, />Low Earth Orbit</);
});

test("accordion shows an Expendable badge when landing_attempt is confirmed false", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = {
    states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso, landingAttempt: false })]) },
  };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });

  assert.match(card._root.innerHTML, /Expendable/);
});

test("accordion shows the aggressive RTLS warning badge for a Vandenberg/LZ landing", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ id: "row-1", net: farIso, landingAttempt: true, landingLocation: "Landing Zone 1 (LZ-1)" }),
      ]),
    },
  };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });

  const html = card._root.innerHTML;
  assert.match(html, /rtls-warning/);
  assert.match(html, /Sonic Boom Expected/);
});

test("accordion uses plain neutral styling for a drone-ship landing", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ id: "row-1", net: farIso, landingAttempt: true, landingLocation: "Of Course I Still Love You" }),
      ]),
    },
  };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });

  const html = card._root.innerHTML;
  assert.doesNotMatch(html, /rtls-warning/);
  assert.match(html, /Of Course I Still Love You/);
});

test("accordion shows no landing badge at all when landing_attempt is unknown", () => {
  const farIso = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
  const card = new Card();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ id: "row-1", net: farIso })]) } };
  render(card, { entity: ENTITY_ID, live_window_hours: 24 }, hass);
  card._root.dispatchEvent({ type: "click", target: fakeTargetWithLaunchKey("id:row-1") });

  const html = card._root.innerHTML;
  assert.doesNotMatch(html, /Expendable/);
  assert.doesNotMatch(html, /rtls-warning/);
  assert.doesNotMatch(html, /Landing:/);
});

test("compact row shows a live countdown and the imminent tier inside 24 hours", () => {
  const soonIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: soonIso })]) } };
  // live_window_hours below 24 keeps this a compact row despite being <24h out.
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 1 }, hass);

  assert.doesNotMatch(html, /class="hero/);
  assert.match(html, /rl-tier-imminent/);
  assert.match(html, /\d{2}:\d{2}:\d{2}/, "imminent compact row should show a live countdown, not a static clock");
});

test("compact row uses the warning tier inside 7 days", () => {
  const soonIso = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: soonIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.doesNotMatch(html, /class="hero/);
  assert.match(html, /rl-tier-soon/);
});

test("compact row uses the normal tier between 7 and 30 days", () => {
  const midIso = new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: midIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /rl-tier-normal/);
});

test("compact row uses the muted far tier beyond 30 days", () => {
  const farIso = new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const html = render(new Card(), { entity: ENTITY_ID, live_window_hours: 24 }, hass);

  assert.match(html, /rl-tier-far/);
});

// --- rocket-launch-countdown-card ---------------------------------------

test("countdown card stays compact/dormant outside the trigger window", () => {
  const farIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /rl-dormant/);
  assert.doesNotMatch(html, /cd-big/);
});

test("countdown card goes active with a big countdown inside the trigger window", () => {
  const soonIso = new Date(Date.now() + 1800 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: soonIso })]) } };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /cd-big/);
  assert.doesNotMatch(html, /rl-dormant/);
});

test("countdown card collapses to nothing when show_when_inactive is false", () => {
  const farIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso })]) } };
  const card = new CountdownCard();
  render(card, { entity: ENTITY_ID, trigger_hours: 2, show_when_inactive: false }, hass);

  assert.equal(card.style.display, "none");
});

test("countdown card shows an unconfirmed-status message instead of a runaway timer", () => {
  // 20 minutes past the predicted target with no updated timestamp.
  const overdueIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: overdueIso })]) } };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /Awaiting updated status/);
});

test("countdown card goes active for a Hold launch even outside the trigger window", () => {
  const farIso = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: farIso, status: "Hold", statusAbbrev: "Hold" })]),
    },
  };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /cd-big/);
});

test("countdown card shows provider, rocket, and orbit as pill badges, no watermark", () => {
  const soonIso = new Date(Date.now() + 1800 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ net: soonIso, provider: "SpaceX", rocket: "Falcon 9", orbit: "Geostationary Transfer Orbit" }),
      ]),
    },
  };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /rl-badge neutral small/);
  assert.match(html, />SpaceX</);
  assert.match(html, />Falcon 9</);
  assert.match(html, />Geostationary Transfer Orbit</);
  assert.doesNotMatch(html, /rl-watermark/);
});

test("countdown card shows the aggressive RTLS badge always-visible, no click needed", () => {
  const soonIso = new Date(Date.now() + 1800 * 1000).toISOString();
  const hass = {
    states: {
      [ENTITY_ID]: makeUpcomingState([
        makeRawLaunch({ net: soonIso, landingAttempt: true, landingLocation: "Vandenberg SFB Landing Zone" }),
      ]),
    },
  };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.match(html, /rtls-warning/);
  assert.match(html, /Sonic Boom Expected/);
});

test("countdown card omits the landing badge entirely when landing_attempt is unknown", () => {
  const soonIso = new Date(Date.now() + 1800 * 1000).toISOString();
  const hass = { states: { [ENTITY_ID]: makeUpcomingState([makeRawLaunch({ net: soonIso })]) } };
  const html = render(new CountdownCard(), { entity: ENTITY_ID, trigger_hours: 2 }, hass);

  assert.doesNotMatch(html, /cd-landing/);
});

// --- editors --------------------------------------------------------------

test("main card editor renders without throwing and reports config changes", () => {
  const editor = new CardEditor();
  editor.setConfig({ entity: ENTITY_ID });
  editor.connectedCallback();
  assert.match(editor.shadowRoot.innerHTML, /Upcoming launches sensor/);

  let detail = null;
  editor.addEventListener = (type, handler) => {
    if (type === "config-changed") editor._testHandler = handler;
  };
  editor.dispatchEvent = (event) => {
    detail = event.detail;
  };
  editor._update("live_window_hours", 12);
  assert.equal(detail.config.live_window_hours, 12);
});

test("main card editor includes the max launches field", () => {
  const editor = new CardEditor();
  editor.setConfig({ entity: ENTITY_ID });
  editor.connectedCallback();
  assert.match(editor.shadowRoot.innerHTML, /Maximum launches to show/);
});

test("countdown card editor renders without throwing", () => {
  const editor = new CountdownCardEditor();
  editor.setConfig({ trigger_hours: 3 });
  editor.connectedCallback();
  assert.match(editor.shadowRoot.innerHTML, /Appear this many hours before launch/);
});
