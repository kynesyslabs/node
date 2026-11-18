"""Multi-host inputs of the quorum drills (run.sh --hosts): host plan parsing
and assignment (drill_inputs.py) and the per-host files gen-inputs.py writes.

    python3 -m unittest testing/devnet/quorum-drills/test_multihost_inputs.py
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../.."))
sys.path.insert(0, HERE)

from drill_inputs import (  # noqa: E402
    CARRYOVER_FORK,
    assign_nodes,
    campaign_summary,
    gossip_port,
    host_plan,
    hosts_file_text,
    node_port,
    parse_hosts,
    parse_inventory,
    pg_max_connections,
    summarize_resources,
    test_chain_problem,
)

DIGEST = "ghcr.io/example/demos-node@sha256:" + "a" * 64
# Four hosts, the second capped at 5 nodes
HOSTS = """
# controller-reachable addresses, one per line
demos@10.0.0.1
demos@10.0.0.2 5
ubuntu@10.0.0.3

root@10.0.0.4
"""


def gen(run_dir, nodes=30, hosts_text=HOSTS, extra=()):
    inputs = os.path.join(run_dir, "inputs")
    os.makedirs(inputs, exist_ok=True)
    for i in range(1, nodes + 1):
        with open(f"{inputs}/pub{i}", "w") as f:
            f.write(f"0x{0xA0 + i:064x}")
        with open(f"{inputs}/node{i}.identity", "w") as f:
            f.write(f"mnemonic {i}")
    hosts_file = os.path.join(run_dir, "hosts.txt")
    with open(hosts_file, "w") as f:
        f.write(hosts_text)
    cmd = [
        sys.executable, os.path.join(HERE, "gen-inputs.py"), "--run-dir", run_dir, "--repo", REPO,
        "--nodes", str(nodes), "--shard-size", "10", "--binding", "on", "--fork-set", "launch",
        "--genesis-ts", "1700000000", "--image", DIGEST, "--uid", "1000", "--gid", "1000",
        "--node-mem", "1536m", "--consensus-time", "10", "--start", "image",
        "--image-entrypoint", '["/usr/local/bin/docker-entrypoint.sh"]', "--image-cmd", '["bun","run","start"]',
        "--hosts-file", hosts_file, *extra,
    ]
    return subprocess.run(cmd, capture_output=True, text=True)


class HostPlan(unittest.TestCase):
    def test_parse(self):
        hosts = parse_hosts(HOSTS)
        self.assertEqual([h["ssh"] for h in hosts], ["demos@10.0.0.1", "demos@10.0.0.2", "ubuntu@10.0.0.3", "root@10.0.0.4"])
        self.assertEqual([h["ip"] for h in hosts], ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"])
        self.assertEqual([h["max"] for h in hosts], [0, 5, 0, 0])

    def test_parse_errors(self):
        for bad in ("10.0.0.1\n", "a@10.0.0.1 0\n", "a@10.0.0.1 x\n", "a@10.0.0.1\nb@10.0.0.1\n", "# none\n", "a@b c d\n"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_hosts(bad)

    def test_round_robin_within_capacity(self):
        hosts = parse_hosts(HOSTS)
        owner = assign_nodes(hosts, 30)
        self.assertEqual(len(owner), 30)
        # node 1 (the peerlist seed) on host 1, then round robin
        self.assertEqual(owner[:8], [0, 1, 2, 3, 0, 1, 2, 3])
        counts = [owner.count(k) for k in range(4)]
        self.assertEqual(counts[1], 5)
        self.assertEqual(sum(counts), 30)
        self.assertEqual(counts, [9, 5, 8, 8])

    def test_not_enough_capacity(self):
        with self.assertRaises(ValueError):
            assign_nodes(parse_hosts("a@10.0.0.1 10\nb@10.0.0.2 10\n"), 30)

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "hosts")
            with open(f, "w") as fh:
                fh.write(HOSTS)
            r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "drill_inputs.py"), "hosts", "--file", f, "--nodes", "30"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            lines = [line.split("\t") for line in r.stdout.splitlines()]
            self.assertEqual([x[0] for x in lines], ["1", "2", "3", "4"])
            self.assertEqual(lines[1][1:4], ["demos@10.0.0.2", "10.0.0.2", "5"])
            self.assertEqual(sorted(int(n) for x in lines for n in x[4].split(",")), list(range(1, 31)))
            with open(f, "w") as fh:
                fh.write("a@10.0.0.1 3\n")
            r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "drill_inputs.py"), "hosts", "--file", f, "--nodes", "30"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)


class GenInputs30On4Hosts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.run_dir = cls.tmp.name
        cls.r = gen(cls.run_dir)
        cls.plan = host_plan(parse_hosts(HOSTS), 30)
        cls.ip_of = {i: h["ip"] for h in cls.plan for i in h["nodes"]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.assertEqual(self.r.returncode, 0, self.r.stderr)

    def load(self, *parts):
        with open(os.path.join(self.run_dir, *parts)) as f:
            return json.load(f)

    def test_genesis(self):
        g = self.load("inputs", "genesis.json")
        self.assertEqual(g["properties"]["shardSize"], 10)
        self.assertEqual(len(g["validators"]), 30)
        # the halt judge refuses a genesis without these active at block 0
        for fork in ("quorumParity", "committeeBinding", "commitLock"):
            self.assertEqual(g["forks"][fork]["activationHeight"], 0, fork)
        for i, v in enumerate(g["validators"], start=1):
            self.assertEqual(v["connection_url"], f"http://{self.ip_of[i]}:{node_port(i)}")
        self.assertEqual(self.load("hosts", "1", "inputs", "genesis.json"), g)

    def test_ports(self):
        self.assertEqual((node_port(1), node_port(30)), (53551, 53609))
        self.assertEqual((gossip_port(1), gossip_port(30)), (54550, 54579))
        published = set()
        for h in self.plan:
            c = self.load("hosts", str(h["index"]), "compose.yml")
            for i in h["nodes"]:
                svc = c["services"][f"node-{i}"]
                p, gp = node_port(i), gossip_port(i)
                self.assertEqual(svc["ports"], [f"{p}:{p}", f"{p + 1}:{p + 1}", f"{gp}:{gp}"])
                self.assertEqual(svc["environment"]["EXPOSED_URL"], f"http://{h['ip']}:{p}")
                self.assertEqual(svc["environment"]["GOSSIP_PORT"], str(gp))
                self.assertEqual(svc["environment"]["PG_DATABASE"], f"node{i}_db")
                published.update((p, p + 1, gp))
        # no two nodes share a port, on a host or across hosts
        self.assertEqual(len(published), 90)

    def test_assignment_and_compose_per_host(self):
        self.assertEqual(self.load("hosts.json"), self.plan)
        seen = []
        for h in self.plan:
            hdir = os.path.join(self.run_dir, "hosts", str(h["index"]))
            c = self.load("hosts", str(h["index"]), "compose.yml")
            nodes = sorted(int(s.split("-")[1]) for s in c["services"] if s.startswith("node-"))
            self.assertEqual(nodes, sorted(h["nodes"]))
            seen += nodes
            # only this host's identities travel there
            ids = sorted(int(re.match(r"node(\d+)\.identity$", f).group(1)) for f in os.listdir(os.path.join(hdir, "inputs"))
                         if f.endswith(".identity"))
            self.assertEqual(ids, sorted(h["nodes"]))
            # its postgres serves only its databases, with connections for them
            pg = c["services"]["postgres"]
            self.assertIn(f"max_connections={pg_max_connections(len(h['nodes']))}", pg["command"])
            with open(os.path.join(hdir, "inputs", "pg-init", "init.sql")) as f:
                sql = f.read()
            self.assertEqual(sorted({int(x) for x in re.findall(r"node(\d+)_db", sql)}), sorted(h["nodes"]))
            # every bind mount is relative to the host dir and exists in it
            for name, svc in c["services"].items():
                for vol in svc.get("volumes", []):
                    src = vol.split(":")[0]
                    self.assertTrue(src.startswith("./"), f"{name}: {vol}")
                    self.assertTrue(os.path.exists(os.path.join(hdir, src)), f"{name}: {src} missing")
        self.assertEqual(sorted(seen), list(range(1, 31)))
        self.assertEqual(len(self.plan[1]["nodes"]), 5)

    def test_peerlist(self):
        pl = self.load("inputs", "peerlist.json")
        self.assertEqual(pl, {f"0x{0xA1:064x}": f"http://10.0.0.1:{node_port(1)}"})
        for h in self.plan:
            self.assertEqual(self.load("hosts", str(h["index"]), "inputs", "peerlist.json"), pl)

    def test_reference_compose(self):
        c = self.load("compose.yml")
        self.assertEqual(sorted(c["services"]), sorted(f"node-{i}" for i in range(1, 31)))
        self.assertIn("host 2 demos@10.0.0.2: 5 nodes 2,6,10,14,18", self.r.stdout)

    def test_src_refused(self):
        with tempfile.TemporaryDirectory() as d:
            r = gen(d, extra=("--src", REPO))
            self.assertEqual(r.returncode, 2)
            self.assertIn("--src cannot be used with --hosts-file", r.stderr)


INVENTORY = """
# address user port validators
203.0.113.11 drill 22 3
198.51.100.21 ubuntu 2222 3
node-c.example.net drill 22 4
"""


class Inventory(unittest.TestCase):
    def test_parse_and_hosts_file(self):
        hosts = parse_inventory(INVENTORY)
        self.assertEqual([h["max"] for h in hosts], [3, 3, 4])
        self.assertEqual([h["port"] for h in hosts], [22, 2222, 22])
        text = hosts_file_text(hosts)
        self.assertEqual(text.splitlines()[1], "ubuntu@198.51.100.21:2222 3")
        # run.sh reads the hosts file back to the same hosts
        self.assertEqual(parse_hosts(text), hosts)
        # every validator placed, each host at exactly its count
        owner = assign_nodes(hosts, 10)
        self.assertEqual([owner.count(k) for k in range(3)], [3, 3, 4])

    def test_parse_errors(self):
        for bad in ("1.2.3.4 u 22\n", "1.2.3.4 u 22 0\n", "1.2.3.4 u 70000 3\n", "1.2.3.4 u;x 22 3\n",
                    "1.2.3.4 u 22 3\n1.2.3.4 v 22 3\n", "# nothing\n", "1.2.3.4 u 22 401\n"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_inventory(bad)

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            f, out = os.path.join(d, "inv"), os.path.join(d, "hosts")
            with open(f, "w") as fh:
                fh.write(INVENTORY)
            r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "drill_inputs.py"), "inventory", "--file", f, "--hosts-out", out],
                               capture_output=True, text=True)
            self.assertEqual((r.returncode, r.stdout), (0, "10 3\n"), r.stderr)
            with open(out) as fh:
                self.assertEqual(parse_hosts(fh.read()), parse_inventory(INVENTORY))
        with open(os.path.join(HERE, "inventory.example")) as fh:
            example = parse_inventory(fh.read())
        self.assertEqual((len(example), sum(h["max"] for h in example)), (10, 30))


class ChainGuard(unittest.TestCase):
    def test_test_chain_ids_only(self):
        self.assertIsNone(test_chain_problem({"properties": {"id": 1337}}))
        self.assertIsNone(test_chain_problem({"properties": {"id": 1}}))
        for cid in (53, "1337", None, True, 1337.0):
            with self.subTest(cid=cid):
                self.assertIn("is not a test network's", test_chain_problem({"properties": {"id": cid}}))

    def test_devnet_genesis_is_on_a_test_chain(self):
        with open(os.path.join(REPO, "testing", "devnet", "genesis.devnet.json")) as f:
            self.assertIsNone(test_chain_problem(json.load(f)))


class CloudInputs(unittest.TestCase):
    """--bind-host-ip, load wallets and --carryover on 6 nodes over 2 hosts."""

    HOSTS2 = "drill@10.0.0.1:22 3\ndrill@10.0.0.2:2222 3\n"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.run_dir = cls.tmp.name
        load = os.path.join(cls.run_dir, "inputs", "load")
        os.makedirs(load)
        for j in (1, 2):
            with open(os.path.join(load, f"wallet{j}.pub"), "w") as f:
                f.write(f"0x{0xF0 + j:064X}")
        with open(os.path.join(load, "load-client.ts"), "w") as f:
            f.write("// stub")
        cls.r = gen(cls.run_dir, nodes=6, hosts_text=cls.HOSTS2, extra=("--bind-host-ip", "--carryover"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.assertEqual(self.r.returncode, 0, self.r.stderr)

    def load(self, *parts):
        with open(os.path.join(self.run_dir, *parts)) as f:
            return json.load(f)

    def test_ports_bound_to_the_host_address(self):
        c = self.load("hosts", "2", "compose.yml")
        p, gp = node_port(2), gossip_port(2)
        self.assertEqual(c["services"]["node-2"]["ports"], [f"10.0.0.2:{p}:{p}", f"10.0.0.2:{p + 1}:{p + 1}", f"10.0.0.2:{gp}:{gp}"])

    def test_load_wallets_funded_and_load_service_on_host_1(self):
        g = self.load("inputs", "genesis.json")
        funded = {b[0] for b in g["balances"]}
        self.assertTrue({f"0x{0xF1:064x}", f"0x{0xF2:064x}"} <= funded)
        c1, c2 = self.load("hosts", "1", "compose.yml"), self.load("hosts", "2", "compose.yml")
        self.assertNotIn("load", c2["services"])
        svc = c1["services"]["load"]
        self.assertEqual(svc["image"], DIGEST)
        self.assertEqual(svc["profiles"], ["load"])
        self.assertIn("./inputs/load/load-client.ts:/app/qdrill-load-client.ts:ro", svc["volumes"])
        self.assertTrue(os.path.exists(os.path.join(self.run_dir, "hosts", "1", "inputs", "load", "load-client.ts")))
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "hosts", "2", "inputs", "load")))

    def test_carryover_mounts_and_bind(self):
        g = self.load("inputs", "genesis.json")
        self.assertEqual(g["forks"][CARRYOVER_FORK]["activationHeight"], 0)
        c = self.load("hosts", "1", "compose.yml")
        self.assertIn("./inputs/snapshot:/app/data/snapshot:ro", c["services"]["node-1"]["volumes"])
        snap = os.path.join(self.run_dir, "inputs", "snapshot")
        with open(os.path.join(snap, "manifest.json"), "w") as f:
            f.write('{"stub": true}')
        import hashlib
        with open(os.path.join(snap, "manifest.json"), "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        cli = [sys.executable, "-I", os.path.join(HERE, "drill_inputs.py"), "bind-carryover", "--run-dir", self.run_dir]
        r = subprocess.run([*cli, "--manifest-sha", "0" * 64], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("hashes to", r.stderr)
        r = subprocess.run([*cli, "--manifest-sha", sha], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.count("bound "), 3)
        for k in ("1", "2"):
            self.assertEqual(self.load("hosts", k, "inputs", "genesis.json")["snapshot"], {"manifestSha256": sha})
            self.assertTrue(os.path.exists(os.path.join(self.run_dir, "hosts", k, "inputs", "snapshot", "manifest.json")))

    def test_refusals(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, os.path.join(HERE, "gen-inputs.py"), "--run-dir", d, "--repo", REPO, "--nodes", "4",
                                "--shard-size", "4", "--binding", "on", "--genesis-ts", "1", "--image", DIGEST, "--node-mem", "1g",
                                "--consensus-time", "10", "--bind-host-ip"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)
            self.assertIn("--bind-host-ip applies to --hosts-file only", r.stderr)


STATS = "\n".join([
    "100\th1:qdrill-x-node-1-1\t50.0%\t600MiB / 1.5GiB\t1MB / 2MB\t0B / 10MB",
    "160\th1:qdrill-x-node-1-1\t150.0%\t640MiB / 1.5GiB\t4MB / 5MB\t0B / 20MB",
    "100\th1:qdrill-x-postgres-1\t5.0%\t140MiB / 2GiB\t1kB / 1kB\t0B / 1MB",
    "130\th1:qdrill-x-node-2-1\t--\t-- / --\t-- / --\t-- / --",
    "garbage",
])


class Resources(unittest.TestCase):
    def test_summary(self):
        s = summarize_resources(STATS)
        self.assertEqual(s["skipped"], 2)
        n = s["containers"]["h1:qdrill-x-node-1-1"]
        self.assertEqual((n["samples"], n["spanS"], n["memPeakMiB"], n["cpuMeanPct"], n["cpuPeakPct"]), (2, 60, 640.0, 100.0, 150.0))
        # (3 + 3) MB more in 60 s
        self.assertEqual(n["netMBPerHour"], 360.0)
        self.assertEqual(s["roles"]["node"]["containers"], 1)
        self.assertEqual(s["roles"]["postgres"]["memPeakMiBMax"], 140.0)
        self.assertIsNone(s["containers"]["h1:qdrill-x-postgres-1"]["netMBPerHour"])


class CampaignSummary(unittest.TestCase):
    def test_from_the_campaign_files(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "results.tsv"), "w") as f:
                f.write("scenario\texit\tresult\tminutes\trun\nhalt-n6s6\t0\tPASS\t9\tr1\n")
            run = os.path.join(d, "evidence", "r1")
            os.makedirs(os.path.join(run, "logs"))
            with open(os.path.join(run, "logs", "verdict.json"), "w") as f:
                json.dump({"result": "PASS", "detail": "ok", "drill": {"summary": "halted, recovered"}}, f)
            with open(os.path.join(run, "resources-summary.json"), "w") as f:
                json.dump(summarize_resources(STATS), f)
            md = campaign_summary(d)
        self.assertIn("| halt-n6s6 | 0 | PASS | 9 | r1 |", md)
        self.assertIn("- result: **PASS** (ok)", md)
        self.assertIn("- judge: halted, recovered", md)
        self.assertIn("node (1): memory peak max 640.0 MiB", md)
        self.assertIn("(hosts.tsv missing)", md)
        self.assertIn("teardown-check.txt missing", md)
        self.assertIn("(leftovers.txt missing)", md)


if __name__ == "__main__":
    unittest.main()
