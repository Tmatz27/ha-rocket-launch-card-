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

function makeLaunchState({
  name = "Starlink 12-3",
  provider = "SpaceX",
  vehicle = "Falcon 9",
  pad = "Vandenberg SFB (SLC-4E)",
  usState = "CA",
  country = "USA",
  targetTs = null,
  dateTarget = "",
  estDate = "NA",
  warning20m = "false",
  warning24h = "false",
  lastUpdated,
} = {}) {
  return {
    state: `${name} (${provider})`,
    attributes: {
      name,
      provider,
      vehicle,
      launch_pad: pad,
      launch_US_state: usState,
      launch_location: country,
      launch_target_timestamp: targetTs === null ? "" : targetTs,
      launch_target: targetTs === null ? "NA" : "some formatted string",
      launch_date_target: dateTarget,
      est_launch_date: estDate,
      launch_20m_warning: warning20m,
      launch_24h_warning: warning24h,
      launch_missions: "",
      launch_description: "",
      tags: "",
      weather_summary: "",
      weather_temp: "",
    },
    last_updated: lastUpdated || new Date().toISOString(),
  };
}

function render(card, config, hass) {
  card.setConfig(config);
  card.connectedCallback();
  card.hass = hass;
  return card._root.innerHTML;
}

// --- rocket-launch-card -------------------------------------------------

test("main card shows a matching near-term launch with a live countdown", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec + 3600) }),
      "sensor.rocket_launch_2": makeLaunchState({
        name: "Some Other Mission",
        provider: "ULA",
        pad: "Cape Canaveral SFS (SLC-41)",
        usState: "FL",
        targetTs: Math.round(nowSec + 7200),
      }),
    },
  };
  const html = render(new Card(), { site_filter: "Vandenberg", live_window_hours: 24 }, hass);

  assert.match(html, /class="hero/, "near-term matching launch should render as a hero card");
  assert.match(html, /Starlink 12-3/);
  assert.match(html, /Vandenberg SFB/);
  assert.doesNotMatch(html, /Some Other Mission/, "non-matching launch should be hidden by default");
  assert.match(html, /\d{2}:\d{2}:\d{2}/, "hero card should show a ticking countdown");
});

test("main card shows a far-out matching launch as a compact row, not a hero", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec + 96 * 3600) }),
    },
  };
  const html = render(new Card(), { site_filter: "Vandenberg", live_window_hours: 24 }, hass);

  assert.doesNotMatch(html, /class="hero/);
  assert.match(html, /rl-row/);
  assert.match(html, /Starlink 12-3/);
});

test("main card shows a NET date-only launch without a fake countdown", () => {
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: null, dateTarget: "NET September 14, 2026" }),
    },
  };
  const html = render(new Card(), { site_filter: "Vandenberg" }, hass);

  assert.match(html, /NET September 14, 2026/);
  assert.doesNotMatch(html, /class="hero/, "a launch with no known time should never render as a live countdown");
});

test("main card shows a friendly empty state when nothing matches the site filter", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({
        name: "Some Other Mission",
        pad: "Cape Canaveral SFS (SLC-41)",
        usState: "FL",
        targetTs: Math.round(nowSec + 3600),
      }),
    },
  };
  const html = render(new Card(), { site_filter: "Vandenberg" }, hass);

  assert.match(html, /No Vandenberg launches/);
});

test("main card reports when no Rocket Launch Live sensors exist at all", () => {
  const html = render(new Card(), { site_filter: "Vandenberg" }, { states: {} });
  assert.match(html, /No Rocket Launch Live sensors found/);
});

test("main card flags a launch that has slipped later than first observed", () => {
  const card = new Card();
  const baseSec = Math.round(Date.now() / 1000) + 3600;
  const launch = makeLaunchState({ targetTs: baseSec });

  render(card, { site_filter: "Vandenberg" }, { states: { "sensor.rocket_launch_1": launch } });

  // Same mission identity (name/provider/pad), later target time - simulates
  // the next poll picking up a delay.
  const delayed = makeLaunchState({ targetTs: baseSec + 3600 });
  const html = render(card, { site_filter: "Vandenberg" }, { states: { "sensor.rocket_launch_1": delayed } });

  assert.match(html, /Slipped from/);
});

// --- rocket-launch-countdown-card ---------------------------------------

test("countdown card stays compact/dormant outside the trigger window", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec + 5 * 3600) }),
    },
  };
  const html = render(new CountdownCard(), { site_filter: "Vandenberg", trigger_hours: 2 }, hass);

  assert.match(html, /rl-dormant/);
  assert.doesNotMatch(html, /cd-big/);
});

test("countdown card goes active with a big countdown inside the trigger window", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec + 1800) }),
    },
  };
  const html = render(new CountdownCard(), { site_filter: "Vandenberg", trigger_hours: 2 }, hass);

  assert.match(html, /cd-big/);
  assert.doesNotMatch(html, /rl-dormant/);
});

test("countdown card collapses to nothing when show_when_inactive is false", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec + 5 * 3600) }),
    },
  };
  const card = new CountdownCard();
  render(card, { site_filter: "Vandenberg", trigger_hours: 2, show_when_inactive: false }, hass);

  assert.equal(card.style.display, "none");
});

test("countdown card shows an unconfirmed-status message instead of a runaway timer", () => {
  const nowSec = Date.now() / 1000;
  const hass = {
    states: {
      // 20 minutes past the predicted target with no updated timestamp.
      "sensor.rocket_launch_1": makeLaunchState({ targetTs: Math.round(nowSec - 20 * 60) }),
    },
  };
  const html = render(new CountdownCard(), { site_filter: "Vandenberg", trigger_hours: 2 }, hass);

  assert.match(html, /Awaiting updated status/);
});

// --- editors --------------------------------------------------------------

test("main card editor renders without throwing and reports config changes", () => {
  const editor = new CardEditor();
  editor.setConfig({ site_filter: "Vandenberg" });
  editor.connectedCallback();
  assert.match(editor.shadowRoot.innerHTML, /Site filter/);

  let detail = null;
  editor.addEventListener = (type, handler) => {
    if (type === "config-changed") editor._testHandler = handler;
  };
  editor.dispatchEvent = (event) => {
    detail = event.detail;
  };
  editor._update("site_filter", "Cape Canaveral");
  assert.equal(detail.config.site_filter, "Cape Canaveral");
});

test("countdown card editor renders without throwing", () => {
  const editor = new CountdownCardEditor();
  editor.setConfig({ trigger_hours: 3 });
  editor.connectedCallback();
  assert.match(editor.shadowRoot.innerHTML, /Appear this many hours before launch/);
});
