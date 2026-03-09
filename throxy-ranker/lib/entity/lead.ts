export interface Lead {
  id: string;
  account_id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  created_at: string;
}
