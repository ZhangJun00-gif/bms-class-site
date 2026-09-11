"""Focused safety checks; no Docker daemon, database or real secrets required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentSafety(unittest.TestCase):
    def test_host_rejects_injection_and_example(self):
        for host in ['class.example.org', 'https://school.org', 'school.org/path', 'school.org;id', 'a..org', '*.school.org']:
            with self.assertRaises(ValueError):
                deploy.validate_host(host)
        self.assertEqual(deploy.validate_host('class.school.edu'), 'class.school.edu')

    def test_env_preserves_dollars_and_rejects_newlines(self):
        self.assertEqual(deploy.encode_env({'VALUE': '$literal#value'}), 'VALUE=$literal#value\n')
        with self.assertRaises(ValueError):
            deploy.encode_env({'VALUE': 'one\nINJECTED=two'})

    def test_manifest_exposes_only_https_web_and_scopes_secrets(self):
        services = deploy.compose_spec(Path('/etc/class-site'), 'class.school.edu', 'test-project')['services']
        self.assertEqual([name for name, service in services.items() if service.get('ports')], ['web'])
        self.assertEqual(services['web']['ports'], ['80:80', '443:443'])
        self.assertNotIn('env_file', services['web'])
        self.assertEqual(services['db']['env_file'][0]['path'], str(Path('/etc/class-site') / 'mysql.env'))
        self.assertEqual(services['api']['env_file'][0]['format'], 'raw')
        self.assertFalse(any('seed.env' in env['path'] for name in ['api', 'worker'] for env in services[name]['env_file']))

    def test_source_tree_cannot_hold_runtime_secrets(self):
        with self.assertRaises(ValueError):
            deploy.validate_state_dir(deploy.SOURCE / '.runtime')

    def test_first_install_refuses_existing_resources_before_changes(self):
        args = type('Args', (), {'state_dir': Path('/etc/class-site')})()
        config = {'stage': 'configured', 'project': 'test-project'}
        with patch.object(deploy, 'command', return_value=b'existing-resource\n') as call:
            with patch.object(deploy, 'set_stage') as stage:
                with self.assertRaises(ValueError):
                    deploy.provision(args, config)
                stage.assert_not_called()
                self.assertEqual(call.call_count, 1)

    def test_private_write_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private.env'
            deploy.private_write(path, 'test-only\n')
            with self.assertRaises(FileExistsError):
                deploy.private_write(path, 'replacement\n')
            self.assertEqual(path.read_text(), 'test-only\n')


if __name__ == '__main__':
    unittest.main()
