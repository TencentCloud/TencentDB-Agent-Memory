#!/usr/bin/env python3
"""Reproduce the licensed SDK loader compatibility adapter from an integrity-pinned archive."""
import argparse, base64, hashlib, io, json, pathlib, tarfile, urllib.request
URL = 'https://registry.npmjs.org/@tencentdb-agent-memory/tcvdb-text/-/tcvdb-text-0.1.1.tgz'
SRI = 'sha512-LoCiOFDL7tk0mu6+4X2MfKXyL/iVXsiVIAmbryKaA7DcGiT62h9I1wgoobnCHYU9vmghMjjReJ4gy3lIii+WvA=='
root = pathlib.Path(__file__).resolve().parents[1] / 'vendor' / 'tcvdb-text'
parser = argparse.ArgumentParser(); parser.add_argument('--check', action='store_true'); args = parser.parse_args()
with urllib.request.urlopen(URL, timeout=60) as response:
    archive = response.read(64 * 1024 * 1024 + 1)
if len(archive) > 64 * 1024 * 1024: raise ValueError('Archive exceeds limit')
if 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode() != SRI:
    raise ValueError('Official archive integrity mismatch')
payload = {}
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
    for member in bundle.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if not member.isfile() or '..' in name.parts or name.is_absolute(): continue
        if member.name.startswith('package/dist/') or member.name in ['package/package.json', 'package/README.md', 'package/LICENSE']:
            content = bundle.extractfile(member).read()
            relative = member.name.removeprefix('package/')
            if relative == 'package.json': relative = 'upstream-package.json'
            payload[relative] = content
metadata = json.loads(payload['upstream-package.json'])
if metadata['name'] != '@tencentdb-agent-memory/tcvdb-text' or metadata['version'] != '0.1.1' or metadata['license'] != 'MIT':
    raise ValueError('Unexpected SDK metadata')
changes = {
    'dist/tokenizer/jieba-tokenizer.js': (
        'import { Jieba } from "@node-rs/jieba";',
        'import loadJieba from "#jieba-loader";\nimport { createRequire } from "node:module";\nconst { Jieba } = loadJieba(createRequire(import.meta.url));'),
    'dist/paths.js': (
        'const __dirname = dirname(fileURLToPath(import.meta.url));',
        'const __dirname = dirname(fileURLToPath(import.meta.resolve("@tencentdb-agent-memory/tcvdb-text")));'),
}
original_hashes = {name: hashlib.sha256(content).hexdigest() for name, content in sorted(payload.items())}
for name, (before, after) in changes.items():
    content = payload[name].decode()
    if content.count(before) != 1: raise ValueError('Unexpected SDK input: ' + name)
    payload[name] = content.replace(before, after).encode()
omitted_maps = []
for name in changes:
    map_name = name + '.map'
    payload.pop(map_name, None)
    omitted_maps.append(map_name)
    marker = '//# sourceMappingURL=' + pathlib.PurePosixPath(map_name).name
    payload[name] = payload[name].replace(marker.encode(), b'')
    target = root / map_name
    if args.check:
        if target.exists(): raise ValueError('Stale source map: ' + map_name)
    elif target.exists():
        target.unlink()
manifest = {'source_url': URL, 'source_integrity': SRI, 'version': '0.1.1', 'license': 'MIT',
    'changed_files': sorted(changes), 'omitted_stale_source_maps': sorted(omitted_maps), 'original_sha256': original_hashes,
    'derived_sha256': {name: hashlib.sha256(content).hexdigest() for name, content in sorted(payload.items())},
    'data': 'Unmodified installed official package; resolved without executing its entry point',
    'native': 'Unmodified installed @node-rs/jieba 2.0.3 using existing licensed adapter'}
payload['source-info.json'] = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
for name, content in payload.items():
    target = root / name
    if args.check:
        if target.read_bytes() != content: raise ValueError('Derived content mismatch: ' + name)
    else:
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
print(json.dumps({'files': len(payload), 'changed_sdk_files': 2, 'check': args.check, 'archive_integrity': True}))
