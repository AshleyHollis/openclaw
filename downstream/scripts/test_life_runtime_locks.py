import base64
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import life_runtime_locks as locks


class LifeRuntimeLockTest(unittest.TestCase):
    def test_preparation_and_lock_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, output = root / "work", root / "result"
            pins, sri = {}, {}
            host = {"name": "openclaw", "version": locks.OPENCLAW, "dependencies": {"example": "1.0.0"}}
            for name, (leaf, version, _) in locks.TARBALLS.items():
                manifest = host if name == "openclaw" else {"name": name, "version": version}
                content = {"package/package.json": manifest}
                if name == "openclaw":
                    content["package/dist/build-info.json"] = {"version": version, "commit": locks.SOURCE}
                target = root / leaf
                with tarfile.open(target, "w:gz") as archive:
                    for filename, data in content.items():
                        value = json.dumps(data).encode()
                        item = tarfile.TarInfo(filename)
                        item.size = len(value)
                        archive.addfile(item, io.BytesIO(value))
                pins[name] = (leaf, version, hashlib.sha256(target.read_bytes()).hexdigest())
                sri[name] = "sha512-" + base64.b64encode(hashlib.sha512(target.read_bytes()).digest()).decode()
            with patch.object(locks, "TARBALLS", pins):
                locks.prepare(root, work)
                self.assertEqual(json.loads((work / "app/node_modules/openclaw/package.json").read_bytes()), host)
                for role in ("app", "plugins"):
                    spec = json.loads((work / role / "package.json").read_bytes())
                    entries = {"": {k: spec[k] for k in ("dependencies", "optionalDependencies") if k in spec}}
                    if role == "app":
                        entries["node_modules/openclaw"] = {
                            "version": locks.OPENCLAW, "resolved": "file:../tmp/openclaw-current.tgz",
                            "integrity": sri["openclaw"],
                        }
                    else:
                        entries["node_modules/openclaw"] = {"resolved": locks.LINK, "link": True}
                        entries[locks.LINK] = {"version": locks.OPENCLAW, "hasInstallScript": True,
                                              "dependencies": host["dependencies"]}
                        entries["node_modules/@openclaw/codex"] = {
                            "version": locks.CODEX, "resolved": "file:../../tmp/codex-current.tgz",
                            "integrity": sri["@openclaw/codex"],
                        }
                    entries["node_modules/example"] = {"resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
                                                      "integrity": sri["openclaw"]}
                    data = {"name": spec["name"], "version": spec["version"], "lockfileVersion": 3, "packages": entries}
                    path = work / role / "package-lock.json"
                    for malicious in (
                        {"resolved": "https://user@registry.npmjs.org/example.tgz", "integrity": sri["openclaw"]},
                        {"resolved": "https://registry.npmjs.org.evil.invalid/example.tgz", "integrity": sri["openclaw"]},
                        {"resolved": "https://registry.npmjs.org/example.tgz?secret=x", "integrity": sri["openclaw"]},
                        {"resolved": "file:../example.tgz", "integrity": sri["openclaw"]},
                        {"resolved": "https://registry.npmjs.org/example.tgz", "integrity": "sha1-invalid"},
                    ):
                        changed = deepcopy(data)
                        changed["packages"]["node_modules/example"] = malicious
                        path.write_text(json.dumps(changed), encoding="utf-8")
                        with self.assertRaisesRegex(ValueError, "dependency source"):
                            locks.inspect_lock(path, role, sri, host)
                    chosen = "node_modules/openclaw" if role == "app" else "node_modules/@openclaw/codex"
                    changed = deepcopy(data)
                    changed["packages"][chosen]["integrity"] = sri["@openclaw/codex" if role == "app" else "openclaw"]
                    path.write_text(json.dumps(changed), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "Wrong local tarball"):
                        locks.inspect_lock(path, role, sri, host)
                    path.write_text(json.dumps(data), encoding="utf-8")
                locks.verify(root, work, output)
                self.assertEqual(set(p.name for p in output.iterdir()),
                                 {"receipt.json", "host.package-lock.json", "plugins.package-lock.json"})
                self.assertFalse(json.loads((output / "receipt.json").read_bytes())["releaseQualified"])
                (root / pins["openclaw"][0]).write_bytes(b"not the package")
                with self.assertRaisesRegex(ValueError, "Wrong openclaw archive"):
                    locks.prepare(root, root / "bad")
                self.assertFalse((root / "bad").exists())


if __name__ == "__main__":
    unittest.main()
