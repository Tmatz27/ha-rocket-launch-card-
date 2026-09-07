"""Render the shipped YAML with HA-style sequential variable serialization.

This is an offline regression harness, not a running Home Assistant instance.
Unlike Jinja NativeEnvironment, HA renders text then parses simple literals;
a datetime output remains a string. Preserve that boundary to catch the bug
reported in 0.3.1. See homeassistant/helpers/template.py::_parse_result.
"""
import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

from jinja2 import StrictUndefined
from jinja2.sandbox import ImmutableSandboxedEnvironment
import yaml

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ZoneInfo('America/Los_Angeles')
ENTITY = 'sensor.vandenberg_next_launch'
HELPER = 'input_text.launch_alert'


class Input(str):
    pass


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor('!input', lambda loader, node: Input(loader.construct_scalar(node)))


def local(value):
    return datetime.fromisoformat(value).replace(tzinfo=LOCAL)


class Harness:
    def __init__(self, name, now='2026-09-06T12:00:00', launch='2026-09-06T13:00:00',
                 helper='', launch_id='launch-1', status='Go', label='Go for Launch', **inputs):
        self.blueprint = yaml.load((ROOT / f'blueprints/automation/rocket_launch_{name}_alert.yaml').read_text(encoding='utf-8'), Loader=Loader)
        self.inputs = {key: value['default'] for key, value in self.blueprint['blueprint']['input'].items() if 'default' in value}
        self.inputs.update(next_launch_entity=ENTITY, dedup_helper=HELPER, history_helper=HELPER, notify_service='notify.test')
        self.inputs.update(inputs)
        self.now = local(now)
        # Valid fixtures include a local offset, just like a timestamp sensor.
        try:
            parsed = datetime.fromisoformat(launch.replace('Z', '+00:00'))
            self.raw = (parsed if parsed.tzinfo else parsed.replace(tzinfo=LOCAL)).isoformat()
        except (ValueError, TypeError, AttributeError):
            self.raw = launch
        self.states = {ENTITY: self.raw, HELPER: helper}
        self.attrs = {'launch_id': launch_id, 'status_abbrev': status, 'status': label,
                      'name': 'Test mission', 'provider': 'SpaceX', 'pad_name': 'SLC-4E'}
        self.env = ImmutableSandboxedEnvironment(undefined=StrictUndefined)
        self.env.globals.update(now=lambda: self.now, timedelta=timedelta,
            states=lambda entity: self.states.get(entity, 'unknown'),
            state_attr=lambda entity, name: self.attrs.get(name),
            as_datetime=self.as_datetime, as_local=lambda dt: dt.astimezone(LOCAL),
            as_timestamp=self.as_timestamp, today_at=self.today_at)
        self.env.filters.update(as_timestamp=self.as_timestamp, timestamp_custom=self.timestamp_custom)
        self.context = {}
        for key, value in self.blueprint['variables'].items():
            self.context[key] = self.render(value)
        self.notifications = []
        self.writes = []

    def as_datetime(self, value, default=None):
        try:
            if isinstance(value, datetime):
                return value
            if isinstance(value, (int, float)):
                return datetime.fromtimestamp(value, timezone.utc)
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return dt if dt.tzinfo else dt.replace(tzinfo=LOCAL)
        except (ValueError, TypeError, AttributeError, OverflowError):
            return default

    def as_timestamp(self, value, default=None):
        dt = self.as_datetime(value)
        return dt.timestamp() if dt else default

    def today_at(self, value):
        parts = [int(p) for p in value.split(':')]
        return self.now.replace(hour=parts[0], minute=parts[1], second=parts[2] if len(parts) > 2 else 0, microsecond=0)

    def timestamp_custom(self, value, fmt, local_time=True):
        dt = datetime.fromtimestamp(value, LOCAL if local_time else timezone.utc)
        # Windows strftime lacks %-I; this doesn't affect decision logic.
        return dt.strftime(fmt.replace('%-I', '%I'))

    def render(self, value):
        if isinstance(value, Input):
            return self.inputs[value]
        if isinstance(value, str) and ('{{' in value or '{%' in value):
            result = self.env.from_string(value).render(self.context).strip()
            try:
                parsed = ast.literal_eval(result)
                if isinstance(parsed, (str, int, float, bool, list, dict, tuple)) or parsed is None:
                    return parsed
            except (ValueError, SyntaxError):
                pass
            return result
        if isinstance(value, dict):
            return {key: self.render(item) for key, item in value.items()}
        return value

    def conditions(self, conditions):
        return all(self.render(c['value_template']) is True for c in conditions)

    def run(self, manual=False, fail_notify=False):
        if not manual and not self.conditions(self.blueprint.get('condition', [])):
            return
        self.sequence(self.blueprint['action'], fail_notify)

    def sequence(self, steps, fail_notify):
        for step in steps:
            if 'condition' in step:
                if not self.conditions([step]):
                    return
            elif 'choose' in step:
                for choice in step['choose']:
                    if self.conditions(choice['conditions']):
                        self.sequence(choice['sequence'], fail_notify)
                        break
            else:
                action = self.render(step['action'])
                data = self.render(step.get('data', {}))
                if action == 'input_text.set_value':
                    self.writes.append(data['value'])
                    self.states[self.render(step['target']['entity_id'])] = data['value']
                elif action == 'notify.test':
                    if fail_notify:
                        raise RuntimeError('notify failed')
                    self.notifications.append(data)
                else:
                    raise AssertionError(action)


class BlueprintTests(unittest.TestCase):
    def test_harness_reproduces_original_datetime_boundary_errors(self):
        h = Harness('day')
        h.context['next_dt'] = h.render('{{ as_local(as_datetime(raw_state)) }}')
        self.assertIsInstance(h.context['next_dt'], str)
        with self.assertRaises(Exception):
            h.render('{{ next_dt.date() == now().date() }}')
        with self.assertRaises(TypeError):
            h.render('{{ next_dt > now() }}')

    def test_day_future_today(self):
        h = Harness('day'); h.run()
        self.assertEqual(len(h.notifications), 1)
        self.assertIn('01:00 PM', h.notifications[0]['message'])

    def test_day_uses_local_calendar_not_utc(self):
        h = Harness('day', now='2026-09-06T19:00:00', launch='2026-09-07T03:00:00Z'); h.run()
        self.assertEqual(len(h.notifications), 1)
        h = Harness('day', now='2026-09-06T23:00:00', launch='2026-09-07T08:00:00Z'); h.run()
        self.assertEqual(h.notifications, [])

    def test_day_past_does_not_notify_even_on_manual_run(self):
        h = Harness('day', launch='2026-09-06T07:26:00'); h.run(manual=True)
        self.assertEqual(h.notifications, [])

    def test_invalid_states_are_safe_and_silent(self):
        for name in ['day', 'countdown', 'pet_safety', 'reschedule']:
            for raw in ['unknown', 'unavailable', 'none', '', 'not-a-date', '2026-99-99']:
                with self.subTest(name=name, raw=raw):
                    h = Harness(name, launch=raw); h.run(manual=True)
                    self.assertEqual(h.notifications, [])
                    self.assertEqual(h.writes, [])

    def test_completed_and_inflight_statuses_never_send_prelaunch_alerts(self):
        for name in ['day', 'countdown', 'pet_safety', 'reschedule']:
            for status in ['Success', 'Failure', 'Partial Failure', 'InFlight']:
                with self.subTest(name=name, status=status):
                    h = Harness(name, now='2026-09-06T12:50:00', status=status); h.run(manual=True)
                    self.assertEqual(h.notifications, [])
                    self.assertEqual(h.writes, [])

    def test_completed_text_without_abbreviation_is_silent(self):
        for name in ['day', 'countdown', 'pet_safety', 'reschedule']:
            h = Harness(name, status='', label='Launch Successful'); h.run(manual=True)
            self.assertEqual(h.notifications, [])

    def test_countdown_normal_lead_threshold_and_dedup(self):
        h = Harness('countdown', now='2026-09-06T11:59:00'); h.run()
        self.assertEqual(h.notifications, [])
        h = Harness('countdown'); h.run()
        self.assertEqual(len(h.notifications), 1)
        self.assertIn('60 min', h.notifications[0]['message'])
        again = Harness('countdown', helper=h.writes[0]); again.run(manual=True)
        self.assertEqual(again.notifications, [])

    def test_countdown_does_not_fire_days_early_at_todays_bedtime(self):
        h = Harness('countdown', now='2026-09-06T20:30:00', launch='2026-09-10T08:37:00'); h.run(manual=True)
        self.assertEqual(h.notifications, [])

    def test_countdown_late_evening_uses_that_days_fallback(self):
        for clock, count in [('20:29:00', 0), ('20:30:00', 1), ('20:30:59', 1), ('20:31:00', 0)]:
            h = Harness('countdown', now='2026-09-06T'+clock, launch='2026-09-06T23:00:00'); h.run()
            self.assertEqual(len(h.notifications), count, clock)

    def test_countdown_overnight_launch_uses_previous_evening(self):
        for day, count in [('05', 0), ('06', 1)]:
            h = Harness('countdown', now=f'2026-09-{day}T20:30:00', launch='2026-09-07T02:00:00'); h.run()
            self.assertEqual(len(h.notifications), count)
        h = Harness('countdown', now='2026-09-07T01:00:00', launch='2026-09-07T02:00:00'); h.run(manual=True)
        self.assertEqual(h.notifications, [])

    def test_countdown_morning_and_custom_cutoff(self):
        h = Harness('countdown', now='2026-09-06T06:26:00', launch='2026-09-06T07:26:00'); h.run()
        self.assertEqual(len(h.notifications), 1)
        h = Harness('countdown', now='2026-09-06T19:00:00', launch='2026-09-07T07:00:00', earliest_morning_time='07:00:00', fallback_time='19:00:00'); h.run()
        self.assertEqual(len(h.notifications), 1)

    def test_invalid_awake_window_is_silent(self):
        for name, kw in [('countdown', {'fallback_time':'06:00:00'}), ('pet_safety', {'cutoff_time':'06:00:00'})]:
            h = Harness(name, now='2026-09-06T12:50:00', earliest_morning_time='08:00:00', **kw); h.run()
            self.assertEqual(h.notifications, [])

    def test_countdown_dst_uses_absolute_lead_seconds(self):
        for now, launch in [('2026-03-07T20:30:00','2026-03-08T03:30:00'), ('2026-10-31T20:30:00','2026-11-01T01:30:00-08:00')]:
            h = Harness('countdown', now=now, launch=launch); h.run()
            self.assertEqual(len(h.notifications), 1)
            self.assertEqual(h.context['computed']['minutes_left'], 360)

    def test_pet_normal_threshold_and_real_remaining_minutes(self):
        h = Harness('pet_safety', now='2026-09-06T12:44:00'); h.run()
        self.assertEqual(h.notifications, [])
        h = Harness('pet_safety', now='2026-09-06T12:50:00', pet_names='Grizzly and Luna'); h.run()
        self.assertEqual(len(h.notifications), 1)
        self.assertIn('10 minutes', h.notifications[0]['message'])
        self.assertIn('Grizzly and Luna', h.notifications[0]['title'])
        again = Harness('pet_safety', now='2026-09-06T12:51:00', helper=h.writes[0]); again.run()
        self.assertEqual(again.notifications, [])

    def test_pet_quiet_hours_and_late_catchup(self):
        for now, launch in [('2026-09-07T01:45:00','2026-09-07T02:00:00'), ('2026-09-06T20:30:00','2026-09-06T20:45:00'), ('2026-09-06T20:31:00','2026-09-06T20:40:00')]:
            h = Harness('pet_safety', now=now, launch=launch); h.run(manual=True)
            self.assertEqual(h.notifications, [])

    def test_past_launches_do_not_send_or_update_helpers(self):
        for name in ['countdown', 'pet_safety', 'reschedule']:
            h = Harness(name, launch='2026-09-06T11:59:00'); h.run(manual=True)
            self.assertEqual(h.notifications, [])
            self.assertEqual(h.writes, [])

    def test_unavailable_helpers_do_not_cause_repeat_notifications(self):
        for name in ['countdown', 'pet_safety', 'reschedule']:
            for helper in ['unknown', 'unavailable']:
                h = Harness(name, now='2026-09-06T12:50:00', helper=helper); h.run(manual=True)
                self.assertEqual(h.notifications, [])
                self.assertEqual(h.writes, [])

    def test_reschedule_seeds_baseline_silently(self):
        h = Harness('reschedule'); h.run()
        self.assertEqual(h.notifications, [])
        self.assertEqual(h.writes, ['launch-1|'+h.raw])

    def test_reschedule_delays_and_advances(self):
        baseline = 'launch-1|'+local('2026-09-06T13:00:00').isoformat()
        for launch, direction in [('13:15:00','delayed'), ('12:45:00','moved earlier')]:
            h = Harness('reschedule', launch='2026-09-06T'+launch, helper=baseline); h.run()
            self.assertEqual(len(h.notifications), 1)
            self.assertIn(direction, h.notifications[0]['title'])
            self.assertEqual(h.writes, ['launch-1|'+h.raw])

    def test_reschedule_small_changes_accumulate(self):
        baseline = 'launch-1|'+local('2026-09-06T13:00:00').isoformat()
        first = Harness('reschedule', launch='2026-09-06T13:10:00', helper=baseline); first.run()
        self.assertEqual(first.notifications, [])
        self.assertEqual(first.writes, [baseline])
        second = Harness('reschedule', launch='2026-09-06T13:20:00', helper=first.writes[0]); second.run()
        self.assertEqual(len(second.notifications), 1)
        third = Harness('reschedule', launch='2026-09-06T13:20:00', helper=second.writes[0]); third.run()
        self.assertEqual(third.notifications, [])

    def test_reschedule_turnover_and_bad_history_seed_without_alert(self):
        for helper in ['old-launch|'+local('2026-09-06T12:30:00').isoformat(), 'broken', 'launch-1|garbage']:
            h = Harness('reschedule', helper=helper); h.run()
            self.assertEqual(h.notifications, [])
            self.assertEqual(h.writes, ['launch-1|'+h.raw])

    def test_reschedule_missing_id_is_silent(self):
        h = Harness('reschedule', launch_id=None); h.run(manual=True)
        self.assertEqual(h.writes, [])

    def test_notification_failure_does_not_advance_helper(self):
        for name in ['countdown', 'pet_safety', 'reschedule']:
            helper = 'launch-1|'+local('2026-09-06T12:30:00').isoformat() if name == 'reschedule' else ''
            h = Harness(name, now='2026-09-06T12:50:00', helper=helper)
            with self.assertRaises(RuntimeError):
                h.run(fail_notify=True)
            self.assertEqual(h.writes, [])

    def test_blueprint_inputs_and_notify_actions_resolve(self):
        for name in ['day', 'countdown', 'pet_safety', 'reschedule']:
            h = Harness(name)
            def walk(value):
                if isinstance(value, Input):
                    self.assertIn(value, h.blueprint['blueprint']['input'])
                elif isinstance(value, dict):
                    for item in value.values(): walk(item)
                elif isinstance(value, list):
                    for item in value: walk(item)
            walk(h.blueprint)
            self.assertEqual(h.blueprint['mode'], 'single')
            self.assertNotIn('rocketlaunchlive', str(h.blueprint))


if __name__ == '__main__':
    unittest.main()
