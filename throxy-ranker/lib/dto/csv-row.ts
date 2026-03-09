export interface CsvRow {
  account_name: string;
  lead_first_name: string;
  lead_last_name: string;
  lead_job_title: string;
  account_domain: string;
  account_employee_range: string;
  account_industry: string;
  [key: string]: string | undefined;
}
