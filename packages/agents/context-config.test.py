import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("context_config", Path(__file__).with_name("devlet-context-config.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ContextTests(unittest.TestCase):
    def test_local_policy(self):
        for model, values in [("decent-code",(65536,8192,16384,8192)),("decent-code-fast",(32768,4096,16384,4096)),("decent-chat-large",(262144,8192,32768,16384))]:
            p=m.policy(model)
            self.assertEqual(tuple(p[k] for k in ("context","output","reserve","recent")),values)
        self.assertIsNone(m.policy("unknown"))
        self.assertEqual(m.policy("decent-code", "32768", "4096")["context"],32768)
        self.assertIsNone(m.policy("decent-code","4096","8192"))

    def test_pi_preserves_and_maps_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            m.configure(home,"pi","decent-code")
            model=json.loads((home/".pi/agent/models.json").read_text())["providers"]["litellm"]["models"][0]
            self.assertEqual(model["thinkingLevelMap"]["off"],"none")
            path=home/".pi/agent/settings.json"
            data=json.loads(path.read_text())
            self.assertEqual(data["compaction"]["modelOverrides"]["litellm/decent-code"]["reserveTokens"],16384)
            data["defaultThinkingLevel"]="high"
            data["compaction"]["enabled"]=False
            path.write_text(json.dumps(data))
            m.configure(home,"pi","decent-code")
            self.assertEqual(json.loads(path.read_text()),data)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_translations_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            oc=home/".config/opencode/config.json"
            oc.parent.mkdir(parents=True)
            oc.write_text(json.dumps({"model":"litellm/decent-code","mcp":{"kept":{}}}))
            cl=home/".devlet/bin/claude"
            cl.parent.mkdir(parents=True)
            cl.write_text("#!/bin/sh\nexec /bin/echo \"$@\"\n")
            for tool in ("opencode","codex","gemini","claude-code"):m.configure(home,tool,"decent-code")
            data=json.loads(oc.read_text())
            self.assertTrue(data["compaction"]["prune"])
            self.assertEqual(data["provider"]["litellm"]["models"]["decent-code"]["limit"]["context"],65536)
            self.assertIn("kept",data["mcp"])
            self.assertIn("model_auto_compact_token_limit = 49152",(home/".codex/config.toml").read_text())
            gem=json.loads((home/".gemini/settings.json").read_text())
            self.assertEqual(gem["model"]["compressionThreshold"],49152/1048576)
            self.assertIn("CLAUDE_CODE_MAX_CONTEXT_TOKENS:=65536",cl.read_text())
            before={str(p):p.read_text() for p in home.rglob("*") if p.is_file()}
            for tool in ("opencode","codex","gemini","claude-code"):m.configure(home,tool,"decent-code")
            self.assertEqual(before,{str(p):p.read_text() for p in home.rglob("*") if p.is_file()})

    def test_unknown_pi_provider_still_configured_without_guessed_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            m.configure(home,"pi","custom-model")
            model=json.loads((home/".pi/agent/models.json").read_text())["providers"]["litellm"]["models"][0]
            self.assertEqual(model,{"id":"custom-model"})

    def test_malformed_config_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);path=home/".pi/agent/models.json"
            path.parent.mkdir(parents=True);path.write_text("invalid")
            with self.assertRaises(json.JSONDecodeError):m.configure(home,"pi","decent-code")
            self.assertEqual(path.read_text(),"invalid")

if __name__=="__main__": unittest.main()
