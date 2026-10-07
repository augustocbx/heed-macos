import json
import os
from pathlib import Path
import tempfile
import unittest

try:
    import update_state
except ModuleNotFoundError:
    update_state = None


class StateTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(update_state, 'Durable transaction state is missing')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / '.heed'
        self.transaction = '22222222-2222-4222-8222-222222222222'

    def test_atomic_private_state_and_fixed_event_names(self):
        update_state.write(self.home, self.transaction, 'installer-phase.json', {'phase':'restarting'})
        path = self.home / 'updates' / self.transaction / 'installer-phase.json'
        self.assertEqual(json.loads(path.read_text())['schema'], 1)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(update_state.read(self.home, self.transaction, 'installer-phase.json')['phase'], 'restarting')
        for name in ['../install.json', '/tmp/result', 'unrecognized.json']:
            with self.assertRaises(ValueError):
                update_state.write(self.home, self.transaction, name, {})
        with self.assertRaises(ValueError):
            update_state.write(self.home, '../escape', 'status.json', {})

    def test_symlinked_storage_is_refused_without_modifying_destination(self):
        outside = Path(self.temp.name) / 'outside'; outside.mkdir()
        self.home.mkdir(); (self.home / 'updates').symlink_to(outside)
        with self.assertRaises(ValueError):
            update_state.write(self.home, self.transaction, 'status.json', {})
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlinked_file_and_malformed_state_fail_closed(self):
        update_state.write(self.home, self.transaction, 'status.json', {'state':'installing'})
        path = self.home / 'updates' / self.transaction / 'status.json'
        path.write_text('broken')
        with self.assertRaises(ValueError): update_state.read(self.home, self.transaction, 'status.json')
        outside = Path(self.temp.name) / 'private'; outside.write_text('preserve')
        path.unlink(); path.symlink_to(outside)
        with self.assertRaises(ValueError): update_state.write(self.home, self.transaction, 'status.json', {})
        self.assertEqual(outside.read_text(), 'preserve')


if __name__ == '__main__': unittest.main()
