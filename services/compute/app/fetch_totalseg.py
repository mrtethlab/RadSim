"""Pull ONE subject out of the TotalSegmentator dataset without downloading all 23.6 GB.

The dataset (Zenodo 10047292, v2.0.1, CC BY 4.0) is a single 23.58 GB zip holding 1228 CT
studies, each with reference segmentations of 117 structures. We need one diagnostic
chest-abdomen-pelvis study to build the CAP vessel map (docs/contrast-simulation.md §6.4).

A zip stores its index at the END of the file, and Zenodo honours HTTP range requests, so the
whole archive never has to come down: read the central directory, find the one subject's
members, and fetch only those byte ranges. That turns a 23.6 GB download into tens of MB.

Using the dataset's OWN segmentations also matters beyond bandwidth — they are the reference
labels the model was trained to reproduce, so they are better than anything we would get by
running the network ourselves, and they come with the vessel classes the CAP model needs.

    python -m app.fetch_totalseg --list                  # candidate subjects, by coverage
    python -m app.fetch_totalseg --subject s0287         # fetch one
"""
import argparse
import io
import os
import sys
import zipfile

import requests

REC = 'https://zenodo.org/records/10047292/files/Totalsegmentator_dataset_v201.zip?download=1'
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
OUT = os.path.join(DATA, 'totalseg')

# The structures the CAP contrast model needs. Everything else in the 117 is still fetched for
# the materials pass, but these are what decide whether a subject is usable at all.
VESSELS = ['aorta', 'inferior_vena_cava', 'portal_vein_and_splenic_vein',
           'common_iliac_artery_left', 'common_iliac_artery_right',
           'iliac_vena_left', 'iliac_vena_right', 'superior_vena_cava',
           'pulmonary_vein', 'brachiocephalic_trunk',
           'subclavian_artery_left', 'subclavian_artery_right',
           'common_carotid_artery_left', 'common_carotid_artery_right',
           'brachiocephalic_vein_left', 'brachiocephalic_vein_right']
ORGANS = ['liver', 'spleen', 'kidney_left', 'kidney_right', 'pancreas',
          'stomach', 'colon', 'small_bowel', 'urinary_bladder', 'heart']


class RangeFile(io.RawIOBase):
    """A seekable read-only file over an HTTP resource, backed by range requests.

    zipfile does many small seeks; without the block cache this issues hundreds of requests to
    walk one central directory."""

    BLOCK = 1 << 20

    def __init__(self, url, session=None):
        self.url = url
        self.s = session or requests.Session()
        r = self.s.head(url, allow_redirects=True, timeout=60)
        self.size = int(r.headers.get('content-length') or 0)
        if not self.size:                       # some redirects drop the length on HEAD
            r = self.s.get(url, headers={'Range': 'bytes=0-0'}, stream=True, timeout=60)
            self.size = int(r.headers['content-range'].split('/')[-1])
        self.pos = 0
        self.cache = {}

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def tell(self):
        return self.pos

    def _block(self, i):
        if i not in self.cache:
            lo = i * self.BLOCK
            hi = min(self.size, lo + self.BLOCK) - 1
            r = self.s.get(self.url, headers={'Range': f'bytes={lo}-{hi}'},
                           allow_redirects=True, timeout=180)
            r.raise_for_status()
            self.cache[i] = r.content
            if len(self.cache) > 64:            # keep the walk bounded; the CD is read linearly
                self.cache.pop(next(iter(self.cache)))
        return self.cache[i]

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        out = bytearray()
        while n > 0 and self.pos < self.size:
            i, off = divmod(self.pos, self.BLOCK)
            chunk = self._block(i)[off:off + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)


def open_zip():
    print(f'opening the archive index over HTTP…', flush=True)
    rf = RangeFile(REC)
    print(f'  archive is {rf.size / 1e9:.2f} GB; reading its central directory', flush=True)
    z = zipfile.ZipFile(rf)
    print(f'  {len(z.namelist()):,} members', flush=True)
    return z


def subjects(z):
    seen = {}
    for n in z.namelist():
        p = n.split('/')
        if len(p) > 1 and p[0].startswith('s') and p[0][1:].isdigit():
            seen.setdefault(p[0], []).append(n)
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--subject')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--limit', type=int, default=25)
    a = ap.parse_args()

    z = open_zip()
    if a.list:
        # meta.csv carries each study's body region, which is exactly the selection criterion
        meta = [n for n in z.namelist() if n.endswith('meta.csv')]
        if meta:
            txt = z.read(meta[0]).decode('utf-8', 'replace')
            rows = [r.split(';') for r in txt.strip().splitlines()]
            hdr = rows[0]
            print('  meta columns:', hdr)
            try:
                i_id, i_reg = hdr.index('image_id'), hdr.index('study_type')
            except ValueError:
                i_id, i_reg = 0, len(hdr) - 1
            hits = [r for r in rows[1:] if len(r) > max(i_id, i_reg)
                    and 'abdomen' in r[i_reg].lower() and 'thorax' in r[i_reg].lower()]
            print(f'  {len(hits)} studies covering thorax+abdomen; first {a.limit}:')
            for r in hits[:a.limit]:
                print('   ', r[i_id], '|', r[i_reg])
        return

    if not a.subject:
        sys.exit('give --subject sXXXX or --list')
    members = [n for n in z.namelist() if n.split('/')[0].endswith(a.subject)
               or f'/{a.subject}/' in n or n.startswith(a.subject + '/')]
    if not members:
        sys.exit(f'{a.subject} not in the archive')
    dest = os.path.join(OUT, a.subject)
    os.makedirs(dest, exist_ok=True)
    total = sum(z.getinfo(n).file_size for n in members)
    print(f'  {len(members)} members, {total / 1e6:.0f} MB uncompressed -> {dest}', flush=True)
    for i, n in enumerate(members, 1):
        if n.endswith('/'):
            continue
        rel = n.split('/', 1)[1] if '/' in n else n
        out = os.path.join(dest, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if os.path.exists(out) and os.path.getsize(out) == z.getinfo(n).file_size:
            continue
        with z.open(n) as src, open(out, 'wb') as dst:
            dst.write(src.read())
        if i % 20 == 0:
            print(f'    {i}/{len(members)}', flush=True)
    print('  done')


if __name__ == '__main__':
    main()
