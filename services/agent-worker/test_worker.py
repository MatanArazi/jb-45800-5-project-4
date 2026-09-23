import unittest

import worker


class WorkerContractTests(unittest.TestCase):
    def test_all_checkpoint_classes_have_human_labels(self):
        expected = {"AbdomenCT", "BreastMRI", "CXR", "ChestCT", "Hand", "HeadCT"}
        self.assertEqual(set(worker.SCAN_LABELS), expected)
        self.assertEqual(worker.SCAN_LABELS["Hand"], "Hand X-ray")
        self.assertEqual(worker.SCAN_LABELS["HeadCT"], "Head CT scan")
        self.assertEqual(worker.SCAN_LABELS["AbdomenCT"], "Abdominal CT scan")


if __name__ == "__main__":
    unittest.main()
