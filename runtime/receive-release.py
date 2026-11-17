#!/usr/bin/env python3
"""Root-owned receiver used only by a restricted SSH deployment key."""
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

app = sys.argv[1]
if app not in ('dashboard', 'admin'):
    raise SystemExit('Unknown application')
port = 4180 if app == 'dashboard' else 4181
base = Path('/opt/novelflow')
with open('/run/lock/novelflow-' + app + '.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    with tempfile.TemporaryDirectory(prefix='nf-release-') as tmp:
        archive = Path(tmp) / 'release.tgz'
        size = 0
        with archive.open('wb') as out:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > 80 * 1024 * 1024:
                    raise SystemExit('Archive too large')
                out.write(chunk)
        release = base / 'releases' / (app + '-' + str(time.time_ns()))
        release.mkdir()
        try:
            with tarfile.open(archive, 'r:gz') as tar:
                members = tar.getmembers()
                if sum(m.size for m in members) > 250 * 1024 * 1024:
                    raise ValueError('Expanded archive too large')
                for m in members:
                    p = PurePosixPath(m.name)
                    if p.is_absolute() or '..' in p.parts or '.git' in p.parts or not (m.isfile() or m.isdir()):
                        raise ValueError('Unsafe archive member')
                    if p.name.startswith('.env') or p.name.endswith(('.pem', '.key')):
                        raise ValueError('Credentials must not be in source archives')
                tar.extractall(release, filter='data')
            for required in ['runtime/server.cjs', 'runtime/static.json', 'index.html', 'package.json']:
                if not (release / required).is_file():
                    raise ValueError('Missing release file')
            uid = pwd.getpwnam('novelflow').pw_uid
            gid = pwd.getpwnam('novelflow').pw_gid
            for root, dirs, files in os.walk(release):
                os.chown(root, uid, gid)
                os.chmod(root, 0o755)
                for name in files:
                    p = Path(root) / name
                    os.chown(p, uid, gid)
                    os.chmod(p, 0o644)
            if (release / 'package-lock.json').exists():
                subprocess.run(['sudo', '-u', 'novelflow', 'npm', 'ci', '--omit=dev', '--ignore-scripts',
                                '--cache', '/tmp/novelflow-npm-cache', '--no-audit', '--no-fund'],
                               cwd=release, check=True, timeout=180, stdout=subprocess.DEVNULL)
            subprocess.run(['/usr/bin/node', '--check', 'runtime/server.cjs'], cwd=release, check=True)
            active = base / app
            previous = active.resolve() if active.exists() else None
            candidate = base / ('.' + app + '-next')
            candidate.unlink(missing_ok=True)
            candidate.symlink_to(release)
            candidate.replace(active)
            try:
                subprocess.run(['systemctl', 'restart', 'novelflow-' + app], check=True, timeout=100)
                healthy = False
                for _ in range(20):
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/_runtime/health', timeout=3) as r:
                            body = json.load(r)
                            healthy = r.status == 200 and body.get('videoGeneration') == 'disabled'
                        if healthy:
                            break
                    except Exception:
                        time.sleep(1)
                if not healthy:
                    raise RuntimeError('Release health check failed')
            except Exception:
                if previous:
                    candidate.symlink_to(previous)
                    candidate.replace(active)
                    subprocess.run(['systemctl', 'restart', 'novelflow-' + app], check=True, timeout=100)
                raise
            print(json.dumps({'application': app, 'release': release.name, 'health': 'ok', 'previous': previous.name if previous else None}))
        except Exception:
            if (base / app).resolve() != release:
                shutil.rmtree(release, ignore_errors=True)
            raise
