#!/usr/bin/env python3
"""Apply the validated Hermes finalization fix; fail closed on upstream drift."""
import argparse
import hashlib
import os
from pathlib import Path

BASE_SHA256 = '77ca6c9e92cb7e887fd1d0d950da417e5540a865a6866af9ad0c23b784e7f6bf'
FIXED_SHA256 = 'b3adbc1e6ac76f47611e10468377e41b09dbfa95ee4a221ff60c50321459d0f0'


def apply(root: Path, check: bool = False):
    path = root / 'agent/turn_finalizer.py'
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if digest == FIXED_SHA256:
        print('Hermes finalizer fix verified: ' + digest)
        return
    if check:
        raise SystemExit('Hermes finalizer fix is absent: ' + digest)
    if digest != BASE_SHA256:
        raise SystemExit('Unreviewed Hermes finalizer revision; refuse patch: ' + digest)
    old = 'final_response is None and budget_exhausted and not interrupted and not failed'
    new = 'not flatten_message_text(final_response).strip() and budget_exhausted and not interrupted and not failed'
    text = content.decode('utf-8').replace(old, new, 1)
    old = '    _streamed = _streamed.strip() if isinstance(_streamed, str) else ""\n    if not (flatten_message_text(final_response).strip() if final_response else "") and _streamed:'
    new = '''    _streamed = _streamed.strip() if isinstance(_streamed, str) else ""
    # The ordinary final-text path removes protocol markup; stream recovery must
    # not resurrect a rejected tool block or reasoning as a user-facing answer.
    from agent.agent_runtime_helpers import strip_think_blocks

    _streamed = strip_think_blocks(agent, _streamed).strip()
    if not (flatten_message_text(final_response).strip() if final_response else "") and _streamed:'''
    text = text.replace(old, new, 1)
    assert hashlib.sha256(text.encode('utf-8')).hexdigest() == FIXED_SHA256
    compile(text, str(path), 'exec')
    st = path.stat()
    temporary = path.with_name(path.name + '.devlet-finalizer.tmp')
    temporary.write_text(text, encoding='utf-8')
    temporary.chmod(st.st_mode & 0o777)
    if os.geteuid() == 0:
        os.chown(temporary, st.st_uid, st.st_gid)
    os.replace(temporary, path)
    print('Hermes finalizer fix applied: ' + FIXED_SHA256)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    apply(args.root, args.check)
