-- APO metrics: test set generalization scores for prompt_versions
ALTER TABLE prompt_versions
  ADD COLUMN IF NOT EXISTS test_inversions INT,
  ADD COLUMN IF NOT EXISTS test_false_positives INT;
