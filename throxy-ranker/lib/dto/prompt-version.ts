export interface PromptVersion {
  id: string;
  version: string;
  prompt_text: string;
  is_active: boolean;
  source: "manual" | "apo" | "initial";
  mae: number | null;
  dq_accuracy: number | null;
  /** APO: count of rank inversions on test set */
  test_inversions: number | null;
  /** APO: count of false positives (should-DQ-but-didn't) on test set */
  test_false_positives: number | null;
  iteration: number | null;
  created_at: string;
}
