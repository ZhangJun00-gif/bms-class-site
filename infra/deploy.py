#!/usr/bin/env python3
"""First-install deployment for a dedicated Linux Docker host. No data deletion."""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]


class DeploymentError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def validate_host(host):
    require(len(host) <= 253 and '.' in host and all(
        re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
        for part in host.split('.')), 'Use a lowercase DNS hostname without protocol, path or port.')
    require(not host.endswith(('.example', '.invalid', '.test')) and host not in {'class.example.org', 'example.com'},
            'Provide your own hostname, not an example.')
    return host


def validate_external_url(value):
    parsed = urlsplit(value)
    require(parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment,
            'Provider endpoints must be HTTPS URLs without credentials, query or fragment.')
    return value


def encode_env(values):
    for key, value in values.items():
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) is not None, 'Invalid environment key.')
        require(isinstance(value, str) and not any(c in value for c in '\r\n\x00'), 'Invalid environment value.')
    return ''.join(f'{key}={value}\n' for key, value in values.items())


def read_env(path):
    result = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            result[key] = value
    return result


def private_write(path, value, replace=False):
    require(not path.is_symlink(), 'Refusing a symlink at the private output path.')
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if replace else os.O_EXCL)
    flags |= getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(value)
    os.chmod(path, 0o600)


def validate_state_dir(path, source=SOURCE):
    require(path.is_absolute(), 'State directory must be an absolute path.')
    require(path.resolve() != source.resolve() and source.resolve() not in path.resolve().parents,
            'Private runtime files must stay outside the source repository.')
    for parent in [path, *path.parents]:
        require(not parent.is_symlink(), 'State path must not traverse symlinks.')
        if parent.exists():
            mode = parent.stat()
            require(mode.st_uid == 0 and not mode.st_mode & 0o022,
                    'State path ancestors must be root-owned and not group/world writable.')
    if path.exists():
        require(path.is_dir() and stat.S_IMODE(path.stat().st_mode) == 0o700,
                'Existing state directory must be root-owned mode 0700.')


def compose_spec(state, host, project):
    def env(name):
        return [{'path': str(state / name), 'format': 'raw', 'required': True}]
    logging = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}
    backend = {
        'image': f'{project}-backend:local',
        'build': {'context': str(SOURCE), 'dockerfile': 'infra/Dockerfile.backend'},
        'env_file': env('app.env'),
        'security_opt': ['no-new-privileges:true'],
        'logging': logging,
    }
    uploads = ['uploads:/data/uploads']
    volumes = {name: {'name': f'{project}_{name}'} for name in ['mysql', 'uploads', 'qdrant']}
    services = {
        'db': {
            'image': 'mysql:8.4', 'env_file': env('mysql.env'),
            'volumes': ['mysql:/var/lib/mysql'], 'restart': 'unless-stopped',
            'mem_limit': '1024m', 'logging': logging,
            'healthcheck': {'test': ['CMD-SHELL', 'MYSQL_PWD="$$MYSQL_PASSWORD" mysql --protocol=TCP -h 127.0.0.1 -u "$$MYSQL_USER" "$$MYSQL_DATABASE" -Nse "SELECT 1" >/dev/null 2>&1'], 'interval': '10s', 'timeout': '5s', 'retries': 30, 'start_period': '30s'},
        },
        'qdrant': {
            'image': 'qdrant/qdrant:v1.18.3', 'env_file': env('qdrant.env'),
            'volumes': ['qdrant:/qdrant/storage'], 'restart': 'unless-stopped',
            'mem_limit': '512m', 'logging': logging,
        },
        'api': {
            **backend, 'command': ['node', 'apps/api/dist/main.js'],
            'volumes': uploads, 'tmpfs': ['/data/knowledge-tmp:uid=1000,gid=1000,mode=0700,size=512m', '/data/knowledge-import-tmp:uid=1000,gid=1000,mode=0700,size=512m', '/data/quiz-import-tmp:uid=1000,gid=1000,mode=0700,size=512m'],
            'restart': 'unless-stopped', 'mem_limit': '768m',
            'depends_on': {'db': {'condition': 'service_healthy'}, 'qdrant': {'condition': 'service_started'}},
            'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], 'interval': '15s', 'timeout': '10s', 'retries': 30, 'start_period': '30s'},
        },
        'worker': {
            **backend, 'command': ['node', 'apps/worker/dist/main.js'],
            'volumes': uploads, 'restart': 'unless-stopped', 'mem_limit': '768m',
            'depends_on': {'api': {'condition': 'service_healthy'}},
        },
        'web': {
            'image': f'{project}-web:local',
            'build': {'context': str(SOURCE), 'dockerfile': 'infra/Dockerfile.web'},
            'environment': {'INTRANET_HOST': host},
            'volumes': [{'type': 'bind', 'source': str(state / 'tls'), 'target': '/run/secrets/tls', 'read_only': True, 'bind': {'create_host_path': False}}],
            'ports': ['80:80', '443:443'], 'restart': 'unless-stopped',
            'mem_limit': '128m', 'logging': logging,
            'depends_on': {'api': {'condition': 'service_healthy'}},
        },
        'migrate': {**backend, 'profiles': ['tools'], 'command': ['pnpm', '--filter', '@bmc3/api', 'prisma:deploy']},
        'seed': {**backend, 'profiles': ['tools'], 'env_file': env('app.env') + env('seed.env'), 'command': ['pnpm', '--filter', '@bmc3/api', 'prisma:seed']},
        'init-storage': {
            **backend, 'profiles': ['tools'], 'user': '0:0', 'env_file': [], 'volumes': uploads,
            'command': ['node', '-e', "const fs=require('fs');fs.mkdirSync('/data/uploads',{recursive:true});fs.chownSync('/data/uploads',1000,1000);fs.chmodSync('/data/uploads',0o770)"],
        },
    }
    return {'name': project, 'services': services, 'volumes': volumes}


def command(args, state, label, timeout=1800):
    print(label, flush=True)
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    log = state / 'deployment.log'
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'ab') as stream:
        stream.write((label + '\n').encode() + result.stdout + b'\n')
    require(result.returncode == 0, f'{label} failed. Review the private deployment.log locally; redact it before sharing.')
    return result.stdout


def initialize(args):
    state = args.state_dir
    host = validate_host(args.host or '')
    require(not any(p.name != '.lock' for p in state.iterdir()), 'Initialization requires an empty state directory; existing keys are never overwritten.')
    require(args.certificate and args.private_key, 'Provide --certificate and --private-key from your certificate authority.')
    certificate, key = args.certificate.resolve(), args.private_key.resolve()
    require(certificate.is_file() and key.is_file(), 'Certificate files are missing.')
    require(SOURCE not in certificate.parents and SOURCE not in key.parents, 'TLS material must be outside the repository.')
    values = read_env(SOURCE / 'infra/runtime.env.example')
    values.update(DATABASE_URL=f'mysql://class_site:{secrets.token_hex(32)}@db:3306/class_site',
                  WEB_ORIGIN=f'https://{host}', STUDENT_DATA_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
                  QDRANT_URL='http://qdrant:6333', QDRANT_API_KEY=secrets.token_hex(32))
    prompts = {
        'MEDIA_COS_BUCKET': 'Private COS bucket (including application suffix)',
        'MEDIA_COS_REGION': 'COS region',
        'MEDIA_COS_PUBLIC_ENDPOINT': 'HTTPS COS public endpoint for signed reads',
        'MEDIA_COS_SECRET_ID': 'COS restricted SecretId',
        'MEDIA_COS_SECRET_KEY': 'COS restricted SecretKey',
        'AI_API_KEY': 'DeepSeek API key with access to the required models',
        'EMBEDDING_BASE_URL': 'HTTPS Zhipu API base URL',
        'EMBEDDING_API_KEY': 'Zhipu embedding API key',
    }
    require(sys.stdin.isatty(), 'Run init in an interactive terminal; secrets are not accepted as command arguments.')
    for name, prompt in prompts.items():
        value = getpass.getpass(f'{prompt}: ').strip()
        require(bool(value) and not re.search(r'replace-with|change-this|<[^>]+>', value, re.I), f'{name} must be configured.')
        if 'ENDPOINT' in name or 'BASE_URL' in name:
            validate_external_url(value)
        values[name] = value
    login = input('Administrator login identifier (2-40 characters, not a real student number): ').strip()
    display_name = input('Administrator display name (2-80 characters): ').strip()
    password = getpass.getpass('Administrator password (16-128 characters, letters and digits): ')
    require(password == getpass.getpass('Repeat administrator password: '), 'Passwords do not match.')
    require(2 <= len(login) <= 40 and 2 <= len(display_name) <= 80, 'Invalid administrator identity lengths.')
    require(16 <= len(password) <= 128 and re.search(r'[A-Za-z]', password) and re.search(r'\d', password)
            and not re.search(r'change-this|replace-with|password123', password, re.I), 'Use a unique strong administrator password.')
    seed = {'ALLOW_INITIAL_ADMIN_SEED': 'true', 'INITIAL_ADMIN_STUDENT_NUMBER': login, 'INITIAL_ADMIN_NAME': display_name, 'INITIAL_ADMIN_PASSWORD': password}
    encode_env(values)
    encode_env(seed)
    db = {'MYSQL_DATABASE': 'class_site', 'MYSQL_USER': 'class_site', 'MYSQL_PASSWORD': urlsplit(values['DATABASE_URL']).password, 'MYSQL_ROOT_PASSWORD': secrets.token_hex(32)}
    project = 'class-site-' + hashlib.sha256(host.encode()).hexdigest()[:10]
    private_write(state / 'app.env', encode_env(values))
    private_write(state / 'mysql.env', encode_env(db))
    private_write(state / 'seed.env', encode_env(seed))
    private_write(state / 'qdrant.env', encode_env({'QDRANT__SERVICE__API_KEY': values['QDRANT_API_KEY'], 'QDRANT__TELEMETRY_DISABLED': 'true'}))
    (state / 'tls').mkdir(mode=0o700)
    for source, name in [(certificate, 'fullchain.pem'), (key, 'privkey.pem')]:
        target = state / 'tls' / name
        shutil.copyfile(source, target)
        target.chmod(0o600)
    private_write(state / 'deployment.json', json.dumps({'host': host, 'project': project, 'stage': 'configured'}) + '\n')
    private_write(state / 'compose.json', json.dumps(compose_spec(state, host, project), indent=2) + '\n')
    print('Private configuration created. Run check, then up. No containers or databases have been created.')


def check(args, config):
    state = args.state_dir
    required = ['app.env', 'mysql.env', 'qdrant.env', 'deployment.json', 'compose.json', 'tls/fullchain.pem', 'tls/privkey.pem']
    if config['stage'] in {'configured', 'provisioning', 'migrated'}:
        required.append('seed.env')
    for name in required:
        path = state / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid == 0
                and stat.S_IMODE(path.stat().st_mode) == 0o600, f'{name} must be a root-owned regular file with mode 0600.')
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'), 'Unset remote Docker overrides before deploying.')
    context = command(['docker', 'context', 'show'], state, 'Checking local Docker context').decode().strip()
    require(context == 'default', 'Use the default local Docker context on the target Linux host.')
    engine = command(['docker', 'info', '--format', '{{.OSType}}'], state, 'Checking Docker engine').decode().strip()
    require(engine == 'linux', 'A Linux Docker engine is required.')
    version = command(['docker', 'compose', 'version', '--short'], state, 'Checking Compose version').decode().strip()
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', version)
    require(match and tuple(map(int, match.groups())) >= (2, 30, 0), 'Docker Compose 2.30.0+ is required for literal env-file values.')
    command(['openssl', 'x509', '-in', str(state / 'tls/fullchain.pem'), '-noout', '-checkend', '604800'], state, 'Checking certificate validity')
    command(['openssl', 'x509', '-in', str(state / 'tls/fullchain.pem'), '-noout', '-checkhost', config['host']], state, 'Checking certificate hostname')
    cert_pub = command(['openssl', 'x509', '-in', str(state / 'tls/fullchain.pem'), '-pubkey', '-noout'], state, 'Reading certificate public key')
    key_pub = command(['openssl', 'pkey', '-in', str(state / 'tls/privkey.pem'), '-passin', 'pass:', '-pubout'], state, 'Checking TLS key pair')
    require(cert_pub.strip() == key_pub.strip(), 'Certificate and private key do not match.')
    command(compose_command(state) + ['config', '--quiet'], state, 'Validating Compose configuration')


def compose_command(state):
    return ['docker', 'compose', '--project-directory', str(state), '-f', str(state / 'compose.json')]


def provision(args, config):
    state = args.state_dir
    require(config['stage'] == 'configured', 'up is first-install only. Use resume for an interrupted install, or start for an installed site.')
    project = config['project']
    for kind in ['volume', 'container', 'network']:
        listing = command(['docker', kind, 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'], state, f'Checking existing {kind}s')
        require(not listing.strip(), 'Existing project resources found; refusing to adopt or overwrite them.')
    for name in ['mysql', 'uploads', 'qdrant']:
        listing = command(['docker', 'volume', 'ls', '--format', '{{.Name}}'], state, 'Checking reserved volume names').decode().splitlines()
        require(f'{project}_{name}' not in listing, 'A reserved volume already exists; refusing to reuse it.')
    set_stage(state, config, 'provisioning')
    resume(args, config)


def set_stage(state, config, stage):
    config['stage'] = stage
    private_write(state / 'deployment.json', json.dumps(config) + '\n', replace=True)


def resume(args, config):
    state = args.state_dir
    require(config['stage'] in {'provisioning', 'migrated', 'seeded'}, 'No interrupted installation can be resumed.')
    compose = compose_command(state)
    if config['stage'] == 'provisioning':
        command(['node', str(SOURCE / 'infra/check-release.mjs')], state, 'Checking source publication boundary')
        command(compose + ['build', 'api', 'web'], state, 'Building application images', timeout=3600)
        validation = "require('./apps/api/dist/runtime-config').validateApiRuntimeConfig(process.env);require('./apps/worker/dist/runtime-config').validateWorkerRuntimeConfig(process.env)"
        command(compose + ['run', '--rm', '--no-deps', 'migrate', 'node', '-e', validation], state, 'Validating actual API and Worker runtime contracts')
        command(compose + ['up', '-d', '--wait', '--wait-timeout', '300', 'db', 'qdrant'], state, 'Starting new database and vector service')
        command(compose + ['run', '--rm', '--no-deps', 'init-storage'], state, 'Preparing empty upload volume')
        vector_init = "const {setTimeout:sleep}=require('node:timers/promises');(async()=>{for(let i=0;i<60;i++){try{const r=await fetch(process.env.QDRANT_URL+'/readyz',{headers:{'api-key':process.env.QDRANT_API_KEY},signal:AbortSignal.timeout(3000)});if(r.ok){await require('./apps/worker/dist/knowledge-import').assertKnowledgeVectorReady();return}}catch{}await sleep(2000)}throw Error('VECTOR_INITIALIZATION_FAILED')})().catch(()=>{console.error('Vector initialization failed');process.exit(1)})"
        command(compose + ['run', '--rm', '--no-deps', 'migrate', 'node', '-e', vector_init], state, 'Initializing empty vector collection, indexes and alias')
        command(compose + ['run', '--rm', '--no-deps', 'migrate'], state, 'Applying official migrations')
        command(compose + ['run', '--rm', '--no-deps', 'migrate', 'pnpm', '--filter', '@bmc3/api', 'exec', 'prisma', 'migrate', 'status'], state, 'Checking migration status')
        set_stage(state, config, 'migrated')
    if config['stage'] == 'migrated':
        command(compose + ['run', '--rm', '--no-deps', 'seed'], state, 'Creating administrator in empty User table')
        set_stage(state, config, 'seeded')
    if (state / 'seed.env').exists():
        # Delete only this installer's one-time plaintext bootstrap file.
        (state / 'seed.env').unlink()
    specification = compose_spec(state, config['host'], config['project'])
    specification['services'].pop('seed')
    private_write(state / 'compose.json', json.dumps(specification, indent=2) + '\n', replace=True)
    command(compose + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '300', 'api', 'worker', 'web'], state, 'Starting HTTPS application')
    command(['curl', '--fail', '--silent', '--show-error', '--resolve', f"{config['host']}:443:127.0.0.1", f"https://{config['host']}/api/v1/health/ready"], state, 'Checking HTTPS readiness')
    set_stage(state, config, 'installed')
    print(f"Service started: https://{config['host']}. Complete the browser acceptance steps in README.md.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['init', 'check', 'up', 'resume', 'status', 'stop', 'start'])
    parser.add_argument('--state-dir', type=Path, default=Path('/etc/class-site'))
    parser.add_argument('--host')
    parser.add_argument('--certificate', type=Path)
    parser.add_argument('--private-key', type=Path)
    args = parser.parse_args()
    require(sys.platform.startswith('linux') and os.geteuid() == 0, 'Run on the dedicated Linux server with sudo.')
    os.umask(0o077)
    validate_state_dir(args.state_dir)
    if args.action == 'init':
        args.state_dir.mkdir(mode=0o700, parents=False, exist_ok=True)
    require(args.state_dir.is_dir(), 'Run init first.')
    import fcntl
    lock = os.open(args.state_dir / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'init':
            initialize(args)
            return
        config = json.loads((args.state_dir / 'deployment.json').read_text())
        if args.action in {'check', 'up', 'resume'}:
            check(args, config)
        if args.action == 'up':
            provision(args, config)
        elif args.action == 'resume':
            resume(args, config)
        elif args.action in {'start', 'stop', 'status'}:
            require(config['stage'] == 'installed', 'Finish installation before service operations.')
            verb = {'start': ['start', 'db', 'qdrant', 'api', 'worker', 'web'], 'stop': ['stop', 'web', 'worker', 'api', 'qdrant', 'db'], 'status': ['ps', '--all']}[args.action]
            output = command(compose_command(args.state_dir) + verb, args.state_dir, args.action)
            if args.action == 'status':
                print(output.decode('utf-8', 'replace'))
        elif args.action == 'check':
            print('Host, TLS and Compose checks passed. up also validates compiled application configuration before migrations.')
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except DeploymentError as error:
        print(f'Deployment stopped: {error}', file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, subprocess.SubprocessError, KeyError):
        print('Deployment stopped. Check prerequisites, input configuration and the private deployment.log. No automatic data cleanup was attempted.', file=sys.stderr)
        sys.exit(1)
