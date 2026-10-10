"""Collect only the expected native client outputs; record their exact checksums."""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import zipfile
from pathlib import Path

def one(root, pattern):
    matches = list(root.glob(pattern))
    if len(matches) != 1:
        raise ValueError(f'Expected one {pattern}, found {len(matches)}')
    return matches[0]

def collect(root, args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    config = json.loads((root / 'client/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    version = config['version']
    release = root / 'client/src-tauri/target' / args.target / 'release'
    bundle = release / 'bundle'
    stem = f'nasReader-{version}-{args.platform}-{args.arch}'
    if args.platform == 'windows':
        shutil.copy2(one(bundle / 'nsis', '*.exe'), output / (stem + '-setup.exe'))
        shutil.copy2(one(bundle / 'msi', '*.msi'), output / (stem + '.msi'))
        with zipfile.ZipFile(output / (stem + '-portable.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(release / 'nasreader-client.exe', 'nasReader.exe')
            z.write(root / 'LICENSE', 'LICENSE')
            z.write(root / 'client/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md')
            z.writestr('README.txt', 'Windows 10/11 x64. Requires Microsoft Edge WebView2 Runtime.\nOpen nasReader.exe and enter your NAS server URL.\nNo server is included. Login sessions use Windows Credential Manager.\n')
    elif args.platform == 'macos':
        shutil.copy2(one(bundle / 'dmg', '*.dmg'), output / (stem + '.dmg'))
        app = one(bundle / 'macos', '*.app')
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(output / (stem + '.zip'))], check=True)
    else:
        for kind, suffix in [('deb', '.deb'), ('rpm', '.rpm'), ('appimage', '.AppImage')]:
            shutil.copy2(one(bundle / kind, '*' + suffix), output / (stem + suffix))
    source = json.loads((root / 'EXPORT-MANIFEST.json').read_text(encoding='utf-8'))
    info = {'version': version, 'platform': args.platform, 'architecture': args.arch, 'target': args.target, 'source_commit': source['source_commit'], 'client_export_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(), 'runner_system': platform.platform(), 'signing': 'adhoc, not notarized' if args.platform == 'macos' else 'unsigned', 'server_included': False}
    (output / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = [hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name for p in sorted(output.iterdir()) if p.is_file()]
    (output / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'platform': args.platform, 'arch': args.arch, 'files': sorted(p.name for p in output.iterdir())}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', choices=['windows', 'macos', 'linux'], required=True)
    parser.add_argument('--arch', choices=['x64', 'arm64'], required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--output', required=True)
    collect(Path.cwd(), parser.parse_args())
