import { Account } from "../entity/account";
import { Lead } from "../entity/lead";

export interface AccountBatch {
  account: Account;
  leads: Lead[];
}
