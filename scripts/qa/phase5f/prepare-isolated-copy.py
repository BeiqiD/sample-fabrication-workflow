#!/usr/bin/env python3
"""Copy a committed build into fresh private temporary storage, without state.

This helper never builds, starts a service, copies Git metadata or credentials,
or opens the original installation's databases. Build immediately before use;
the receipt identifies artifact bytes, not an independently proven build HEAD.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def without_symlinks(path):
    """Require every existing component in an already canonical path."""
    for component in (path, *path.parents):
        require(not component.is_symlink(), "Symlink path components are unsupported.")
    return path


def temporary_destination(value):
    temporary_alias = Path(tempfile.gettempdir()).absolute()
    temporary_root = temporary_alias.resolve(strict=True)
    requested = Path(value).expanduser().absolute()
    require(".." not in requested.parts, "Destination must not contain parent traversal.")
    # The operating system's own temporary-directory alias may be a symlink.
    # All components below its canonical root must be real directories.
    if requested.is_relative_to(temporary_alias):
        requested = temporary_root / requested.relative_to(temporary_alias)
    require(requested != temporary_root and requested.is_relative_to(temporary_root),
            "Destination must be below the operating system's temporary directory.")
    without_symlinks(requested)
    require(requested.parent.is_dir(), "Destination parent must already exist.")
    require(requested.parent.resolve(strict=True) == requested.parent,
            "Destination parent must be canonical.")
    require(not requested.exists(), "Destination already exists; preserve earlier evidence.")
    return requested


def safe_relative(value):
    path = Path(value)
    require(value and not path.is_absolute() and ".." not in path.parts,
            "Unsupported relative file path.")
    return path


def regular_file(root, relative):
    path = without_symlinks(root / safe_relative(relative))
    require(path.is_file() and path.resolve(strict=True).is_relative_to(root),
            "Expected a regular file inside the source root.")
    return path


def tree_files(root, relative):
    directory = without_symlinks(root / safe_relative(relative))
    require(directory.is_dir(), "A complete current local build is required.")
    files = []
    for parent, directories, names in os.walk(directory, followlinks=False):
        for name in directories:
            require(not (Path(parent) / name).is_symlink(), "Artifact directories must not be symlinks.")
        for name in names:
            path = Path(parent) / name
            require(not path.is_symlink() and path.is_file(), "Artifacts must be regular files.")
            files.append(path.relative_to(root).as_posix())
    require(files, "Built artifact directory is empty.")
    return sorted(files)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def build_identity(source):
    redirect_relative = ".wrangler/deploy/config.json"
    redirect = read_json(regular_file(source, redirect_relative))
    require(not redirect.get("auxiliaryWorkers"), "Only the single-Worker local build is supported.")
    config_value = redirect.get("configPath")
    require(isinstance(config_value, str) and config_value,
            "Build redirect must identify its generated configuration.")
    unresolved = source / Path(redirect_relative).parent / config_value
    without_symlinks(unresolved)
    config_path = unresolved.resolve(strict=True)
    require(config_path.is_relative_to(source / "dist") and config_path.is_file(),
            "Build redirect must select a generated configuration inside dist.")
    config = read_json(config_path)
    require(config.get("no_bundle") is True, "Expected a prebuilt no_bundle Worker.")
    require(config.get("assets", {}).get("not_found_handling") == "single-page-application"
            and config.get("assets", {}).get("run_worker_first") == ["/api/*"],
            "Expected the production application's SPA and API routing.")
    main = config.get("main")
    assets = config.get("assets", {}).get("directory")
    require(isinstance(main, str) and isinstance(assets, str), "Built entry and assets are required.")
    script_path = without_symlinks(config_path.parent / main).resolve(strict=True)
    assets_directory = without_symlinks(config_path.parent / assets).resolve(strict=True)
    require(script_path.is_file() and script_path.is_relative_to(source / "dist")
            and assets_directory.is_dir() and assets_directory.is_relative_to(source / "dist"),
            "Active Worker entry and assets must remain inside dist.")
    generated = read_json(regular_file(source, ".wrangler/deploy.jsonc"))
    for value in (generated, config):
        databases = value.get("d1_databases", [])
        buckets = value.get("r2_buckets", [])
        require(value.get("vars", {}).get("AUTH_MODE") == "disabled"
                and not value.get("account_id")
                and len(databases) == 1 and databases[0].get("binding") == "DB"
                and databases[0].get("database_id") == "00000000-0000-4000-8000-000000000000"
                and not databases[0].get("remote") and not databases[0].get("preview_database_id")
                and len(buckets) == 1 and buckets[0].get("binding") == "ASSETS"
                and not buckets[0].get("remote"),
                "Only generated local development bindings are supported.")
        namespace = json.loads(value.get("vars", {}).get("R2_BOOTSTRAP_NAMESPACE", "null"))
        require(isinstance(namespace, dict) and namespace.get("kind") == "local-r2"
                and namespace.get("bucketName") == buckets[0].get("bucket_name"),
                "Expected the generated local R2 bootstrap namespace.")
    require(generated.get("name") == config.get("name")
            and generated.get("vars") == config.get("vars")
            and generated["d1_databases"][0].get("database_name")
            == config["d1_databases"][0].get("database_name")
            and generated["r2_buckets"] == config["r2_buckets"],
            "Built and migration configurations must agree on local identity.")
    installation = read_json(regular_file(source, ".wrangler/local-installation.json"))
    namespace = json.loads(generated["vars"]["R2_BOOTSTRAP_NAMESPACE"])
    require(installation.get("installationId") == namespace.get("installationId"),
            "Local installation and R2 namespace must agree.")
    return {
        "redirectPath": redirect_relative,
        "configPath": config_path.relative_to(source).as_posix(),
        "scriptPath": script_path.relative_to(source).as_posix(),
        "assetsDirectory": assets_directory.relative_to(source).as_posix(),
        "configSha256": sha256(config_path),
        "scriptSha256": sha256(script_path),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=str(Path(__file__).resolve().parents[3]))
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    requested_source = Path(args.source_root).expanduser().absolute()
    without_symlinks(requested_source)
    source = requested_source.resolve(strict=True)
    require(source.is_dir(), "Source root must be an existing repository directory.")
    destination = temporary_destination(args.destination)
    require(not destination.is_relative_to(source) and not source.is_relative_to(destination),
            "Source and isolated destination must be separate directories.")

    def git(*arguments):
        return subprocess.check_output(["git", *arguments], cwd=source)

    require(Path(os.fsdecode(git("rev-parse", "--show-toplevel")).strip()).resolve() == source,
            "Source root must be the repository root.")
    head = git("rev-parse", "HEAD").decode().strip()
    tree = git("rev-parse", "HEAD^{tree}").decode().strip()
    require(not git("status", "--porcelain", "--untracked-files=all").strip(),
            "Commit and review source before copying; working tree is not clean.")
    tracked = sorted(os.fsdecode(raw) for raw in git("ls-files", "-z").split(b"\0") if raw)
    require(tracked, "Repository contains no tracked source files.")
    for relative in tracked:
        path = safe_relative(relative)
        require(not any(part in {".git", ".aws", ".codex", ".agents", "node_modules"}
                        for part in path.parts)
                and path.parts[0] not in {"dist", ".wrangler"}
                and not ((path.name == ".env" or path.name.startswith((".env.", ".dev.vars")))
                         and not path.name.endswith(".example")),
                "Tracked credential, generated state or dependency files cannot be copied.")
        regular_file(source, relative)
    dependencies = without_symlinks(source / "node_modules").resolve(strict=True)
    require(dependencies.is_dir(), "Existing source dependencies are required; this helper does not install.")
    artifact_paths = tree_files(source, "dist") + [
        ".wrangler/deploy.jsonc", ".wrangler/deploy/config.json", ".wrangler/local-installation.json",
    ]
    artifacts = {relative: sha256(regular_file(source, relative)) for relative in sorted(artifact_paths)}
    files = {relative: sha256(regular_file(source, relative)) for relative in tracked}
    active_build = build_identity(source)
    migration_paths = sorted(path.relative_to(source).as_posix()
                             for path in (source / "migrations").glob("*.sql"))
    require(migration_paths and all(relative in files for relative in migration_paths),
            "Ordered migrations must be code-owned tracked SQL files.")
    migrations = [{"name": Path(relative).name, "sha256": files[relative]}
                  for relative in migration_paths]

    destination.mkdir(mode=0o700)
    require(stat.S_IMODE(destination.stat().st_mode) == 0o700, "Isolated root must be private mode 0700.")
    for relative, expected in {**files, **artifacts}.items():
        original = regular_file(source, relative)
        require(sha256(original) == expected, "Source changed before copying; preserve the failed attempt.")
        copied = destination / relative
        copied.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(original, copied)
        require(sha256(copied) == expected and sha256(original) == expected,
                "Source or artifact changed during copying; snapshot is unqualified.")
    # This is the only permitted symlink. Dependencies are shared, with read-only
    # intent; no install or package command that changes them is run here.
    (destination / "node_modules").symlink_to(dependencies, target_is_directory=True)
    require(head == git("rev-parse", "HEAD").decode().strip()
            and tree == git("rev-parse", "HEAD^{tree}").decode().strip()
            and not git("status", "--porcelain", "--untracked-files=all").strip(),
            "Source commit or working tree changed during copying.")
    require(tracked == sorted(os.fsdecode(raw) for raw in git("ls-files", "-z").split(b"\0") if raw),
            "Tracked file inventory changed during copying.")
    require(artifact_paths == tree_files(source, "dist") + [
        ".wrangler/deploy.jsonc", ".wrangler/deploy/config.json", ".wrangler/local-installation.json",
    ], "Built artifact inventory changed during copying.")
    require(all(sha256(regular_file(source, relative)) == expected
                for relative, expected in {**files, **artifacts}.items())
            and build_identity(source) == active_build,
            "Source or artifact bytes changed during copying.")
    require(all(sha256(regular_file(destination, relative)) == expected
                for relative, expected in {**files, **artifacts}.items()),
            "Copied source or artifact bytes changed before the receipt was written.")
    receipt = {
        "version": 2, "sourceRoot": str(source), "sourceCopyRoot": str(destination),
        "sourceHead": head, "sourceTree": tree, "trackedFiles": files,
        "copiedArtifactFiles": artifacts, "activeBuild": active_build,
        "migrationFiles": migrations, "nodeModulesRoot": str(dependencies), "copiedState": False,
        "helperSha256": sha256(Path(__file__).resolve()),
        "scope": "Fresh isolated copy only; no database state, credentials, Git metadata, server or API writes copied. Artifact hashes do not independently attest the build's source HEAD.",
    }
    with (destination / "isolation-receipt.json").open("x", encoding="utf-8") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps({"destination": str(destination), "sourceHead": head,
                      "copiedState": False, "copiedFiles": len(files), "artifacts": len(artifacts)}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
