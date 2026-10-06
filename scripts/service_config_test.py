import importlib.util
import pathlib
import unittest
import tempfile
import json
import os
SPEC=importlib.util.spec_from_file_location('service_config',pathlib.Path(__file__).with_name('service_config.py'))
module=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
class ServiceConfigTests(unittest.TestCase):
 def test_defaults_and_consistent_overrides(self):
  self.assertEqual(module.service_config({}),{'api':48100,'ui':48101,'transcription':48102})
  self.assertEqual(module.service_config({'HEED_API_PORT':'48110','HEED_UI_PORT':'48111','HEED_TRANSCRIPTION_PORT':'48112'}),{'api':48110,'ui':48111,'transcription':48112})
  self.assertEqual(module.service_config({'PORT':'48110'})['api'],48110)
  with self.assertRaises(ValueError):module.service_config({'PORT':'48110','HEED_API_PORT':'48120'})
  with self.assertRaises(ValueError):module.service_config({'HEED_API_PORT':'48101'})
 def test_rejects_invalid_and_forbidden_ports(self):
  for value in ['', '0','65536','-1','1.5',' 48100','48100x','3000','3999','5000','5999','7000','7999','8000','8999']:
   with self.subTest(value=value),self.assertRaises(ValueError):module.service_port(value,'test')
 def test_saved_custom_install_is_shared_with_envless_python_browser_host_and_cli(self):
  with tempfile.TemporaryDirectory(prefix='heed-device-ports-') as app:
   env={'HEED_APP_DIR':app,'HEED_API_PORT':'48110','HEED_UI_PORT':'48111','HEED_TRANSCRIPTION_PORT':'48112'}
   module.save_service_ports(env)
   self.assertEqual(module.service_config({'HEED_APP_DIR':app}),{'api':48110,'ui':48111,'transcription':48112})
   self.assertEqual(module.service_config({'HEED_APP_DIR':app,'PORT':'48120'})['api'],48120)
   self.assertEqual(os.stat(pathlib.Path(app)/'service-ports.json').st_mode&0o777,0o600)
   for data in ['{invalid',json.dumps({'version':1,'api':5001,'ui':48111,'transcription':48112}),json.dumps({'version':1,'api':48110,'ui':48110,'transcription':48112}),' '*4097]:
    (pathlib.Path(app)/'service-ports.json').write_text(data)
    with self.assertRaises(ValueError):module.service_config({'HEED_APP_DIR':app})
 def test_saved_ports_never_follow_symlinks(self):
  with tempfile.TemporaryDirectory(prefix='heed-device-link-') as app:
   (pathlib.Path(app)/'service-ports.json').symlink_to(pathlib.Path(app)/'missing')
   with self.assertRaises(ValueError):module.service_config({'HEED_APP_DIR':app})
 def test_loopback_url_requires_safe_origin(self):
  self.assertEqual(module.local_service_url('http://localhost:48122/'),'http://localhost:48122')
  for value in ['http://localhost:0','http://localhost:5002','http://outside.example:48100','http://user:password@localhost:48100','http://localhost:48100/private','http://localhost:48100?token=x']:
   with self.subTest(value=value),self.assertRaises(ValueError):module.local_service_url(value)
if __name__=='__main__':unittest.main()
