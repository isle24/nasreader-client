"""Verify a fresh client-only repository before installing or building anything."""
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

FRONT_FILES = {'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'pdfAssets.mjs'}
TAURI_FILES = {'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'tauri.windows.conf.json', 'Entitlements.plist'}
ROOT_FILES = {'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'EXPORT-MANIFEST.json'}
SCRIPT_FILES = {'scripts/verify_export.py', 'scripts/collect_artifacts.py'}

def allowed(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:
        return False
    if p.suffix.lower() in {'.go', '.sql', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.tar', '.gz', '.zip', '.dmg', '.exe', '.pdf', '.epub', '.cbz', '.pyc'}:
        return False
    if any(x.lower().startswith('.env') for x in p.parts):
        return False
    if any(x in {'server', 'backadmin', 'node_modules', 'target', 'dist', '.runtime', '.env', '.git', 'gen'} for x in p.parts):
        return False
    if name in ROOT_FILES or name in SCRIPT_FILES or name == '.github/workflows/desktop.yml':
        return True
    if any(x.startswith('.') for x in p.parts):
        return False
    if len(p.parts) >= 2 and p.parts[0] == 'front-end':
        source = p.parts[1] == 'src' and p.suffix.lower() in {'.ts', '.vue', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2'} and not p.name.endswith('.test.ts')
        return (len(p.parts) == 2 and p.name in FRONT_FILES) or source or name == 'front-end/public/brand-icon.svg'
    if name in {'client/package.json', 'client/package-lock.json', 'client/README.md', 'client/THIRD_PARTY_NOTICES.md'}:
        return True
    if len(p.parts) >= 3 and p.parts[:2] == ('client', 'assets'):
        return p.suffix.lower() in {'.svg', '.png'}
    if len(p.parts) >= 3 and p.parts[:2] == ('client', 'src-tauri'):
        return (len(p.parts) == 3 and p.name in TAURI_FILES) or (len(p.parts) == 4 and (
            (p.parts[2] == 'src' and p.name in {'main.rs', 'lib.rs', 'credentials.rs', 'credential_scope.rs'})
            or (p.parts[2] == 'icons' and p.suffix.lower() in {'.png', '.ico', '.icns'})
            or (p.parts[2] == 'capabilities' and p.name == 'main.json')
            or (p.parts[2] == 'tests' and p.name == 'windows_credentials.rs')
        ))
    return False

def verify(root):
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    tracked = {x for x in tracked if x}
    manifest = json.loads((root / 'EXPORT-MANIFEST.json').read_text(encoding='utf-8'))
    expected = set(manifest['files']) | {'EXPORT-MANIFEST.json'}
    if tracked != expected:
        raise ValueError('Tracked files differ from the client export manifest')
    secret = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}')
    for name in sorted(tracked):
        if not allowed(name):
            raise ValueError('Non-client file: ' + name)
        p = root / name
        if p.is_symlink() or not p.resolve().is_relative_to(root.resolve()):
            raise ValueError('Unsafe file reference: ' + name)
        raw = p.read_bytes()
        if secret.search(raw):
            raise ValueError('Credential material detected in: ' + name)
        if name != 'EXPORT-MANIFEST.json' and hashlib.sha256(raw).hexdigest() != manifest['files'][name]['sha256']:
            raise ValueError('Client source checksum mismatch: ' + name)
    print(json.dumps({'client_only': True, 'tracked_files': len(tracked), 'source_commit': manifest['source_commit']}, ensure_ascii=False))

if __name__ == '__main__':
    verify(Path.cwd())
