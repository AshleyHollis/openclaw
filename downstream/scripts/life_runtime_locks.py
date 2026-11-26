"""Prepare and verify Linux lock-only inputs for the selected Life packages."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import tarfile
from urllib.parse import urlsplit

OPENCLAW = "2026.11.10"
CODEX = "2026.11.3"
SOURCE = "1798956652c089dc064ecdcb4ba68dfb00b7e657"
TARBALLS = {
    "openclaw": ("openclaw-current.tgz", OPENCLAW, "c2b58d66dfe0065f46b3f9588cad6e555b60238ada13488bbc06f5af4b8a09e7"),
    "@openclaw/codex": ("codex-current.tgz", CODEX, "0d7e194694818490f55c21ec95e7182271b58596963c9eb74901555b649b6fe8"),
}
PREFIX = Path(__file__).resolve().parent.parent / "runtime-install" / "life-lock-inputs"
LINK = "../../app/node_modules/openclaw"


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(path, algorithm):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).digest()


def read_json(path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size < 4 * 1024**2,
            f"Invalid JSON input: {path.name}")
    return json.loads(path.read_bytes())


def package(artifacts, name):
    leaf, version, sha = TARBALLS[name]
    source = artifacts / leaf
    require(source.is_file() and not source.is_symlink() and digest(source, "sha256").hex() == sha,
            f"Wrong {name} archive")
    wanted = {"package/package.json"}
    if name == "openclaw":
        wanted.add("package/dist/build-info.json")
    values = {}
    with tarfile.open(source, "r:gz") as tar:
        for member in tar:
            if member.name in wanted:
                require(member.name not in values and member.isfile() and member.size < 1024**2,
                        f"Invalid {name} metadata")
                values[member.name] = tar.extractfile(member).read()
    require(values.keys() == wanted, f"Incomplete {name} metadata")
    manifest = json.loads(values["package/package.json"])
    require(manifest["name"] == name and manifest["version"] == version,
            f"Wrong {name} version")
    if name == "openclaw":
        info = json.loads(values["package/dist/build-info.json"])
        require(info["version"] == version and info["commit"] == SOURCE, "Wrong Gateway source")
    return values["package/package.json"]


def prepare(artifacts, work):
    host = package(artifacts, "openclaw")
    package(artifacts, "@openclaw/codex")
    work.mkdir(mode=0o700)
    for target in ("app", "plugins"):
        dest = work / target
        dest.mkdir(mode=0o700)
        (dest / "package.json").write_bytes((PREFIX / f"{target}.json").read_bytes())
    linked = work / "app/node_modules/openclaw"
    linked.mkdir(parents=True)
    (linked / "package.json").write_bytes(host)


def registry_leaf(item):
    value = item.get("resolved")
    if not isinstance(value, str):
        return False
    url = urlsplit(value)
    if url.scheme != "https" or url.netloc != "registry.npmjs.org" or not url.path.startswith("/") or url.query or url.fragment:
        return False
    return re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", item.get("integrity", "")) is not None


def inspect_lock(path, target, sri, host):
    lock = read_json(path)
    spec = read_json(PREFIX / f"{target}.json")
    require(lock["lockfileVersion"] == 3 and lock["name"] == spec["name"] and lock["version"] == spec["version"],
            f"Wrong {target} lock header")
    entries = lock["packages"]
    root = entries[""]
    for field in ("dependencies", "optionalDependencies"):
        require(root.get(field, {}) == spec.get(field, {}), f"Wrong {target} root {field}")
    if target == "app":
        local = {"node_modules/openclaw": ("file:../tmp/openclaw-current.tgz", OPENCLAW, sri["openclaw"])}
    else:
        local = {"node_modules/@openclaw/codex": ("file:../../tmp/codex-current.tgz", CODEX, sri["@openclaw/codex"])}
        require(entries.get("node_modules/openclaw") == {"resolved": LINK, "link": True}, "Wrong plugin Gateway link")
        linked = entries[LINK]
        require(linked.get("version") == host["version"] and linked.get("hasInstallScript") is True
                and all(host.get(k, {}) == linked.get(k, {})
                        for k in ("dependencies", "optionalDependencies", "peerDependencies")), "Wrong linked Gateway metadata")
    for key, (location, version, integrity) in local.items():
        item = entries[key]
        require((item.get("resolved"), item.get("version"), item.get("integrity")) == (location, version, integrity),
                f"Wrong local tarball: {key}")
    skip = {"", *local} | ({"node_modules/openclaw", LINK} if target == "plugins" else set())
    for key, item in entries.items():
        if key not in skip:
            require(key.startswith("node_modules/") and
                    (registry_leaf(item) or (item.get("inBundle") is True and "resolved" not in item and "link" not in item)),
                    f"Unexpected {target} dependency source")
    return len(entries)


def verify(artifacts, work, output):
    host = json.loads(package(artifacts, "openclaw"))
    package(artifacts, "@openclaw/codex")
    sri = {name: "sha512-" + base64.b64encode(digest(artifacts / values[0], "sha512")).decode()
           for name, values in TARBALLS.items()}
    report = {"gatewaySource": SOURCE, "gatewayVersion": OPENCLAW, "codexVersion": CODEX,
              "inputIntegrities": sri, "locks": {}, "releaseQualified": False}
    locks = {}
    for target, name in (("app", "host"), ("plugins", "plugins")):
        base = work / target
        chosen = base / "package-lock.json"
        require((base / "package.json").read_bytes() == (PREFIX / f"{target}.json").read_bytes(),
                f"Wrapper changed while generating {target} lock")
        count = inspect_lock(chosen, target, sri, host)
        contents = chosen.read_bytes()
        leaf = name + ".package-lock.json"
        locks[leaf] = contents
        report["locks"][leaf] = {"sha256": hashlib.sha256(contents).hexdigest(), "packages": count}
    output.mkdir(mode=0o700)
    for leaf, contents in locks.items():
        (output / leaf).write_bytes(contents)
    (output / "receipt.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "verify"))
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("work", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    args = parser.parse_args()
    if args.action == "prepare" and args.output is None:
        prepare(args.artifacts, args.work)
    elif args.action == "verify" and args.output is not None:
        verify(args.artifacts, args.work, args.output)
    else:
        parser.error("output is required only for verify")
