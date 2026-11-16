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
    assign_nodes,
    gossip_port,
    host_plan,
    node_port,
    parse_hosts,
    pg_max_connections,
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


if __name__ == "__main__":
    unittest.main()
