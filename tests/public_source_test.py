"""Exercise source selection using synthetic data only."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/public_source.py"


class PublicSourceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="localdesk-source-test-")
        self.root = Path(self.temp.name) / "prep"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "public").mkdir()
        shutil.copyfile(SCRIPT, self.root / "scripts/public_source.py")
        (self.root / "README.md").write_text("PRIVATE_SYNTHETIC_FIXTURE\n")
        (self.root / "public/README.md").write_text("Public fixture\n")
        files = [
            {"source": "public/README.md", "target": "README.md"},
            {"source": "public-source.json", "target": "public-source.json"},
            {"source": "scripts/public_source.py", "target": "scripts/public_source.py"},
        ]
        files.sort(key=lambda row: row["source"])
        (self.root / "public-source.json").write_text(json.dumps({"files": files, "releaseBlockers": []}))
        for path in ["README.md", "public/README.md", "public-source.json", "scripts/public_source.py"]:
            (self.root / path).chmod(0o644)

    def tearDown(self):
        self.temp.cleanup()

    def run_source(self, root, *args):
        return subprocess.run(
            ["python3", str(root / "scripts/public_source.py"), *args],
            cwd=root, capture_output=True, text=True,
        )

    def test_receipt_cannot_switch_a_preparation_checkout(self):
        (self.root / "candidate-receipt.json").write_text("{}")
        result = self.run_source(self.root, "--export")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "Local/public-candidates").exists())

    def test_exported_receipt_is_checked_before_target_mode(self):
        result = self.run_source(self.root, "--export")
        self.assertEqual(result.returncode, 0, result.stderr)
        candidates = list((self.root / "Local/public-candidates").glob("*/candidate-receipt.json"))
        self.assertEqual(len(candidates), 1)
        exported = candidates[0].parent
        self.assertEqual((exported / "README.md").read_text(), "Public fixture\n")
        self.assertEqual(self.run_source(exported).returncode, 0)
        shutil.copyfile(exported / "candidate-receipt.json", self.root / "candidate-receipt.json")
        self.assertNotEqual(self.run_source(self.root, "--export").returncode, 0)
        (exported / "README.md").write_text("changed\n")
        self.assertNotEqual(self.run_source(exported).returncode, 0)

    def test_index_requires_all_source_files_in_manifest(self):
        canonical = Path(self.temp.name) / "canonical"
        (canonical / "scripts").mkdir(parents=True)
        shutil.copyfile(SCRIPT, canonical / "scripts/public_source.py")
        (canonical / "README.md").write_text("Public fixture\n")
        names = ["README.md", "public-source.json", "scripts/public_source.py"]
        (canonical / "public-source.json").write_text(json.dumps({
            "files": [{"source": name, "target": name} for name in names],
            "releaseBlockers": [],
        }))
        for name in names:
            (canonical / name).chmod(0o644)
        subprocess.run(["git", "init", "-q", str(canonical)], check=True)
        subprocess.run(["git", "-C", str(canonical), "add", *names], check=True)
        self.assertEqual(self.run_source(canonical, "--index").returncode, 0)
        (canonical / "unlisted.txt").write_text("A new source file\n")
        result = self.run_source(canonical, "--index")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inventory differs", result.stderr)


if __name__ == "__main__":
    unittest.main()
