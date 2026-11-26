"""Stage the one reviewed Life Gateway archive for a package-only test."""
import hashlib
import shutil
import sys
import zipfile
from pathlib import Path

ZIP_SHA = "dc582ba4c63c0d6a93d29152d954c7ee7bc8c6e918586156799651ca539576ee"
TAR_SHA = "c2b58d66dfe0065f46b3f9588cad6e555b60238ada13488bbc06f5af4b8a09e7"
TAR_NAME = "openclaw-current.tgz"
MEMBERS = sorted([TAR_NAME, "package-candidate.json"])


def stage(zip_path: Path, fresh_directory: Path) -> None:
    # Read the accepted archive through the same descriptor used for hashing.
    with zip_path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != ZIP_SHA:
            raise ValueError("Gateway artifact ZIP digest mismatch")
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            if sorted(archive.namelist()) != MEMBERS:
                raise ValueError("Unexpected Gateway artifact members")
            fresh_directory.mkdir(mode=0o700)
            target = fresh_directory / TAR_NAME
            # Do not extract any paths or permissions from the archive.
            with archive.open(TAR_NAME) as member, target.open("x+b") as output:
                shutil.copyfileobj(member, output)
                output.seek(0)
                if hashlib.file_digest(output, "sha256").hexdigest() != TAR_SHA:
                    raise ValueError("Staged Gateway archive digest mismatch")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: stage_life_gateway.py ZIP NEW_INSTALL_DIRECTORY")
    stage(Path(sys.argv[1]), Path(sys.argv[2]))
