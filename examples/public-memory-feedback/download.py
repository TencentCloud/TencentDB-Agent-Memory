"""Download the pinned public LoCoMo source with integrity and license checks."""
import argparse
import hashlib
from pathlib import Path
import urllib.request
from prepare import REVISION,DATA_HASH

p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True,type=Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
files={'data/locomo10.json':DATA_HASH,
       'LICENSE.txt':'41003d4a74749c0220e33dd415042164b5a1093ed401f36277234f772d22d3d0',
       'README.MD':'9f8e6fd00a3400aa687109f40ed53715f0a2c028ee3f8c465bdfa96475640e8a'}
for name,expected in files.items():
 url=f'https://raw.githubusercontent.com/snap-research/locomo/{REVISION}/{name}'
 request=urllib.request.Request(url,headers={'User-Agent':'memory-feedback-reproduction'})
 with urllib.request.urlopen(request,timeout=60) as response: data=response.read(8*1024*1024+1)
 if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=expected:
  raise ValueError('download integrity mismatch: no fallback revision')
 (a.output/Path(name).name).write_bytes(data)
print('Downloaded pinned dataset, README, and CC BY-NC 4.0 license; no model calls.')
