import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("sync_groups", Path(__file__).with_name("devlet-sync-groups.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class GroupTests(unittest.TestCase):
    def test_runtime_groups_and_process_owner(self):
        status = "Uid: 1001 1001 1001 1001\nGroups: 44 990 1001 44\n"
        self.assertEqual(m.inherited_groups(status, 1001), [44, 990, 1001])
        with self.assertRaises(ValueError):
            m.inherited_groups(status, 1000)
        with self.assertRaises(ValueError):
            m.inherited_groups(status.replace("1001 1001 1001 1001", "1001 0 1001 1001"), 1001)

    def test_gpu_membership_repair_and_idempotence(self):
        user = SimpleNamespace(pw_name="agent", pw_gid=1001)
        groups = {44: SimpleNamespace(gr_name="video", gr_mem=["existing-user"])}
        calls = []

        def lookup(gid):
            if gid not in groups:
                raise KeyError(gid)
            return groups[gid]

        def run(args, check):
            self.assertTrue(check)
            calls.append(args)
            if args[0].endswith("groupadd"):
                groups[int(args[2])] = SimpleNamespace(gr_name=args[3], gr_mem=[])
            else:
                group = next(g for g in groups.values() if g.gr_name == args[3])
                group.gr_mem.append(args[4])

        m.sync_groups([44, 990, 1001], user, lookup, run)
        self.assertEqual(calls, [
            ["/usr/sbin/usermod", "--append", "--groups", "video", "agent"],
            ["/usr/sbin/groupadd", "--gid", "990", "devlet-gid-990"],
            ["/usr/sbin/usermod", "--append", "--groups", "devlet-gid-990", "agent"],
        ])
        self.assertEqual(groups[44].gr_mem, ["existing-user", "agent"])
        calls.clear()
        m.sync_groups([44, 990, 1001], user, lookup, run)
        self.assertEqual(calls, [])

    def test_base_agent_needs_no_changes(self):
        m.sync_groups([1001], SimpleNamespace(pw_name="agent", pw_gid=1001),
                      run=lambda *a, **kw: self.fail("unexpected mutation"))


if __name__ == "__main__":
    unittest.main()
