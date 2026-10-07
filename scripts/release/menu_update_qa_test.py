import json
from pathlib import Path
import tempfile
import time
import unittest

from menu_update_qa import menu_permissions
from update_transaction import permission_outcome


class MenuPermissionFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.state={'control':None,'fresh':False,'microphone':'denied','screenCapture':False,'services':[]}

    def write(self):
        (self.root/'menu-state.json').write_text(json.dumps(self.state))

    def outcome(self):
        report={'controllerConnected':True,'updatedAt':time.time()*1000,
                'build':{'version':'0.1.1','commit':'b'*40,'instanceId':'qa-menu'},
                'permissions':menu_permissions(self.root)}
        return permission_outcome(report,'0.1.1','b'*40)

    def test_default_attention_and_explicit_recheck_clearance(self):
        self.assertEqual(menu_permissions(self.root),{'microphone':'denied','screenCapture':False,'slackLogs':False})
        self.assertEqual(self.outcome()['missingPermissions'],['microphone','screenCapture'])
        self.state.update(microphone='authorized',screenCapture=True)
        self.write()
        self.assertEqual(self.outcome()['permissionState'],'authorized')
        self.assertEqual(self.outcome()['missingPermissions'],[])
        self.state['screenCapture']=False
        self.write()
        self.assertEqual(self.outcome()['missingPermissions'],['screenCapture'])

    def test_malformed_or_untrusted_state_does_not_claim_permission_clearance(self):
        for field,value in [('microphone','granted'),('screenCapture',1),('fresh','yes'),('services',{}),('control',[])]:
            with self.subTest(field=field):
                self.state.update(microphone='authorized',screenCapture=True,fresh=True,services=[],control=None)
                self.state[field]=value
                self.write()
                with self.assertRaises(ValueError):menu_permissions(self.root)
        (self.root/'menu-state.json').unlink()
        outside=self.root/'outside.json';outside.write_text(json.dumps(self.state))
        (self.root/'menu-state.json').symlink_to(outside)
        with self.assertRaises(OSError):menu_permissions(self.root)


if __name__=='__main__':unittest.main()
