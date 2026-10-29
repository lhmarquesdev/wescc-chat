import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prune_images", Path(__file__).with_name("prune-images.py"))
prune_images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune_images)


def image(image_id, tags=None, own=False):
    return {
        "Id": image_id,
        "RepoTags": tags or [],
        "Config": {"Labels": {
            "org.opencontainers.image.source": prune_images.SOURCE,
            "org.opencontainers.image.revision": "a" * 40,
        } if own else {}},
    }


class PruneImagesTests(unittest.TestCase):
    def test_keeps_current_previous_and_images_used_by_stopped_containers(self):
        images = [image(name, ["wescchat-hml:" + char * 40])
                  for name, char in [("current", "a"), ("previous", "b"), ("stopped", "c"), ("old", "d")]]
        self.assertEqual(prune_images.candidates(images, {"current", "previous", "stopped"}),
                         [("wescchat-hml:" + "d" * 40, "old")])

    def test_keeps_aliases_of_protected_image_ids(self):
        self.assertEqual(prune_images.candidates([image("current", ["wescchat-hml:" + "e" * 40])], {"current"}), [])

    def test_removes_only_wescchat_tags_from_shared_images(self):
        item = image("old", ["another-app:latest", "wescchat-hml:" + "f" * 40, "wescchat-hml:latest"])
        self.assertEqual(prune_images.candidates([item], set()), [("wescchat-hml:" + "f" * 40, "old")])

    def test_dangling_images_require_own_source_and_revision_labels(self):
        other = image("other", own=True)
        other["Config"]["Labels"]["org.opencontainers.image.source"] = "https://github.com/another/repo"
        no_revision = image("missing-revision", own=True)
        no_revision["Config"]["Labels"].pop("org.opencontainers.image.revision")
        self.assertEqual(prune_images.candidates([image("own", own=True), image("unknown"), other, no_revision], set()),
                         [("own", "own")])

    def test_rejects_unrelated_images_before_calling_docker(self):
        with patch.object(prune_images, "docker") as docker:
            with self.assertRaises(RuntimeError):
                prune_images.prune("another-app:" + "a" * 40, "wescchat-hml:" + "b" * 40, True)
            docker.assert_not_called()

    def test_rejects_cleanup_when_the_active_image_changes(self):
        container = {"Image": "different", "State": {"Running": True, "Health": {"Status": "healthy"}}}
        with patch.object(prune_images, "docker", return_value=json.dumps([container])):
            with self.assertRaises(RuntimeError):
                prune_images.check_current("current")


if __name__ == "__main__":
    unittest.main()
