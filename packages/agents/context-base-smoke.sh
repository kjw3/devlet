#!/bin/bash
set -eo pipefail
mkdir -p /tmp/context-bin
cat > /tmp/context-bin/curl <<'CURL'
#!/bin/sh
printf '%s\n' '{"data":[{"model_group":"decent-code","max_input_tokens":65536,"max_output_tokens":8192}]}'
CURL
chmod +x /tmp/context-bin/curl
export PATH="/tmp/context-bin:$PATH"
export LITELLM_BASE_URL=http://127.0.0.1:8787 LITELLM_API_KEY=smoke-only DEVLET_AGENT_PROVIDER=litellm DEVLET_AGENT_MODEL=decent-code
source /usr/local/bin/devlet-coding-init
python3 - <<'PY'
import json,pathlib,tomllib
h=pathlib.Path.home()
p=json.loads((h/'.pi/agent/models.json').read_text())['providers']['litellm']['models'][0]
assert p['contextWindow']==65536 and p['maxTokens']==8192
assert p['thinkingLevelMap']['off']=='none'
c=tomllib.loads((h/'.codex/config.toml').read_text());assert c['model_auto_compact_token_limit']==49152
assert json.loads((h/'.config/opencode/config.json').read_text())['compaction']['reserved']==16384
assert json.loads((h/'.gemini/settings.json').read_text())['model']['compressionThreshold']==49152/1048576
print('All five harness context configurations generated')
PY
cat > /tmp/mock-pi.py <<'PY'
import json
from http.server import BaseHTTPRequestHandler,HTTPServer
class H(BaseHTTPRequestHandler):
 def do_POST(self):
  d=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with open('/tmp/pi-request.json','w') as f:json.dump(d,f)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for delta,reason in [({'role':'assistant','content':'OK'},None),({},'stop')]:
   row={'id':'smoke','object':'chat.completion.chunk','created':1,'model':'decent-code','choices':[{'index':0,'delta':delta,'finish_reason':reason}]}
   self.wfile.write(('data: '+json.dumps(row)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
 def log_message(self,*a):pass
HTTPServer(('127.0.0.1',8787),H).serve_forever()
PY
python3 /tmp/mock-pi.py &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
# Version invocations validate that each installed launcher exists.
pi --version
codex --version
opencode --version
claude --version
gemini --version
timeout 45s pi -p 'Say OK' > /tmp/pi-output.txt
python3 - <<'PY'
import json
r=json.load(open('/tmp/pi-request.json'))
assert r['reasoning_effort']=='none',r.get('reasoning_effort')
assert r.get('max_tokens',r.get('max_completion_tokens'))==8192
assert 'OK' in open('/tmp/pi-output.txt').read()
print('Pi actual request: reasoning_effort=none, max_tokens=8192; answer received')
PY
