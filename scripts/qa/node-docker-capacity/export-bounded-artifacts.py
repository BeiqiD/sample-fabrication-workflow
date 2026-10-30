"""Export only logs, receipts, pin maps and immutable image ID; never fixture state."""
import argparse, hashlib, json, os, stat
from pathlib import Path

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--destination',required=True)
    a=p.parse_args();root=Path(a.root);destination=Path(a.destination)
    assert os.geteuid()==1000 and root.resolve()==root and destination.is_absolute()
    assert root.is_dir() and not root.is_symlink() and root.lstat().st_uid==1000 and stat.S_IMODE(root.stat().st_mode)==0o700
    assert destination.parent.resolve()==destination.parent and not destination.parent.is_symlink()
    assert destination.parent.is_dir() and destination.parent.lstat().st_uid==1000 and stat.S_IMODE(destination.parent.stat().st_mode)==0o755
    assert not destination.exists() and not destination.is_symlink()
    destination.mkdir(mode=0o755)
    selected=[root/'platform-source-and-tools.json',root/'registry'/'receipt.json',root/'actual-six'/'receipt.json',root/'actual-six'/'image.id']
    selected += [root/'prepared'/n for n in ('context-map.json','source-freeze.json')]
    for parent in [root/'registry',root/'actual-six']:
        if parent.is_dir():selected += sorted(parent.glob('*.log'))
    total=0;manifest={}
    for original in selected:
        if not original.exists():continue
        assert original.is_file() and not original.is_symlink()
        relative=original.relative_to(root);assert 'fixture' not in relative.parts
        assert original.lstat().st_size<=16*1024*1024
        data=original.read_bytes();assert len(data)<=16*1024*1024
        total+=len(data);assert total<=64*1024*1024
        q=destination/relative;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(data);q.chmod(0o444)
        manifest[str(relative)]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    (destination/'export-manifest.json').write_text(json.dumps({'files':manifest,'totalBytes':total,
        'scope':'Exact raw/receipts/source pins/image ID only. No DB, keyring, runtime config, volume files, stdin secrets or image tar.'},indent=2)+'\n')
    (destination/'export-manifest.json').chmod(0o444)
    for q in destination.rglob('*'):
        if q.is_dir():q.chmod(0o755)

if __name__=='__main__':main()
